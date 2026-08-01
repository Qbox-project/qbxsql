import type { DatabaseConnection } from '../core/types.js';
import type { DatabaseService } from '../core/database.js';
import { introspectDatabase } from './introspect.js';
import { capabilitiesForVersion, compareColumn, planSchema } from './planner.js';
import {
  migrationOperationSql,
  onlineMigrationOperationSql,
  quoteIdentifier,
} from './sql.js';
import type {
  ActualTable,
  MigrationDefinition,
  MigrationOperation,
  ResourceSchema,
  SchemaAction,
  SchemaAdoptionResult,
  SchemaCapabilities,
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

interface AdoptionRow {
  baselineVersion: number;
  targetVersion: number;
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

export class SchemaAdoptionRequiredError extends Error {
  public constructor(resource: string, tables: string[]) {
    super(
      `Schema '${resource}' includes unmanaged existing tables (${tables.join(', ')}). Use QBXSQL.Schema.planAdoption/adopt with an explicit baseline.`,
    );
    this.name = 'SchemaAdoptionRequiredError';
  }
}

export class SchemaAdoptionConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SchemaAdoptionConflictError';
  }
}

export interface SchemaManagerOptions {
  mode?: 'auto' | 'plan' | 'off';
  allowBlocking?: boolean;
  applicationDatabase?: DatabaseService;
}

function validateResourceName(resource: string): void {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(resource)) {
    throw new Error(`Invalid resource name '${resource}'.`);
  }
}

function operationAlgorithm(operation: MigrationOperation): SchemaAction['algorithm'] {
  switch (operation.type) {
    case 'addColumn':
      return 'INSTANT';
    case 'renameColumn':
    case 'alterColumn':
    case 'addIndex':
    case 'dropIndex':
    case 'addForeignKey':
    case 'dropForeignKey':
    case 'setPrimaryKey':
    // DROP COLUMN is an INPLACE rebuild; it is only instant on MySQL 8.0.29+.
    case 'dropColumn':
      return 'INPLACE';
    // InnoDB has no online path for dropping a primary key on its own.
    case 'dropPrimaryKey':
      return 'MANUAL';
    default:
      return 'MANUAL';
  }
}

/**
 * Operations the server operator must sign off on with
 * qbxsql_schema_allow_blocking. allowDataLoss is set by the schema author, not
 * the operator, so destructive column and key changes belong here too --
 * otherwise a resource could drop a column on the next server start with no
 * human in the loop.
 */
function requiresBlockingAuthorization(operation: MigrationOperation): boolean {
  return (
    operation.type === 'renameTable' ||
    operation.type === 'dropTable' ||
    operation.type === 'sql' ||
    operation.type === 'setTableOptions' ||
    operation.type === 'dropColumn' ||
    operation.type === 'dropPrimaryKey' ||
    operation.type === 'setPrimaryKey'
  );
}

function enforcedAlgorithm(action: SchemaAction): string {
  return action.algorithm === 'INSTANT'
    ? 'INSTANT'
    : action.algorithm === 'INPLACE'
      ? 'INPLACE/LOCK=NONE'
      : action.algorithm;
}

/**
 * Renders setPrimaryKey, whose statement depends on whether the table already
 * has a primary key. Returns null for every other operation so callers fall
 * back to the ordinary rendering. Shared by the planner and the executor so the
 * two cannot disagree about what will run.
 */
function primaryKeyMigrationSql(
  operation: MigrationOperation,
  blockingAllowed: boolean,
  capabilities?: SchemaCapabilities,
  actual?: Map<string, ActualTable>,
): string | null {
  if (operation.type !== 'setPrimaryKey' || !actual) return null;
  const hasPrimaryKey = actual.get(operation.table)?.indexes.has('PRIMARY') === true;
  const clauses = [
    ...(hasPrimaryKey ? ['DROP PRIMARY KEY'] : []),
    `ADD PRIMARY KEY (${operation.columns.map(quoteIdentifier).join(', ')})`,
  ];
  const sql = `ALTER TABLE ${quoteIdentifier(operation.table)} ${clauses.join(', ')}`;
  if (blockingAllowed) return sql;
  return (capabilities?.inplaceAlterColumn ?? true)
    ? `${sql}, ALGORITHM=INPLACE, LOCK=NONE`
    : sql;
}

/**
 * `actual` lets setPrimaryKey render the statement that will really run: when
 * the table has no primary key, applying it omits the DROP PRIMARY KEY clause,
 * and a plan that showed the clause would have the operator approve SQL that is
 * never executed.
 */
export function migrationActions(
  migrations: MigrationDefinition[],
  operatorAllowsBlocking: boolean,
  capabilities?: SchemaCapabilities,
  actual?: Map<string, ActualTable>,
): SchemaAction[] {
  return migrations.flatMap((migration) =>
    migration.operations.map((operation) => {
      const blockingAllowed = migration.allowBlocking === true && operatorAllowsBlocking;
      const requiresBlocking = requiresBlockingAuthorization(operation);
      const algorithm = blockingAllowed ? 'MANUAL' : operationAlgorithm(operation);
      return {
        kind: `migration:${operation.type}`,
        sql: primaryKeyMigrationSql(operation, blockingAllowed, capabilities, actual)
          ?? (blockingAllowed
            ? migrationOperationSql(operation)
            : onlineMigrationOperationSql(operation, capabilities)),
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
  private readonly applicationDatabase: DatabaseService;
  private targetVerification: Promise<void> | null = null;

  public constructor(
    private readonly database: DatabaseService,
    options: SchemaManagerOptions = {},
  ) {
    this.mode = options.mode ?? 'auto';
    this.allowBlocking = options.allowBlocking ?? false;
    this.applicationDatabase = options.applicationDatabase ?? database;
  }

  public initialize(): Promise<void> {
    this.initialization ??= this.verifySchemaTarget()
      .then(() => this.createMetadataTables())
      .catch((error: unknown) => {
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
    if (!preflightRegistry) {
      const preflightTables = this.relevantOwnershipTables(schema, schema.migrations ?? []);
      await this.refuseImplicitAdoption(
        resource,
        preflightTables,
        await introspectDatabase(this.database, preflightTables),
      );
    }
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
      const introspectionTables = this.introspectionTables(
        schema,
        pendingMigrations,
        registry,
      );
      await this.assertOwnership(resource, relevantTables);

      let actual = await introspectDatabase(this.database, introspectionTables);
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
        await this.applyMigration(
          resource,
          migration,
          existing,
          actual,
          introspectionTables,
        );
        appliedMigrations.push(migration.version);
        actual = await introspectDatabase(this.database, introspectionTables);
      }

      plan = planSchema(resource, schema, actual, capabilities);
      const blocked = plan.actions.filter((entry) => !entry.automatic);
      if (blocked.length > 0) throw new SchemaMigrationRequiredError(plan);

      const appliedActions = await this.applySchemaPlan(resource, plan);

      const remaining = planSchema(
        resource,
        schema,
        await introspectDatabase(this.database, introspectionTables),
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
      await this.releaseLock(lock);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  public async plan(resource: string, input: ResourceSchema): Promise<SchemaEnsureResult> {
    validateResourceName(resource);
    const schema = validateSchema(input);
    await this.verifySchemaTarget();
    const checksum = schemaChecksum(schema);
    const metadataReady = await this.metadataTablesExist();
    let registry: RegistryRow | null = null;
    let pendingMigrations: MigrationDefinition[] = [];
    if (metadataReady) {
      registry = await this.readRegistry(resource);
      if (registry) {
        const registryVersion = registry.version;
        pendingMigrations = (schema.migrations ?? [])
          .filter(
            (migration) =>
              migration.version > registryVersion && migration.version <= schema.version,
          )
          .sort((left, right) => left.version - right.version);
      }
    }
    const actual = await introspectDatabase(
      this.database,
      this.introspectionTables(schema, pendingMigrations, registry),
    );
    const capabilities = capabilitiesForVersion(this.database.driver.serverVersion);
    const basePlan = planSchema(resource, schema, actual, capabilities);
    const plan = {
      ...basePlan,
      actions: [
        ...migrationActions(pendingMigrations, this.allowBlocking, capabilities, actual),
        ...basePlan.actions,
      ],
    };
    return {
      ...plan,
      // Drift is diffed against the database as it stands now, not against the
      // state the pending migrations will leave behind, so one change can be
      // described twice: a renameColumn migration and, separately, drift that
      // wants to add the new name and reports the old one as unmanaged. ensure()
      // does not have this overlap because it applies migrations first and then
      // re-plans.
      warnings: pendingMigrations.length > 0
        ? [
            ...plan.warnings,
            `${pendingMigrations.length} pending migration(s) have not run yet; drift actions below were computed against the current database and may restate or overlap what those migrations will do.`,
          ]
        : plan.warnings,
      checksum,
      dryRun: true,
      appliedActions: [],
      appliedMigrations: [],
    };
  }

  public async planAdoption(
    resource: string,
    input: ResourceSchema,
    baselineVersion: number,
  ): Promise<SchemaAdoptionResult> {
    validateResourceName(resource);
    const schema = validateSchema(input);
    await this.verifySchemaTarget();
    this.validateAdoptionBaseline(schema, baselineVersion);
    const checksum = schemaChecksum(schema);
    const migrations = (schema.migrations ?? [])
      .filter(
        (migration) => migration.version > baselineVersion && migration.version <= schema.version,
      )
      .sort((left, right) => left.version - right.version);
    if (await this.metadataTablesExist()) {
      const registry = await this.readRegistry(resource);
      if (registry) {
        throw new SchemaAdoptionConflictError(
          `Resource '${resource}' already has a managed schema at version ${registry.version}.`,
        );
      }
      await this.assertAdoptionOwnership(resource, this.relevantOwnershipTables(schema, migrations));
    }
    const scope = this.introspectionTables(schema, migrations, null);
    const actual = await introspectDatabase(this.database, scope);
    this.assertAdoptionHasLegacyTables(resource, schema, migrations, actual);
    const plan = planSchema(
      resource,
      schema,
      actual,
      capabilitiesForVersion(this.database.driver.serverVersion),
    );
    return {
      ...plan,
      actions: [...migrationActions(migrations, this.allowBlocking), ...plan.actions],
      checksum,
      dryRun: true,
      appliedActions: [],
      appliedMigrations: [],
      adoption: true,
      baselineVersion,
    };
  }

  public async adopt(
    resource: string,
    input: ResourceSchema,
    baselineVersion: number,
  ): Promise<SchemaAdoptionResult> {
    validateResourceName(resource);
    const schema = validateSchema(input);
    this.validateAdoptionBaseline(schema, baselineVersion);
    if (this.mode === 'off') throw new SchemaDisabledError(resource);
    if (this.mode === 'plan') {
      throw new SchemaPendingChangesError(
        await this.planAdoption(resource, schema, baselineVersion),
      );
    }
    const checksum = schemaChecksum(schema);
    await this.initialize();
    const lock = await this.database.driver.acquire();
    let adoptionRecorded = false;

    try {
      await this.acquireLock(lock);
      const registry = await this.readRegistry(resource);
      const adoption = await this.readAdoption(resource);
      if (registry) {
        throw new SchemaAdoptionConflictError(
          `Resource '${resource}' is already managed at version ${registry.version}.`,
        );
      }
      if (adoption) {
        if (
          adoption.baselineVersion !== baselineVersion ||
          adoption.targetVersion !== schema.version ||
          adoption.checksum !== checksum
        ) {
          throw new SchemaAdoptionConflictError(
            `A different adoption for '${resource}' is already ${adoption.status}.`,
          );
        }
        adoptionRecorded = true;
      }

      const migrations = (schema.migrations ?? [])
        .filter(
          (migration) => migration.version > baselineVersion && migration.version <= schema.version,
        )
        .sort((left, right) => left.version - right.version);
      this.assertBlockingPolicy(migrations);
      const relevantTables = this.relevantOwnershipTables(schema, migrations);
      const introspectionTables = this.introspectionTables(schema, migrations, null);
      let actual = await introspectDatabase(this.database, introspectionTables);

      if (!adoptionRecorded) {
        await this.assertAdoptionOwnership(resource, relevantTables);
        this.assertAdoptionHasLegacyTables(resource, schema, migrations, actual);
        await this.writeAdoptionBaseline(resource, schema, baselineVersion, checksum);
        adoptionRecorded = true;
      }

      const migrationRows = await this.readMigrationRows(resource);
      this.assertMigrationChecksums(schema.migrations ?? [], migrationRows);
      const appliedMigrations: number[] = [];
      for (const migration of migrations) {
        const existing = migrationRows.get(migration.version);
        if (existing?.status === 'success') continue;
        await this.applyMigration(
          resource,
          migration,
          existing,
          actual,
          introspectionTables,
        );
        appliedMigrations.push(migration.version);
        actual = await introspectDatabase(this.database, introspectionTables);
      }

      const capabilities = capabilitiesForVersion(this.database.driver.serverVersion);
      const plan = planSchema(resource, schema, actual, capabilities);
      if (plan.actions.some((entry) => !entry.automatic)) {
        throw new SchemaMigrationRequiredError(plan);
      }
      const appliedActions = await this.applySchemaPlan(resource, plan);
      const remaining = planSchema(
        resource,
        schema,
        await introspectDatabase(this.database, introspectionTables),
        capabilities,
      );
      if (remaining.actions.length > 0) {
        throw new Error(
          `Schema adoption for '${resource}' did not converge: ${remaining.actions.map((entry) => entry.reason).join('; ')}`,
        );
      }

      await this.claimTables(resource, Object.keys(schema.tables));
      await this.writeRegistry(resource, schema.version, checksum, Object.keys(schema.tables));
      await this.finishAdoption(resource);
      return {
        ...plan,
        warnings: [...plan.warnings, ...remaining.warnings],
        checksum,
        dryRun: false,
        appliedActions,
        appliedMigrations,
        adoption: true,
        baselineVersion,
      };
    } catch (error) {
      if (adoptionRecorded) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await this.failAdoption(resource, error).catch(() => {});
      }
      throw error;
    } finally {
      await this.releaseLock(lock);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
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
      `CREATE TABLE IF NOT EXISTS qbxsql_schema_adoptions (
        resource_name VARCHAR(100) NOT NULL PRIMARY KEY,
        baseline_version INT UNSIGNED NOT NULL,
        target_version INT UNSIGNED NOT NULL,
        checksum CHAR(64) NOT NULL,
        tables_json LONGTEXT NOT NULL,
        status VARCHAR(16) NOT NULL,
        error TEXT NULL,
        started_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        completed_at TIMESTAMP(6) NULL
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

  private verifySchemaTarget(): Promise<void> {
    if (this.database === this.applicationDatabase) return Promise.resolve();
    this.targetVerification ??= this.compareSchemaTargets().catch((error: unknown) => {
      this.targetVerification = null;
      throw error;
    });
    return this.targetVerification;
  }

  private async compareSchemaTargets(): Promise<void> {
    await Promise.all([this.applicationDatabase.connect(), this.database.connect()]);
    const identitySql = `SELECT DATABASE() AS databaseName, @@hostname AS hostname,
                                @@port AS port, @@server_id AS serverId, VERSION() AS version`;
    const [application, schema] = (await Promise.all([
      this.applicationDatabase.single(identitySql, [], { invokingResource: 'qbxsql:schema' }),
      this.database.single(identitySql, [], { invokingResource: 'qbxsql:schema' }),
    ])) as [Row | null, Row | null];
    if (!application || !schema) throw new Error('Unable to verify the schema database target.');
    const fields = ['databaseName', 'hostname', 'port', 'serverId', 'version'] as const;
    const mismatch = fields.find((field) => String(application[field]) !== String(schema[field]));
    if (mismatch) {
      throw new Error(
        `qbxsql_schema_connection_string points to a different server or database (${mismatch} mismatch).`,
      );
    }
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

  /**
   * GET_LOCK is session scoped, so the lock has to be dropped explicitly before
   * the connection can go back to the pool. Destroying the connection also
   * drops it, but throws away a pooled connection on every ensure and adopt.
   */
  private async releaseLock(connection: DatabaseConnection): Promise<void> {
    try {
      await connection.query(`SELECT RELEASE_LOCK('qbxsql:schema')`);
      connection.release();
    } catch {
      // If the lock cannot be confirmed released, do not return the connection.
      connection.destroy();
    }
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

  private async readAdoption(resource: string): Promise<AdoptionRow | null> {
    const row = (await this.database.single(
      `SELECT baseline_version AS baselineVersion, target_version AS targetVersion,
              checksum, status
       FROM qbxsql_schema_adoptions WHERE resource_name = ?`,
      [resource],
      { invokingResource: 'qbxsql:schema' },
    )) as Row | null;
    if (!row) return null;
    return {
      baselineVersion: Number(row.baselineVersion),
      targetVersion: Number(row.targetVersion),
      checksum: String(row.checksum),
      status: String(row.status),
    };
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
    const desired = [...new Set(tableNames)];
    if (desired.length === 0) return;
    const rows = (await this.database.query(
      `SELECT table_name AS tableName, resource_name AS resourceName
         FROM qbxsql_schema_tables
        WHERE table_name IN (${desired.map(() => '?').join(', ')})`,
      desired,
      { invokingResource: 'qbxsql:schema' },
    )) as Row[];
    for (const row of rows) {
      if (String(row.resourceName) !== resource) {
        throw new Error(
          `Table '${String(row.tableName)}' is owned by resource '${String(row.resourceName)}', not '${resource}'.`,
        );
      }
    }
  }

  private async applyMigration(
    resource: string,
    migration: MigrationDefinition,
    existing: MigrationRow | undefined,
    actual: Map<string, ActualTable>,
    introspectionTables: string[],
  ): Promise<void> {
    const checksum = stableChecksum(migration);
    const blockingAllowed = migration.allowBlocking === true && this.allowBlocking;
    const blockedOperation = migration.operations.find(requiresBlockingAuthorization);
    if (blockedOperation && !blockingAllowed) {
      throw new Error(
        `Migration ${migration.version} operation '${blockedOperation.type}' requires both migration allowBlocking=true and qbxsql_schema_allow_blocking=true.`,
      );
    }
    // A row still at 'running' means a crash or disconnect interrupted the
    // previous attempt before it recorded success or failure. Raw SQL cannot
    // be resumed from either state: qbxsql cannot tell how much of it applied,
    // and blindly re-running a backfill would double-apply it.
    if (
      existing &&
      existing.status !== 'success' &&
      migration.operations.some((operation) => operation.type === 'sql')
    ) {
      const history = existing.status === 'failed'
        ? 'previously failed'
        : `did not record completion (status '${existing.status}')`;
      throw new Error(
        `Migration ${migration.version} contains raw SQL and ${history}; qbxsql cannot tell how much of it applied. Inspect the database, then either clear the row from qbxsql_schema_migrations to retry it or supersede it with a new migration version.`,
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
      for (const [operationIndex, operation] of migration.operations.entries()) {
        const needed = await this.operationNeeded(resource, operation, actual);
        if (needed) {
          if (operation.type === 'releaseTable') {
            await this.releaseTable(resource, operation.table);
          } else {
            const sql = this.migrationSql(operation, blockingAllowed, actual);
            try {
              await this.database.query(sql, [], { invokingResource: resource });
            } catch (error) {
              if (!blockingAllowed && operationAlgorithm(operation) !== 'MANUAL') {
                const reason = error instanceof Error ? error.message : String(error);
                const action = migrationActions([migration], false)[operationIndex]!;
                throw new SchemaMigrationRequiredError({
                  resource,
                  version: migration.version,
                  warnings: [],
                  actions: [
                    {
                      ...action,
                      sql,
                      onlineSafe: false,
                      automatic: false,
                      risk: 'high',
                      reason: `${action.reason}; database rejected ${enforcedAlgorithm(action)}: ${reason}`,
                    },
                  ],
                });
              }
              throw error;
            }
          }
        }
        await this.reconcileOwnershipTransition(resource, operation);
        if (needed && operation.type !== 'releaseTable') {
          actual = await introspectDatabase(this.database, introspectionTables);
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
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        await this.database.update(
          `UPDATE qbxsql_schema_migrations SET status = 'failed', error = ?
           WHERE resource_name = ? AND version = ?`,
          [message.slice(0, 65_535), resource, migration.version],
          { invokingResource: resource },
        );
      } catch (statusError) {
        // The migration failure is the error worth surfacing; a failed status
        // write (usually the same outage) must not replace it. The row stays
        // 'running', which the raw-SQL guard above treats as unresumable.
        console.error(
          `[qbxsql] could not record failed status for migration ${migration.version} [${resource}]`,
          statusError,
        );
      }
      throw error;
    }
  }

  private async applySchemaPlan(resource: string, plan: SchemaPlan): Promise<string[]> {
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
                  reason: `${entry.reason}; database rejected ${enforcedAlgorithm(entry)}: ${reason}`,
                }
              : entry,
          ),
        });
      }
      appliedActions.push(schemaAction.sql);
    }
    return appliedActions;
  }

  private migrationSql(
    operation: MigrationOperation,
    blockingAllowed: boolean,
    actual: Map<string, ActualTable>,
  ): string {
    const capabilities = capabilitiesForVersion(this.database.driver.serverVersion);
    return (
      primaryKeyMigrationSql(operation, blockingAllowed, capabilities, actual) ??
      (blockingAllowed
        ? migrationOperationSql(operation)
        : onlineMigrationOperationSql(operation, capabilities))
    );
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

  /**
   * Never reassigns a table that another resource already owns. assertOwnership
   * runs earlier under the same lock, so this is defence in depth rather than
   * the primary check -- but an unconditional overwrite would silently transfer
   * ownership if that check were ever bypassed. Matches the PostgreSQL lane.
   */
  private async claimTables(resource: string, tableNames: string[]): Promise<void> {
    for (const tableName of tableNames) {
      await this.database.update(
        `INSERT INTO qbxsql_schema_tables (table_name, resource_name)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE resource_name = IF(
           resource_name = VALUES(resource_name),
           VALUES(resource_name),
           resource_name
         )`,
        [tableName, resource],
        { invokingResource: 'qbxsql:schema' },
      );
      const owner = await this.database.scalar(
        `SELECT resource_name FROM qbxsql_schema_tables WHERE table_name = ?`,
        [tableName],
        { invokingResource: 'qbxsql:schema' },
      );
      if (String(owner) !== resource) {
        throw new Error(
          `Table '${tableName}' is owned by resource '${String(owner)}', not '${resource}'.`,
        );
      }
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

  private validateAdoptionBaseline(schema: ResourceSchema, baselineVersion: number): void {
    if (
      !Number.isInteger(baselineVersion) ||
      baselineVersion < 0 ||
      baselineVersion >= schema.version
    ) {
      throw new Error(
        `Adoption baseline must be an integer from 0 through ${schema.version - 1}.`,
      );
    }
  }

  private async refuseImplicitAdoption(
    resource: string,
    tableNames: string[],
    actual: Map<string, ActualTable>,
  ): Promise<void> {
    const existing = tableNames.filter((table) => actual.has(table));
    if (existing.length === 0) return;
    const ownership = await this.readOwnership(existing);
    const unmanaged = existing.filter((table) => !ownership.has(table));
    if (unmanaged.length > 0) throw new SchemaAdoptionRequiredError(resource, unmanaged);
  }

  private async assertAdoptionOwnership(resource: string, tableNames: string[]): Promise<void> {
    const ownership = await this.readOwnership(tableNames);
    if (ownership.size === 0) return;
    const conflicts = [...ownership].map(([table, owner]) => `${table} (${owner})`).join(', ');
    throw new SchemaAdoptionConflictError(
      `Cannot adopt '${resource}' because tables are already owned: ${conflicts}.`,
    );
  }

  private assertAdoptionHasLegacyTables(
    resource: string,
    schema: ResourceSchema,
    migrations: MigrationDefinition[],
    actual: Map<string, ActualTable>,
  ): void {
    const relevant = this.relevantOwnershipTables(schema, migrations);
    if (!relevant.some((table) => actual.has(table))) {
      throw new SchemaAdoptionConflictError(
        `Cannot adopt '${resource}' because none of its declared or migration-source tables exist. Use ensure for a fresh schema.`,
      );
    }
  }

  private async readOwnership(tableNames: string[]): Promise<Map<string, string>> {
    if (tableNames.length === 0) return new Map();
    const rows = (await this.database.query(
      `SELECT table_name AS tableName, resource_name AS resourceName
       FROM qbxsql_schema_tables`,
      [],
      { invokingResource: 'qbxsql:schema' },
    )) as Row[];
    const relevant = new Set(tableNames);
    return new Map(
      rows
        .filter((row) => relevant.has(String(row.tableName)))
        .map((row) => [String(row.tableName), String(row.resourceName)]),
    );
  }

  private async writeAdoptionBaseline(
    resource: string,
    schema: ResourceSchema,
    baselineVersion: number,
    checksum: string,
  ): Promise<void> {
    await this.database.update(
      `INSERT INTO qbxsql_schema_adoptions
        (resource_name, baseline_version, target_version, checksum, tables_json, status, error)
       VALUES (?, ?, ?, ?, ?, 'running', NULL)`,
      [resource, baselineVersion, schema.version, checksum, JSON.stringify(Object.keys(schema.tables))],
      { invokingResource: 'qbxsql:schema' },
    );
  }

  private async finishAdoption(resource: string): Promise<void> {
    await this.database.update(
      `UPDATE qbxsql_schema_adoptions
       SET status = 'success', error = NULL, completed_at = CURRENT_TIMESTAMP(6)
       WHERE resource_name = ?`,
      [resource],
      { invokingResource: 'qbxsql:schema' },
    );
  }

  private async failAdoption(resource: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.database.update(
      `UPDATE qbxsql_schema_adoptions SET status = 'failed', error = ?
       WHERE resource_name = ?`,
      [message.slice(0, 65_535), resource],
      { invokingResource: 'qbxsql:schema' },
    );
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

  private introspectionTables(
    schema: ResourceSchema,
    migrations: MigrationDefinition[],
    registry: RegistryRow | null,
  ): string[] {
    const tables = new Set(this.relevantOwnershipTables(schema, migrations));
    if (registry) {
      try {
        const owned = JSON.parse(registry.tablesJson) as unknown;
        if (Array.isArray(owned)) {
          for (const table of owned) if (typeof table === 'string') tables.add(table);
        }
      } catch {
        // The ownership transition validator reports malformed registry data with context.
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
