import type { DatabaseConnection } from '../core/types.js';
import type { DatabaseService } from '../core/database.js';
import { introspectDatabase } from './introspect.js';
import { capabilitiesForVersion, compareColumn, planSchema } from './planner.js';
import { migrationOperationSql, onlineMigrationOperationSql } from './sql.js';
import type {
  ActualTable,
  MigrationDefinition,
  MigrationOperation,
  ResourceSchema,
  SchemaAction,
  SchemaEnsureResult,
  SchemaPlan,
} from './types.js';
import { schemaChecksum, stableChecksum, validateSchema } from './validate.js';

interface RegistryRow {
  resourceName: string;
  version: number;
  checksum: string;
  tablesJson: string;
}

interface MigrationRow {
  version: number;
  checksum: string;
  status: string;
}

type Row = Record<string, unknown>;

export class SchemaMigrationRequiredError extends Error {
  public constructor(public readonly plan: SchemaPlan) {
    const blocked = plan.actions.filter((entry) => !entry.automatic).map((entry) => entry.reason);
    super(`Schema for '${plan.resource}' requires explicit migrations: ${blocked.join('; ')}`);
    this.name = 'SchemaMigrationRequiredError';
  }
}

export class SchemaPendingChangesError extends Error {
  public constructor(public readonly result: SchemaEnsureResult) {
    super(`Schema mode is 'plan'; '${result.resource}' was not changed.`);
    this.name = 'SchemaPendingChangesError';
  }
}

export class SchemaDisabledError extends Error {
  public constructor(resource: string) {
    super(`Schema management is disabled; cannot ensure '${resource}'. Use the planning API to inspect drift.`);
    this.name = 'SchemaDisabledError';
  }
}

export interface SchemaManagerOptions {
  mode?: 'auto' | 'plan' | 'off';
  allowBlocking?: boolean;
}

function validateResourceName(resource: string): void {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(resource)) {
    throw new Error(`Invalid resource name '${resource}'.`);
  }
}

function operationAlgorithm(operation: MigrationOperation): SchemaAction['algorithm'] {
  switch (operation.type) {
    case 'addColumn':
    case 'dropColumn':
      return 'INSTANT';
    case 'renameColumn':
    case 'alterColumn':
    case 'addIndex':
    case 'dropIndex':
    case 'addForeignKey':
    case 'dropForeignKey':
    case 'setPrimaryKey':
    case 'dropPrimaryKey':
      return 'INPLACE';
    default:
      return 'MANUAL';
  }
}

function requiresBlockingAuthorization(operation: MigrationOperation): boolean {
  return operation.type === 'sql' || operation.type === 'setTableOptions';
}

export function migrationActions(
  migrations: MigrationDefinition[],
  operatorAllowsBlocking: boolean,
): SchemaAction[] {
  return migrations.flatMap((migration) =>
    migration.operations.map((operation) => {
      const blockingAllowed = migration.allowBlocking === true && operatorAllowsBlocking;
      const requiresBlocking = requiresBlockingAuthorization(operation);
      const algorithm = blockingAllowed ? 'MANUAL' : operationAlgorithm(operation);
      return {
        kind: `migration:${operation.type}`,
        sql: blockingAllowed
          ? migrationOperationSql(operation)
          : onlineMigrationOperationSql(operation),
        safe: !('allowDataLoss' in operation && operation.allowDataLoss === true),
        dataSafe: !('allowDataLoss' in operation && operation.allowDataLoss === true),
        onlineSafe: !blockingAllowed && !requiresBlocking,
        automatic: !requiresBlocking || blockingAllowed,
        risk: requiresBlocking || 'allowDataLoss' in operation ? ('high' as const) : ('medium' as const),
        algorithm,
        reason:
          requiresBlocking && !blockingAllowed
            ? `migration ${migration.version} (${migration.name}) requires both allowBlocking=true and qbxsql_schema_allow_blocking=true`
            : `migration ${migration.version} (${migration.name})`,
        ...('table' in operation && typeof operation.table === 'string'
          ? { table: operation.table }
          : {}),
      };
    }),
  );
}

export class SchemaManager {
  private initialization: Promise<void> | null = null;

  private readonly mode: 'auto' | 'plan' | 'off';
  private readonly allowBlocking: boolean;

  public constructor(
    private readonly database: DatabaseService,
    options: SchemaManagerOptions = {},
  ) {
    this.mode = options.mode ?? 'auto';
    this.allowBlocking = options.allowBlocking ?? false;
  }

  public initialize(): Promise<void> {
    this.initialization ??= this.createMetadataTables().catch((error: unknown) => {
      this.initialization = null;
      throw error;
    });
    return this.initialization;
  }

  public async ensure(
    resource: string,
    input: ResourceSchema,
    dryRun = false,
  ): Promise<SchemaEnsureResult> {
    validateResourceName(resource);
    const schema = validateSchema(input);
    const checksum = schemaChecksum(schema);

    if (dryRun) return this.plan(resource, schema);
    if (this.mode === 'off') throw new SchemaDisabledError(resource);
    if (this.mode === 'plan') throw new SchemaPendingChangesError(await this.plan(resource, schema));

    await this.initialize();

    const preflightRegistry = await this.readRegistry(resource);
    const preflightMigrations = preflightRegistry
      ? (schema.migrations ?? [])
          .filter(
            (migration) =>
              migration.version > preflightRegistry.version && migration.version <= schema.version,
          )
          .sort((left, right) => left.version - right.version)
      : [];
    this.assertOwnershipTransitions(preflightRegistry, schema, preflightMigrations);
    this.assertBlockingPolicy(preflightMigrations);

    const lock = await this.database.driver.acquire();
    try {
      await this.acquireLock(lock);
      const registry = await this.readRegistry(resource);
      if (registry && registry.version > schema.version) {
        throw new Error(
          `Refusing to downgrade '${resource}' from schema version ${registry.version} to ${schema.version}.`,
        );
      }

      const migrationRows = await this.readMigrationRows(resource);
      this.assertMigrationChecksums(schema.migrations ?? [], migrationRows);
      const pendingMigrations = registry
        ? (schema.migrations ?? [])
            .filter((migration) => migration.version > registry.version && migration.version <= schema.version)
            .sort((left, right) => left.version - right.version)
        : [];
      const relevantTables = this.relevantOwnershipTables(schema, pendingMigrations);
      await this.assertOwnership(resource, relevantTables);

      let actual = await introspectDatabase(this.database);
      const capabilities = capabilitiesForVersion(this.database.driver.serverVersion);
      let plan = planSchema(resource, schema, actual, capabilities);
      const managerWarnings: string[] = [];
      if (registry && registry.version === schema.version && registry.checksum !== checksum) {
        managerWarnings.push(
          `Schema checksum changed without a version bump for '${resource}'; only safe changes will be reconciled.`,
        );
      }

      const appliedMigrations: number[] = [];
      for (const migration of pendingMigrations) {
        const existing = migrationRows.get(migration.version);
        if (existing?.status === 'success') continue;
        await this.applyMigration(resource, migration, existing, actual);
        appliedMigrations.push(migration.version);
        actual = await introspectDatabase(this.database);
      }

      plan = planSchema(resource, schema, actual, capabilities);
      const blocked = plan.actions.filter((entry) => !entry.automatic);
      if (blocked.length > 0) throw new SchemaMigrationRequiredError(plan);

      const appliedActions: string[] = [];
      for (const schemaAction of plan.actions) {
        try {
          await this.database.query(schemaAction.sql, [], { invokingResource: resource });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new SchemaMigrationRequiredError({
            ...plan,
            actions: plan.actions.map((entry) =>
              entry === schemaAction
                ? {
                    ...entry,
                    onlineSafe: false,
                    automatic: false,
                    risk: 'high',
                    reason: `${entry.reason}; database rejected ${entry.algorithm}/LOCK=NONE: ${reason}`,
                  }
                : entry,
            ),
          });
        }
        appliedActions.push(schemaAction.sql);
      }

      const remaining = planSchema(
        resource,
        schema,
        await introspectDatabase(this.database),
        capabilities,
      );
      if (remaining.actions.length > 0) {
        throw new Error(
          `Schema reconciliation for '${resource}' did not converge: ${remaining.actions.map((entry) => entry.reason).join('; ')}`,
        );
      }

      await this.claimTables(resource, Object.keys(schema.tables));
      await this.writeRegistry(resource, schema.version, checksum, Object.keys(schema.tables));

      return {
        ...plan,
        warnings: [...managerWarnings, ...plan.warnings, ...remaining.warnings],
        checksum,
        dryRun: false,
        appliedActions,
        appliedMigrations,
      };
    } finally {
      lock.destroy();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  public async plan(resource: string, input: ResourceSchema): Promise<SchemaEnsureResult> {
    validateResourceName(resource);
    const schema = validateSchema(input);
    const checksum = schemaChecksum(schema);
    const actual = await introspectDatabase(this.database);
    let plan = planSchema(
      resource,
      schema,
      actual,
      capabilitiesForVersion(this.database.driver.serverVersion),
    );
    const metadataReady = await this.metadataTablesExist();
    if (metadataReady) {
      const registry = await this.readRegistry(resource);
      const pendingMigrations = registry
        ? (schema.migrations ?? [])
            .filter((migration) => migration.version > registry.version && migration.version <= schema.version)
            .sort((left, right) => left.version - right.version)
        : [];
      plan = {
        ...plan,
        actions: [...migrationActions(pendingMigrations, this.allowBlocking), ...plan.actions],
      };
    }
    return {
      ...plan,
      checksum,
      dryRun: true,
      appliedActions: [],
      appliedMigrations: [],
    };
  }

  private async createMetadataTables(): Promise<void> {
    await this.database.connect();
    await this.database.query(
      `CREATE TABLE IF NOT EXISTS qbxsql_schema_registry (
        resource_name VARCHAR(100) NOT NULL PRIMARY KEY,
        version INT UNSIGNED NOT NULL,
        checksum CHAR(64) NOT NULL,
        tables_json LONGTEXT NOT NULL,
        updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      [],
      { invokingResource: 'qbxsql:schema' },
    );
    await this.database.query(
      `CREATE TABLE IF NOT EXISTS qbxsql_schema_migrations (
        resource_name VARCHAR(100) NOT NULL,
        version INT UNSIGNED NOT NULL,
        name VARCHAR(190) NOT NULL,
        checksum CHAR(64) NOT NULL,
        status VARCHAR(16) NOT NULL,
        error TEXT NULL,
        started_at TIMESTAMP(6) NULL,
        applied_at TIMESTAMP(6) NULL,
        PRIMARY KEY (resource_name, version)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      [],
      { invokingResource: 'qbxsql:schema' },
    );
    await this.database.query(
      `CREATE TABLE IF NOT EXISTS qbxsql_schema_tables (
        table_name VARCHAR(64) NOT NULL PRIMARY KEY,
        resource_name VARCHAR(100) NOT NULL,
        claimed_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        KEY qbxsql_schema_tables_resource_idx (resource_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      [],
      { invokingResource: 'qbxsql:schema' },
    );
  }

  private async metadataTablesExist(): Promise<boolean> {
    await this.database.connect();
    const schemaName = this.database.driver.databaseName;
    if (!schemaName) return false;
    return (
      Number(
        await this.database.scalar(
          `SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'qbxsql_schema_registry'`,
          [schemaName],
          { invokingResource: 'qbxsql:schema' },
        ),
      ) === 1
    );
  }

  private async acquireLock(connection: DatabaseConnection): Promise<void> {
    const result = await connection.query(`SELECT GET_LOCK('qbxsql:schema', 30) AS acquired`);
    const rows = result.rows as Row[];
    if (Number(rows[0]?.acquired) !== 1) throw new Error('Timed out waiting for the qbxsql schema lock.');
  }

  private async readRegistry(resource: string): Promise<RegistryRow | null> {
    const row = (await this.database.single(
      `SELECT resource_name AS resourceName, version, checksum, tables_json AS tablesJson
       FROM qbxsql_schema_registry WHERE resource_name = ?`,
      [resource],
      { invokingResource: 'qbxsql:schema' },
    )) as Row | null;
    if (!row) return null;
    return {
      resourceName: String(row.resourceName),
      version: Number(row.version),
      checksum: String(row.checksum),
      tablesJson: String(row.tablesJson),
    };
  }

  private async readMigrationRows(resource: string): Promise<Map<number, MigrationRow>> {
    const rows = (await this.database.query(
      `SELECT version, checksum, status FROM qbxsql_schema_migrations WHERE resource_name = ?`,
      [resource],
      { invokingResource: 'qbxsql:schema' },
    )) as Row[];
    return new Map(
      rows.map((row) => [
        Number(row.version),
        {
          version: Number(row.version),
          checksum: String(row.checksum),
          status: String(row.status),
        },
      ]),
    );
  }

  private assertMigrationChecksums(
    migrations: MigrationDefinition[],
    existing: Map<number, MigrationRow>,
  ): void {
    for (const migration of migrations) {
      const row = existing.get(migration.version);
      if (row && row.checksum !== stableChecksum(migration)) {
        throw new Error(
          `Migration ${migration.version} was changed after it ran; create a new migration instead.`,
        );
      }
    }
  }

  private async assertOwnership(resource: string, tableNames: string[]): Promise<void> {
    if (tableNames.length === 0) return;
    const rows = (await this.database.query(
      `SELECT table_name AS tableName, resource_name AS resourceName FROM qbxsql_schema_tables`,
      [],
      { invokingResource: 'qbxsql:schema' },
    )) as Row[];
    const desired = new Set(tableNames);
    for (const row of rows) {
      const tableName = String(row.tableName);
      if (desired.has(tableName) && String(row.resourceName) !== resource) {
        throw new Error(
          `Table '${tableName}' is owned by resource '${String(row.resourceName)}', not '${resource}'.`,
        );
      }
    }
  }

  private async applyMigration(
    resource: string,
    migration: MigrationDefinition,
    existing: MigrationRow | undefined,
    actual: Map<string, ActualTable>,
  ): Promise<void> {
    const checksum = stableChecksum(migration);
    const blockingAllowed = migration.allowBlocking === true && this.allowBlocking;
    const blockedOperation = migration.operations.find(requiresBlockingAuthorization);
    if (blockedOperation && !blockingAllowed) {
      throw new Error(
        `Migration ${migration.version} operation '${blockedOperation.type}' requires both migration allowBlocking=true and qbxsql_schema_allow_blocking=true.`,
      );
    }
    if (existing?.status === 'failed' && migration.operations.some((operation) => operation.type === 'sql')) {
      throw new Error(
        `Migration ${migration.version} contains raw SQL and previously failed; inspect it before retrying.`,
      );
    }

    await this.database.update(
      `INSERT INTO qbxsql_schema_migrations
        (resource_name, version, name, checksum, status, error, started_at, applied_at)
       VALUES (?, ?, ?, ?, 'running', NULL, CURRENT_TIMESTAMP(6), NULL)
       ON DUPLICATE KEY UPDATE name = VALUES(name), checksum = VALUES(checksum),
         status = 'running', error = NULL, started_at = CURRENT_TIMESTAMP(6), applied_at = NULL`,
      [resource, migration.version, migration.name, checksum],
      { invokingResource: resource },
    );

    try {
      for (const operation of migration.operations) {
        const needed = await this.operationNeeded(resource, operation, actual);
        if (needed) {
          if (operation.type === 'releaseTable') {
            await this.releaseTable(resource, operation.table);
          } else {
            const sql = blockingAllowed
              ? migrationOperationSql(operation)
              : onlineMigrationOperationSql(operation);
            await this.database.query(sql, [], { invokingResource: resource });
          }
        }
        await this.reconcileOwnershipTransition(resource, operation);
        if (needed && operation.type !== 'releaseTable') {
          actual = await introspectDatabase(this.database);
        }
      }
      await this.database.update(
        `UPDATE qbxsql_schema_migrations
         SET status = 'success', error = NULL, applied_at = CURRENT_TIMESTAMP(6)
         WHERE resource_name = ? AND version = ?`,
        [resource, migration.version],
        { invokingResource: resource },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.database.update(
        `UPDATE qbxsql_schema_migrations SET status = 'failed', error = ?
         WHERE resource_name = ? AND version = ?`,
        [message.slice(0, 65_535), resource, migration.version],
        { invokingResource: resource },
      );
      throw error;
    }
  }

  private async operationNeeded(
    resource: string,
    operation: MigrationOperation,
    actual: Map<string, ActualTable>,
  ): Promise<boolean> {
    switch (operation.type) {
      case 'renameTable': {
        const source = actual.has(operation.from);
        const target = actual.has(operation.to);
        if (!source && target) return false;
        if (!source) throw new Error(`Cannot rename missing table '${operation.from}'.`);
        if (target) throw new Error(`Cannot rename '${operation.from}' because '${operation.to}' exists.`);
        return true;
      }
      case 'renameColumn': {
        const table = actual.get(operation.table);
        if (!table) throw new Error(`Cannot rename a column on missing table '${operation.table}'.`);
        const source = table.columns.has(operation.from);
        const target = table.columns.has(operation.to);
        if (!source && target) return false;
        if (!source) throw new Error(`Cannot rename missing column '${operation.table}.${operation.from}'.`);
        if (target) throw new Error(`Target column '${operation.table}.${operation.to}' already exists.`);
        return true;
      }
      case 'dropTable':
        return actual.has(operation.table);
      case 'dropColumn':
        return actual.get(operation.table)?.columns.has(operation.column) ?? false;
      case 'addColumn': {
        const table = actual.get(operation.table);
        if (!table) throw new Error(`Cannot add a column to missing table '${operation.table}'.`);
        return !table.columns.has(operation.column);
      }
      case 'alterColumn': {
        const column = actual.get(operation.table)?.columns.get(operation.column);
        if (!column) throw new Error(`Cannot alter missing column '${operation.table}.${operation.column}'.`);
        const comparison = compareColumn(operation.column, operation.definition, column);
        if (!comparison.changed) return false;
        if (!comparison.safe && operation.allowDataLoss !== true) {
          throw new Error(
            `Alter of '${operation.table}.${operation.column}' may lose data; set allowDataLoss=true.`,
          );
        }
        return true;
      }
      case 'addIndex': {
        const table = actual.get(operation.table);
        if (!table) throw new Error(`Cannot add an index to missing table '${operation.table}'.`);
        return !table.indexes.has(operation.definition.name);
      }
      case 'dropIndex':
        return actual.get(operation.table)?.indexes.has(operation.index) ?? false;
      case 'addForeignKey': {
        const table = actual.get(operation.table);
        if (!table) throw new Error(`Cannot add a foreign key to missing table '${operation.table}'.`);
        return !table.foreignKeys.has(operation.definition.name);
      }
      case 'dropForeignKey':
        return actual.get(operation.table)?.foreignKeys.has(operation.foreignKey) ?? false;
      case 'setPrimaryKey': {
        const table = actual.get(operation.table);
        if (!table) throw new Error(`Cannot set a primary key on missing table '${operation.table}'.`);
        const existing = table.indexes.get('PRIMARY')?.columns ?? [];
        return (
          existing.length !== operation.columns.length ||
          existing.some((column, index) => column !== operation.columns[index])
        );
      }
      case 'dropPrimaryKey':
        return actual.get(operation.table)?.indexes.has('PRIMARY') ?? false;
      case 'setTableOptions': {
        const table = actual.get(operation.table);
        if (!table) throw new Error(`Cannot alter options on missing table '${operation.table}'.`);
        return (
          (operation.engine !== undefined && table.engine !== operation.engine) ||
          (operation.charset !== undefined && table.charset !== operation.charset) ||
          (operation.collation !== undefined && table.collation !== operation.collation)
        );
      }
      case 'releaseTable':
        return (
          Number(
            await this.database.scalar(
              `SELECT COUNT(*) FROM qbxsql_schema_tables
               WHERE table_name = ? AND resource_name = ?`,
              [operation.table, resource],
              { invokingResource: 'qbxsql:schema' },
            ),
          ) === 1
        );
      case 'sql':
        return true;
    }
  }

  private async claimTables(resource: string, tableNames: string[]): Promise<void> {
    for (const tableName of tableNames) {
      await this.database.update(
        `INSERT INTO qbxsql_schema_tables (table_name, resource_name)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE resource_name = VALUES(resource_name)`,
        [tableName, resource],
        { invokingResource: 'qbxsql:schema' },
      );
    }
  }

  private async releaseTable(resource: string, tableName: string): Promise<void> {
    const affected = await this.database.update(
      `DELETE FROM qbxsql_schema_tables WHERE table_name = ? AND resource_name = ?`,
      [tableName, resource],
      { invokingResource: 'qbxsql:schema' },
    );
    if (affected !== 1) {
      throw new Error(`Cannot release table '${tableName}' because it is not owned by '${resource}'.`);
    }
  }

  private relevantOwnershipTables(
    schema: ResourceSchema,
    migrations: MigrationDefinition[],
  ): string[] {
    const tables = new Set(Object.keys(schema.tables));
    for (const migration of migrations) {
      for (const operation of migration.operations) {
        if (operation.type === 'renameTable') {
          tables.add(operation.from);
          tables.add(operation.to);
        } else if ('table' in operation && typeof operation.table === 'string') {
          tables.add(operation.table);
        }
      }
    }
    return [...tables];
  }

  private assertOwnershipTransitions(
    registry: RegistryRow | null,
    schema: ResourceSchema,
    migrations: MigrationDefinition[],
  ): void {
    if (!registry) return;
    let previousTables: unknown;
    try {
      previousTables = JSON.parse(registry.tablesJson);
    } catch {
      throw new Error(`Stored table ownership for '${registry.resourceName}' is invalid JSON.`);
    }
    if (!Array.isArray(previousTables) || !previousTables.every((entry) => typeof entry === 'string')) {
      throw new Error(`Stored table ownership for '${registry.resourceName}' is invalid.`);
    }

    const desiredTables = new Set(Object.keys(schema.tables));
    const operations = migrations.flatMap((migration) => migration.operations);
    for (const table of previousTables) {
      if (desiredTables.has(table)) continue;
      const transition = operations.find(
        (operation) =>
          (operation.type === 'renameTable' &&
            operation.from === table &&
            desiredTables.has(operation.to)) ||
          ((operation.type === 'dropTable' || operation.type === 'releaseTable') &&
            operation.table === table),
      );
      if (!transition) {
        throw new Error(
          `Table '${table}' was removed from the declaration but is still managed by '${registry.resourceName}'. Add a renameTable, dropTable, or releaseTable migration; releaseTable requires allowOwnershipTransfer=true.`,
        );
      }
    }
  }

  private assertBlockingPolicy(migrations: MigrationDefinition[]): void {
    for (const migration of migrations) {
      const blockedOperation = migration.operations.find(requiresBlockingAuthorization);
      if (blockedOperation && !(migration.allowBlocking === true && this.allowBlocking)) {
        throw new Error(
          `Migration ${migration.version} operation '${blockedOperation.type}' requires both migration allowBlocking=true and qbxsql_schema_allow_blocking=true.`,
        );
      }
    }
  }

  private async reconcileOwnershipTransition(
    resource: string,
    operation: MigrationOperation,
  ): Promise<void> {
    if (operation.type === 'renameTable') {
      const affected = await this.database.update(
        `UPDATE qbxsql_schema_tables SET table_name = ?
         WHERE table_name = ? AND resource_name = ?`,
        [operation.to, operation.from, resource],
        { invokingResource: 'qbxsql:schema' },
      );
      if (affected === 0) {
        const owner = await this.database.scalar(
          `SELECT resource_name FROM qbxsql_schema_tables WHERE table_name = ?`,
          [operation.to],
          { invokingResource: 'qbxsql:schema' },
        );
        if (owner !== null && owner !== resource) {
          throw new Error(`Renamed table '${operation.to}' is owned by '${String(owner)}'.`);
        }
      }
    } else if (operation.type === 'dropTable') {
      await this.database.update(
        `DELETE FROM qbxsql_schema_tables WHERE table_name = ? AND resource_name = ?`,
        [operation.table, resource],
        { invokingResource: 'qbxsql:schema' },
      );
    }
  }

  private async writeRegistry(
    resource: string,
    version: number,
    checksum: string,
    tableNames: string[],
  ): Promise<void> {
    await this.database.update(
      `INSERT INTO qbxsql_schema_registry (resource_name, version, checksum, tables_json)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE version = VALUES(version), checksum = VALUES(checksum),
         tables_json = VALUES(tables_json), updated_at = CURRENT_TIMESTAMP(6)`,
      [resource, version, checksum, JSON.stringify(tableNames)],
      { invokingResource: 'qbxsql:schema' },
    );
  }
}
