import type { DatabaseConnection } from '../core/types.js';
import type { DatabaseService } from '../core/database.js';
import { stableChecksum } from '../schema/validate.js';
import {
  PostgresExtensionRegistry,
} from '../postgres-extensions.js';
import { canonicalizePostgresSchema } from './canonicalize.js';
import { introspectPostgresDatabase } from './introspect.js';
import { planPostgresSchema } from './planner.js';
import {
  postgresMigrationStatements,
  type PostgresMigrationStatement,
} from './sql.js';
import type {
  PostgresMigrationDefinition,
  PostgresMigrationOperation,
  PostgresResourceSchema,
  PostgresSchemaAction,
  PostgresSchemaAdoptionResult,
  PostgresSchemaEnsureResult,
  PostgresSchemaPlan,
  PostgresExtensionReport,
} from './types.js';
import {
  postgresSchemaChecksum,
  validatePostgresSchema,
} from './validate.js';

type Row = Record<string, unknown>;

const advisoryLockNamespace = 1_967_988_33;
const advisoryLockWaitMs = 30_000;
const advisoryLockPollMs = 100;

interface Registry {
  version: number;
  checksum: string;
  tables: string[];
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

export interface PostgresSchemaManagerOptions {
  mode?: 'auto' | 'plan' | 'off';
  allowBlocking?: boolean;
  lockTimeout?: number;
  applicationDatabase?: DatabaseService;
  extensionRegistry?: PostgresExtensionRegistry;
}

export class PostgresSchemaMigrationRequiredError extends Error {
  public constructor(public readonly plan: PostgresSchemaPlan) {
    const blocked = plan.actions.filter((action) => !action.automatic);
    super(
      blocked.length > 0
        ? `PostgreSQL schema for '${plan.resource}' requires explicit migrations: ${blocked.map((action) => action.reason).join('; ')}`
        : `PostgreSQL could not apply the automatic schema plan for '${plan.resource}'.`,
    );
    this.name = 'PostgresSchemaMigrationRequiredError';
  }
}

export class PostgresSchemaPendingChangesError extends Error {
  public constructor(public readonly result: PostgresSchemaEnsureResult) {
    super(`Schema mode is 'plan'; PostgreSQL schema '${result.resource}' was not changed.`);
    this.name = 'PostgresSchemaPendingChangesError';
  }
}

export class PostgresSchemaDisabledError extends Error {
  public constructor(resource: string) {
    super(`PostgreSQL schema management is disabled; cannot ensure '${resource}'.`);
    this.name = 'PostgresSchemaDisabledError';
  }
}

export class PostgresSchemaAdoptionRequiredError extends Error {
  public constructor(resource: string, tables: string[]) {
    super(
      `PostgreSQL schema '${resource}' contains unmanaged tables (${tables.join(', ')}). Use Postgres.Schema.planAdoption/adopt with an explicit baseline.`,
    );
    this.name = 'PostgresSchemaAdoptionRequiredError';
  }
}

export class PostgresSchemaAdoptionConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PostgresSchemaAdoptionConflictError';
  }
}

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value as Row[] : [];
}

function first(value: unknown): Row | undefined {
  return rows(value)[0];
}

function validateResource(resource: string): void {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(resource)) {
    throw new Error(`Invalid resource name '${resource}'.`);
  }
}

function operationTable(operation: PostgresMigrationOperation): string[] {
  switch (operation.type) {
    case 'renameTable':
      return [operation.from, operation.to];
    case 'sql':
      return [];
    default:
      return 'table' in operation ? [operation.table] : [];
  }
}

function requiresBlocking(operation: PostgresMigrationOperation): boolean {
  return [
    'renameTable',
    'renameColumn',
    'dropTable',
    'dropColumn',
    'alterColumn',
    'setPrimaryKey',
    'dropPrimaryKey',
    'dropConstraint',
    'addExclusion',
    'sql',
  ].includes(operation.type);
}

function extensionPlanActions(report: PostgresExtensionReport): PostgresSchemaAction[] {
  return report.extensions
    .filter((extension) => extension.state !== 'ready')
    .map((extension) => ({
      kind: `extension:${extension.state}`,
      sql: `-- ${extension.message}`,
      safe: true,
      dataSafe: true,
      onlineSafe: false,
      automatic: false,
      risk: 'medium',
      algorithm: 'MANUAL',
      reason: extension.message,
    }));
}

function migrationPlanActions(
  migrations: readonly PostgresMigrationDefinition[],
  operatorAllowsBlocking: boolean,
): PostgresSchemaAction[] {
  return migrations.flatMap((migration) =>
    migration.operations.flatMap((operation) => {
      const authorized = migration.allowBlocking === true && operatorAllowsBlocking;
      const blocked = requiresBlocking(operation) && !authorized;
      return postgresMigrationStatements(operation).map((statement) => ({
        kind: `migration:${operation.type}`,
        sql: statement.sql,
        safe: !('allowDataLoss' in operation && operation.allowDataLoss === true),
        dataSafe: !('allowDataLoss' in operation && operation.allowDataLoss === true),
        onlineSafe: statement.concurrent === true || !requiresBlocking(operation),
        automatic: !blocked,
        risk: requiresBlocking(operation) || 'allowDataLoss' in operation ? 'high' : 'medium',
        algorithm: statement.concurrent
          ? 'CONCURRENT'
          : operation.type === 'addForeignKey' || operation.type === 'addCheck'
            ? statement.sql.includes('VALIDATE')
              ? 'VALIDATE'
              : 'NOT VALID'
            : blocked
              ? 'MANUAL'
              : 'TRANSACTIONAL',
        reason: blocked
          ? `migration ${migration.version} (${migration.name}) requires allowBlocking=true and qbxsql_schema_allow_blocking=true`
          : `migration ${migration.version} (${migration.name})`,
        ...(operationTable(operation)[0] ? { table: operationTable(operation)[0] } : {}),
      } satisfies PostgresSchemaAction));
    }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PostgresSchemaManager {
  private initialization: Promise<void> | null = null;
  private readonly mode: 'auto' | 'plan' | 'off';
  private readonly allowBlocking: boolean;
  private readonly lockTimeout: number;
  private readonly applicationDatabase: DatabaseService;
  public readonly extensions: PostgresExtensionRegistry;

  public constructor(
    private readonly database: DatabaseService,
    options: PostgresSchemaManagerOptions = {},
  ) {
    this.mode = options.mode ?? 'auto';
    this.allowBlocking = options.allowBlocking ?? false;
    this.lockTimeout = options.lockTimeout ?? 2_000;
    this.applicationDatabase = options.applicationDatabase ?? database;
    this.extensions = options.extensionRegistry ?? new PostgresExtensionRegistry(database);
  }

  public initialize(): Promise<void> {
    this.initialization ??= this.verifySchemaTarget()
      .then(() => this.createMetadata())
      .catch((error: unknown) => {
        this.initialization = null;
        throw error;
      });
    return this.initialization;
  }

  public async plan(
    resource: string,
    input: PostgresResourceSchema,
  ): Promise<PostgresSchemaEnsureResult> {
    validateResource(resource);
    const validated = validatePostgresSchema(input);
    const checksum = postgresSchemaChecksum(validated);
    const extensionReport = await this.extensions.check(resource, validated.extensions ?? []);
    const schema = await canonicalizePostgresSchema(this.database, validated);
    // Planning is read-only. Calling initialize() here would create
    // qbxsql_internal and its tables as a side effect of a dry run, including
    // when the operator has set the schema mode to off to freeze the database.
    const metadataReady = await this.metadataExists();
    let registry: Registry | null = null;
    let migrations: readonly PostgresMigrationDefinition[] = [];
    let relevant = Object.keys(schema.tables);
    if (metadataReady) {
      registry = await this.readRegistry(resource);
      if (registry && registry.version > schema.version) {
        throw new Error(
          `Refusing to downgrade PostgreSQL schema '${resource}' from ${registry.version} to ${schema.version}.`,
        );
      }
      migrations = this.pendingMigrations(schema, registry?.version ?? schema.version);
      this.assertMigrationChecksums(schema.migrations ?? [], await this.readMigrationRows(resource));
      this.assertOwnershipTransitions(resource, registry, schema, migrations);
      relevant = await this.relevantTables(resource, schema, migrations);
    }
    const actual = await introspectPostgresDatabase(this.database, relevant);
    const drift = planPostgresSchema(resource, schema, actual);
    return {
      ...drift,
      actions: [
        ...extensionPlanActions(extensionReport),
        ...migrationPlanActions(migrations, this.allowBlocking),
        ...drift.actions,
      ],
      // Drift is diffed against the database as it stands now, not against the
      // state the pending migrations will leave behind, so one change can be
      // described twice. ensure() does not have this overlap because it applies
      // migrations first and then re-plans.
      warnings: migrations.length > 0
        ? [
            ...drift.warnings,
            `${migrations.length} pending migration(s) have not run yet; drift actions below were computed against the current database and may restate or overlap what those migrations will do.`,
          ]
        : drift.warnings,
      extensions: extensionReport,
      checksum,
      dryRun: true,
      appliedActions: [],
      appliedMigrations: [],
    };
  }

  public async ensure(
    resource: string,
    input: PostgresResourceSchema,
  ): Promise<PostgresSchemaEnsureResult> {
    validateResource(resource);
    const validated = validatePostgresSchema(input);
    const checksum = postgresSchemaChecksum(validated);
    if (this.mode === 'off') throw new PostgresSchemaDisabledError(resource);
    if (this.mode === 'plan') {
      throw new PostgresSchemaPendingChangesError(await this.plan(resource, validated));
    }

    const extensionReport = await this.extensions.require(resource, validated.extensions ?? []);
    const schema = await canonicalizePostgresSchema(this.database, validated);
    await this.initialize();

    const lock = await this.database.driver.acquire();
    try {
      await this.acquireLock(lock);
      // Checked under the lock, and for every ensure: a declared table that
      // exists but has no ownership row is an implicit adoption whether or
      // not this resource is already registered. The interrupted-
      // reconciliation escape covers journals from older runs that crashed
      // before tables were claimed together with their creation.
      if (!(await this.hasInterruptedReconciliation(resource, checksum))) {
        await this.refuseImplicitAdoption(resource, Object.keys(schema.tables));
      }
      const registry = await this.readRegistry(resource);
      if (registry && registry.version > schema.version) {
        throw new Error(
          `Refusing to downgrade PostgreSQL schema '${resource}' from ${registry.version} to ${schema.version}.`,
        );
      }
      const migrations = this.pendingMigrations(schema, registry?.version ?? schema.version);
      const migrationRows = await this.readMigrationRows(resource);
      this.assertMigrationChecksums(schema.migrations ?? [], migrationRows);
      this.assertOwnershipTransitions(resource, registry, schema, migrations);
      this.assertBlockingPolicy(resource, migrations);
      await this.assertOwnership(lock, resource, [
        ...Object.keys(schema.tables),
        ...migrations.flatMap((migration) => migration.operations.flatMap(operationTable)),
      ]);

      const appliedMigrations: number[] = [];
      const appliedActions: string[] = [];
      for (const migration of migrations) {
        await this.applyMigration(lock, resource, migration, appliedActions);
        appliedMigrations.push(migration.version);
      }

      const relevant = await this.relevantTables(resource, schema, migrations);
      const actual = await introspectPostgresDatabase(this.database, relevant);
      const plan = planPostgresSchema(resource, schema, actual);
      this.assertAutomatic(plan);
      await this.applyActions(lock, resource, checksum, plan.actions, appliedActions);

      const finalActual = await introspectPostgresDatabase(
        this.database,
        Object.keys(schema.tables),
      );
      const remaining = planPostgresSchema(resource, schema, finalActual);
      if (remaining.actions.length > 0) throw new PostgresSchemaMigrationRequiredError(remaining);
      await this.finishSchema(lock, resource, schema, checksum);

      return {
        ...plan,
        extensions: extensionReport,
        checksum,
        dryRun: false,
        appliedActions,
        appliedMigrations,
      };
    } finally {
      await this.releaseLock(lock);
      lock.release();
    }
  }

  public async planAdoption(
    resource: string,
    input: PostgresResourceSchema,
    baselineVersion: number,
  ): Promise<PostgresSchemaAdoptionResult> {
    validateResource(resource);
    const validated = validatePostgresSchema(input);
    this.validateBaseline(validated, baselineVersion);
    const extensionReport = await this.extensions.check(resource, validated.extensions ?? []);
    const checksum = postgresSchemaChecksum(validated);
    const schema = await canonicalizePostgresSchema(this.database, validated);
    const migrations = this.pendingMigrations(schema, baselineVersion);
    // Planning is read-only: consult metadata only when it already exists
    // rather than creating qbxsql_internal as a side effect of a dry run,
    // matching plan().
    const metadataReady = await this.metadataExists();
    if (metadataReady) {
      await this.assertAdoptionAvailable(resource, schema);
      this.assertMigrationChecksums(
        schema.migrations ?? [],
        await this.readMigrationRows(resource),
      );
    }
    const actual = await introspectPostgresDatabase(
      this.database,
      metadataReady
        ? await this.relevantTables(resource, schema, migrations)
        : [...new Set([
            ...Object.keys(schema.tables),
            ...migrations.flatMap((migration) => migration.operations.flatMap(operationTable)),
          ])],
    );
    const drift = planPostgresSchema(resource, schema, actual);
    return {
      ...drift,
      actions: [
        ...extensionPlanActions(extensionReport),
        ...migrationPlanActions(migrations, this.allowBlocking),
        ...drift.actions,
      ],
      extensions: extensionReport,
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
    input: PostgresResourceSchema,
    baselineVersion: number,
  ): Promise<PostgresSchemaAdoptionResult> {
    validateResource(resource);
    const validated = validatePostgresSchema(input);
    this.validateBaseline(validated, baselineVersion);
    if (this.mode === 'off') throw new PostgresSchemaDisabledError(resource);
    if (this.mode === 'plan') {
      const plan = await this.planAdoption(resource, validated, baselineVersion);
      throw new PostgresSchemaPendingChangesError(plan);
    }
    const extensionReport = await this.extensions.require(resource, validated.extensions ?? []);
    const checksum = postgresSchemaChecksum(validated);
    const schema = await canonicalizePostgresSchema(this.database, validated);
    await this.initialize();
    const lock = await this.database.driver.acquire();
    try {
      await this.acquireLock(lock);
      await this.assertAdoptionAvailable(resource, schema, true);
      const existing = await this.readAdoption(resource);
      if (
        existing &&
        (existing.baselineVersion !== baselineVersion ||
          existing.targetVersion !== schema.version ||
          existing.checksum !== checksum)
      ) {
        throw new PostgresSchemaAdoptionConflictError(
          `A different PostgreSQL adoption is already recorded for '${resource}'.`,
        );
      }
      await lock.query(
        `INSERT INTO qbxsql_internal.schema_adoptions
           (resource_name, baseline_version, target_version, checksum, status, updated_at)
         VALUES ($1, $2, $3, $4, 'pending', CURRENT_TIMESTAMP)
         ON CONFLICT (resource_name) DO UPDATE
           SET status = 'pending', updated_at = CURRENT_TIMESTAMP`,
        [resource, baselineVersion, schema.version, checksum],
      );

      const migrations = this.pendingMigrations(schema, baselineVersion);
      this.assertMigrationChecksums(schema.migrations ?? [], await this.readMigrationRows(resource));
      this.assertBlockingPolicy(resource, migrations);
      const appliedActions: string[] = [];
      const appliedMigrations: number[] = [];
      for (const migration of migrations) {
        await this.applyMigration(lock, resource, migration, appliedActions);
        appliedMigrations.push(migration.version);
      }

      const actual = await introspectPostgresDatabase(
        this.database,
        await this.relevantTables(resource, schema, migrations),
      );
      const plan = planPostgresSchema(resource, schema, actual);
      this.assertAutomatic(plan);
      await this.applyActions(lock, resource, checksum, plan.actions, appliedActions);
      const remaining = planPostgresSchema(
        resource,
        schema,
        await introspectPostgresDatabase(this.database, Object.keys(schema.tables)),
      );
      if (remaining.actions.length > 0) throw new PostgresSchemaMigrationRequiredError(remaining);
      await this.finishSchema(lock, resource, schema, checksum);
      await lock.query(
        `UPDATE qbxsql_internal.schema_adoptions
            SET status = 'completed', updated_at = CURRENT_TIMESTAMP
          WHERE resource_name = $1`,
        [resource],
      );
      return {
        ...plan,
        extensions: extensionReport,
        checksum,
        dryRun: false,
        appliedActions,
        appliedMigrations,
        adoption: true,
        baselineVersion,
      };
    } catch (error) {
      await this.database.query(
        `UPDATE qbxsql_internal.schema_adoptions
            SET status = 'failed', error = $2, updated_at = CURRENT_TIMESTAMP
          WHERE resource_name = $1`,
        [resource, errorMessage(error)],
      ).catch(() => {});
      throw error;
    } finally {
      await this.releaseLock(lock);
      lock.release();
    }
  }

  private async verifySchemaTarget(): Promise<void> {
    if (this.database === this.applicationDatabase) return;
    const identity = async (database: DatabaseService) => {
      const row = first(await database.query(
        `SELECT current_database() AS database,
                inet_server_addr()::text AS address,
                inet_server_port() AS port`,
      ));
      return {
        database: String(row?.database ?? ''),
        address: row?.address === null || row?.address === undefined ? null : String(row.address),
        port: Number(row?.port ?? 0),
      };
    };
    const [application, schema] = await Promise.all([
      identity(this.applicationDatabase),
      identity(this.database),
    ]);
    if (
      application.database !== schema.database ||
      application.port !== schema.port ||
      (application.address !== null &&
        schema.address !== null &&
        application.address !== schema.address)
    ) {
      throw new Error(
        'qbxsql_postgres_schema_connection_string must target the same PostgreSQL server and database as qbxsql_postgres_connection_string.',
      );
    }
  }

  private async createMetadata(): Promise<void> {
    await this.database.query('CREATE SCHEMA IF NOT EXISTS qbxsql_internal');
    await this.database.query(
      `CREATE TABLE IF NOT EXISTS qbxsql_internal.schema_registry (
        resource_name TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 0),
        checksum TEXT NOT NULL,
        tables_json JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    );
    await this.database.query(
      `CREATE TABLE IF NOT EXISTS qbxsql_internal.schema_migrations (
        resource_name TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (resource_name, version)
      )`,
    );
    await this.database.query(
      `CREATE TABLE IF NOT EXISTS qbxsql_internal.schema_actions (
        resource_name TEXT NOT NULL,
        action_key TEXT NOT NULL,
        checksum TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (resource_name, action_key)
      )`,
    );
    await this.database.query(
      `CREATE TABLE IF NOT EXISTS qbxsql_internal.owned_tables (
        table_schema TEXT NOT NULL DEFAULT 'public',
        table_name TEXT NOT NULL,
        resource_name TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (table_schema, table_name)
      )`,
    );
    await this.database.query(
      `CREATE TABLE IF NOT EXISTS qbxsql_internal.schema_adoptions (
        resource_name TEXT PRIMARY KEY,
        baseline_version INTEGER NOT NULL,
        target_version INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    );
  }

  /**
   * lock_timeout does not apply to advisory locks, and pg_advisory_lock waits
   * forever, so a stalled holder would hang every later ensure() with no way
   * out. Poll pg_try_advisory_lock instead and give up the way MySQL's
   * GET_LOCK('qbxsql:schema', 30) does.
   */
  private async acquireLock(connection: DatabaseConnection): Promise<void> {
    const deadline = Date.now() + advisoryLockWaitMs;
    for (;;) {
      const { rows } = await connection.query('SELECT pg_try_advisory_lock($1, $2) AS acquired', [
        advisoryLockNamespace,
        1,
      ]);
      const acquired = (Array.isArray(rows) ? (rows[0] as Row | undefined) : undefined)?.acquired;
      if (acquired === true || acquired === 't' || Number(acquired) === 1) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${advisoryLockWaitMs}ms waiting for the qbxsql PostgreSQL schema lock.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, advisoryLockPollMs));
    }
  }

  private async releaseLock(connection: DatabaseConnection): Promise<void> {
    await connection
      .query('SELECT pg_advisory_unlock($1, $2)', [advisoryLockNamespace, 1])
      .catch(() => {});
    // The concurrent-DDL branch sets lock_timeout at session scope; reset it so
    // the setting does not follow this connection back into the pool.
    await connection.query('RESET lock_timeout').catch(() => {});
  }

  private async metadataExists(): Promise<boolean> {
    return Boolean(await this.database.scalar(
      `SELECT 1
         FROM pg_catalog.pg_tables
        WHERE schemaname = 'qbxsql_internal' AND tablename = 'schema_registry'`,
    ));
  }

  private async readRegistry(resource: string): Promise<Registry | null> {
    const row = first(await this.database.query(
      `SELECT version, checksum, tables_json AS tables
         FROM qbxsql_internal.schema_registry
        WHERE resource_name = $1`,
      [resource],
    ));
    if (!row) return null;
    const tableValue =
      typeof row.tables === 'string' ? JSON.parse(row.tables) as unknown : row.tables;
    return {
      version: Number(row.version),
      checksum: String(row.checksum),
      tables: Array.isArray(tableValue) ? tableValue.map(String) : [],
    };
  }

  private async readMigrationRows(resource: string): Promise<Map<number, MigrationRow>> {
    const result = new Map<number, MigrationRow>();
    for (const row of rows(await this.database.query(
      `SELECT version, checksum, status
         FROM qbxsql_internal.schema_migrations
        WHERE resource_name = $1`,
      [resource],
    ))) {
      result.set(Number(row.version), {
        version: Number(row.version),
        checksum: String(row.checksum),
        status: String(row.status),
      });
    }
    return result;
  }

  private async readAdoption(resource: string): Promise<AdoptionRow | null> {
    const row = first(await this.database.query(
      `SELECT baseline_version AS "baselineVersion",
              target_version AS "targetVersion",
              checksum,
              status
         FROM qbxsql_internal.schema_adoptions
        WHERE resource_name = $1`,
      [resource],
    ));
    return row
      ? {
          baselineVersion: Number(row.baselineVersion),
          targetVersion: Number(row.targetVersion),
          checksum: String(row.checksum),
          status: String(row.status),
        }
      : null;
  }

  private pendingMigrations(
    schema: PostgresResourceSchema,
    baseline: number,
  ): PostgresMigrationDefinition[] {
    return (schema.migrations ?? [])
      .filter((migration) => migration.version > baseline && migration.version <= schema.version)
      .sort((left, right) => left.version - right.version);
  }

  private assertMigrationChecksums(
    migrations: readonly PostgresMigrationDefinition[],
    applied: Map<number, MigrationRow>,
  ): void {
    for (const migration of migrations) {
      const existing = applied.get(migration.version);
      if (existing && existing.checksum !== stableChecksum(migration)) {
        throw new Error(
          `PostgreSQL migration ${migration.version} was changed after it was recorded.`,
        );
      }
    }
  }

  private assertBlockingPolicy(
    resource: string,
    migrations: readonly PostgresMigrationDefinition[],
  ): void {
    for (const migration of migrations) {
      if (
        migration.operations.some(requiresBlocking) &&
        !(migration.allowBlocking === true && this.allowBlocking)
      ) {
        throw new PostgresSchemaMigrationRequiredError({
          resource,
          version: migration.version,
          actions: migrationPlanActions([migration], this.allowBlocking),
          warnings: [],
        });
      }
    }
  }

  private async relevantTables(
    resource: string,
    schema: PostgresResourceSchema,
    migrations: readonly PostgresMigrationDefinition[],
  ): Promise<string[]> {
    const owned = rows(await this.database.query(
      `SELECT table_name AS "tableName"
         FROM qbxsql_internal.owned_tables
        WHERE resource_name = $1 AND table_schema = 'public'`,
      [resource],
    )).map((row) => String(row.tableName));
    return [...new Set([
      ...Object.keys(schema.tables),
      ...owned,
      ...migrations.flatMap((migration) => migration.operations.flatMap(operationTable)),
    ])];
  }

  private async refuseImplicitAdoption(resource: string, tableNames: string[]): Promise<void> {
    const actual = await introspectPostgresDatabase(this.database, tableNames);
    if (actual.size === 0) return;
    const unmanaged: string[] = [];
    for (const table of actual.keys()) {
      const owner = first(await this.database.query(
        `SELECT resource_name AS resource
           FROM qbxsql_internal.owned_tables
          WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      ));
      if (!owner) unmanaged.push(table);
      else if (owner.resource !== resource) {
        throw new PostgresSchemaAdoptionConflictError(
          `PostgreSQL table public.${table} is owned by resource '${String(owner.resource)}'.`,
        );
      }
    }
    if (unmanaged.length > 0) throw new PostgresSchemaAdoptionRequiredError(resource, unmanaged);
  }

  /**
   * Refuse tables owned by another resource before any DDL runs. finishSchema
   * re-checks ownership, but it only runs after every statement has committed,
   * so on its own it would leave the other resource's table already mutated.
   */
  private async assertOwnership(
    connection: DatabaseConnection,
    resource: string,
    tableNames: readonly string[],
  ): Promise<void> {
    const unique = [...new Set(tableNames)];
    if (unique.length === 0) return;
    const { rows } = await connection.query(
      `SELECT table_name AS "tableName", resource_name AS resource
         FROM qbxsql_internal.owned_tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [unique],
    );
    for (const row of (Array.isArray(rows) ? rows : []) as Row[]) {
      if (String(row.resource) !== resource) {
        throw new PostgresSchemaAdoptionConflictError(
          `PostgreSQL table public.${String(row.tableName)} is owned by resource '${String(row.resource)}', not '${resource}'.`,
        );
      }
    }
  }

  private async hasInterruptedReconciliation(
    resource: string,
    schemaChecksum: string,
  ): Promise<boolean> {
    return Number(await this.database.scalar(
      `SELECT COUNT(*)::int
         FROM qbxsql_internal.schema_actions
        WHERE resource_name = $1
          AND action_key LIKE $2`,
      [resource, `reconcile:${schemaChecksum}:%`],
    )) > 0;
  }

  private assertOwnershipTransitions(
    resource: string,
    registry: Registry | null,
    schema: PostgresResourceSchema,
    migrations: readonly PostgresMigrationDefinition[],
  ): void {
    if (!registry) return;
    const desired = new Set(Object.keys(schema.tables));
    const released = new Set<string>();
    for (const migration of migrations) {
      for (const operation of migration.operations) {
        if (operation.type === 'releaseTable' || operation.type === 'dropTable') {
          released.add(operation.table);
        } else if (operation.type === 'renameTable') {
          released.add(operation.from);
        }
      }
    }
    const abandoned = registry.tables.filter((table) => !desired.has(table) && !released.has(table));
    if (abandoned.length > 0) {
      throw new Error(
        `PostgreSQL schema '${resource}' removed owned tables without releaseTable/dropTable/renameTable: ${abandoned.join(', ')}.`,
      );
    }
  }

  private async assertAdoptionAvailable(
    resource: string,
    schema: PostgresResourceSchema,
    allowResume = false,
  ): Promise<void> {
    if (await this.readRegistry(resource)) {
      throw new PostgresSchemaAdoptionConflictError(
        `PostgreSQL schema '${resource}' is already registered and cannot be adopted.`,
      );
    }
    const adoption = await this.readAdoption(resource);
    if (adoption && !allowResume) {
      throw new PostgresSchemaAdoptionConflictError(
        `PostgreSQL adoption for '${resource}' is already ${adoption.status}.`,
      );
    }
    // Migration operations run against tables too, so an adoption migration
    // must not be able to rename or drop a table another resource owns.
    const tables = new Set([
      ...Object.keys(schema.tables),
      ...(schema.migrations ?? []).flatMap((migration) =>
        migration.operations.flatMap(operationTable),
      ),
    ]);
    for (const table of tables) {
      const owner = first(await this.database.query(
        `SELECT resource_name AS resource
           FROM qbxsql_internal.owned_tables
          WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      ));
      if (owner) {
        throw new PostgresSchemaAdoptionConflictError(
          `PostgreSQL table public.${table} is already owned by '${String(owner.resource)}'.`,
        );
      }
    }
  }

  private validateBaseline(schema: PostgresResourceSchema, baseline: number): void {
    if (!Number.isInteger(baseline) || baseline < 0 || baseline >= schema.version) {
      throw new Error(
        `PostgreSQL adoption baseline must be an integer from 0 through ${schema.version - 1}.`,
      );
    }
  }

  private assertAutomatic(plan: PostgresSchemaPlan): void {
    if (plan.actions.some((action) => !action.automatic)) {
      throw new PostgresSchemaMigrationRequiredError(plan);
    }
  }

  private async applyMigration(
    connection: DatabaseConnection,
    resource: string,
    migration: PostgresMigrationDefinition,
    appliedActions: string[],
  ): Promise<void> {
    const checksum = stableChecksum(migration);
    await connection.query(
      `INSERT INTO qbxsql_internal.schema_migrations
         (resource_name, version, name, checksum, status, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', CURRENT_TIMESTAMP)
       ON CONFLICT (resource_name, version) DO UPDATE
         SET status = 'pending', error = NULL, updated_at = CURRENT_TIMESTAMP`,
      [resource, migration.version, migration.name, checksum],
    );
    try {
      for (let operationIndex = 0; operationIndex < migration.operations.length; operationIndex += 1) {
        const operation = migration.operations[operationIndex]!;
        const statements = postgresMigrationStatements(operation);
        for (let statementIndex = 0; statementIndex < statements.length; statementIndex += 1) {
          const statement = statements[statementIndex]!;
          const actionKey = `migration:${migration.version}:${operationIndex}:${statementIndex}`;
          if (await this.actionCompleted(resource, actionKey, stableChecksum(statement.sql))) continue;
          await this.executeStatement(connection, resource, actionKey, statement);
          appliedActions.push(statement.sql);
        }
      }
      await connection.query(
        `UPDATE qbxsql_internal.schema_migrations
            SET status = 'completed', error = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE resource_name = $1 AND version = $2`,
        [resource, migration.version],
      );
    } catch (error) {
      await connection.query(
        `UPDATE qbxsql_internal.schema_migrations
            SET status = 'failed', error = $3, updated_at = CURRENT_TIMESTAMP
          WHERE resource_name = $1 AND version = $2`,
        [resource, migration.version, errorMessage(error)],
      ).catch(() => {});
      throw error;
    }
  }

  private async applyActions(
    connection: DatabaseConnection,
    resource: string,
    schemaChecksum: string,
    actions: readonly PostgresSchemaAction[],
    appliedActions: string[],
  ): Promise<void> {
    for (const action of actions) {
      const actionKey = `reconcile:${schemaChecksum}:${stableChecksum({ kind: action.kind, sql: action.sql })}`;
      if (await this.actionCompleted(resource, actionKey, schemaChecksum)) continue;
      const statement: PostgresMigrationStatement = {
        sql: action.sql,
        ...(action.algorithm === 'CONCURRENT' ? { concurrent: true } : {}),
        // Claiming in the same transaction as CREATE TABLE means a crash can
        // never leave an unowned table behind for the next boot to refuse as
        // an implicit adoption.
        ...(action.kind === 'createTable' && action.table !== undefined
          ? { claimOwnership: action.table }
          : {}),
      };
      try {
        await this.executeStatement(connection, resource, actionKey, statement, schemaChecksum);
        appliedActions.push(action.sql);
      } catch (error) {
        const failurePlan: PostgresSchemaPlan = {
          resource,
          version: 0,
          actions: [{ ...action, automatic: false, reason: `${action.reason}: ${errorMessage(error)}` }],
          warnings: [],
        };
        throw new PostgresSchemaMigrationRequiredError(failurePlan);
      }
    }
  }

  private async actionCompleted(
    resource: string,
    actionKey: string,
    checksum: string,
  ): Promise<boolean> {
    const row = first(await this.database.query(
      `SELECT checksum, status
         FROM qbxsql_internal.schema_actions
        WHERE resource_name = $1 AND action_key = $2`,
      [resource, actionKey],
    ));
    if (!row) return false;
    if (String(row.checksum) !== checksum) {
      throw new Error(`Recorded PostgreSQL schema action '${actionKey}' changed checksum.`);
    }
    return row.status === 'completed';
  }

  private async executeStatement(
    connection: DatabaseConnection,
    resource: string,
    actionKey: string,
    statement: PostgresMigrationStatement,
    checksum = stableChecksum(statement.sql),
  ): Promise<void> {
    await connection.query(
      `INSERT INTO qbxsql_internal.schema_actions
         (resource_name, action_key, checksum, status, updated_at)
       VALUES ($1, $2, $3, 'pending', CURRENT_TIMESTAMP)
       ON CONFLICT (resource_name, action_key) DO UPDATE
         SET checksum = EXCLUDED.checksum, status = 'pending', error = NULL,
             updated_at = CURRENT_TIMESTAMP`,
      [resource, actionKey, checksum],
    );
    const markCompleted = (runner: DatabaseConnection) => runner.query(
      `UPDATE qbxsql_internal.schema_actions
          SET status = 'completed', error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE resource_name = $1 AND action_key = $2`,
      [resource, actionKey],
    );
    try {
      if (statement.concurrent) {
        await connection.query(`SET lock_timeout = '${this.lockTimeout}ms'`);
        await connection.query(statement.sql);
        await markCompleted(connection);
      } else {
        await connection.beginTransaction();
        try {
          await connection.query(`SET LOCAL lock_timeout = '${this.lockTimeout}ms'`);
          if (!statement.releaseOwnership) await connection.query(statement.sql);
          if (statement.claimOwnership) {
            await connection.query(
              `INSERT INTO qbxsql_internal.owned_tables
                 (table_schema, table_name, resource_name, updated_at)
               VALUES ('public', $2, $1, CURRENT_TIMESTAMP)
               ON CONFLICT (table_schema, table_name) DO UPDATE
                 SET resource_name = CASE
                   WHEN qbxsql_internal.owned_tables.resource_name = EXCLUDED.resource_name
                   THEN EXCLUDED.resource_name
                   ELSE qbxsql_internal.owned_tables.resource_name
                 END,
                 updated_at = CURRENT_TIMESTAMP`,
              [resource, statement.claimOwnership],
            );
            const owner = first((await connection.query(
              `SELECT resource_name AS resource
                 FROM qbxsql_internal.owned_tables
                WHERE table_schema = 'public' AND table_name = $1`,
              [statement.claimOwnership],
            )).rows as Row[]);
            if (owner?.resource !== resource) {
              throw new Error(
                `PostgreSQL table public.${statement.claimOwnership} is owned by '${String(owner?.resource)}'.`,
              );
            }
          }
          if (statement.renameOwnership) {
            await connection.query(
              `UPDATE qbxsql_internal.owned_tables
                  SET table_name = $3, updated_at = CURRENT_TIMESTAMP
                WHERE table_schema = 'public' AND table_name = $2 AND resource_name = $1`,
              [resource, statement.renameOwnership.from, statement.renameOwnership.to],
            );
          }
          if (statement.dropOwnership || statement.releaseOwnership) {
            await connection.query(
              `DELETE FROM qbxsql_internal.owned_tables
                WHERE table_schema = 'public' AND table_name = $2 AND resource_name = $1`,
              [resource, statement.dropOwnership ?? statement.releaseOwnership],
            );
          }
          // The completion mark commits atomically with the DDL. Written
          // separately, a crash in between would leave the journal 'pending'
          // and replay non-idempotent statements (renames, ADD CONSTRAINT)
          // on the next boot until an operator edits the journal by hand.
          await markCompleted(connection);
          await connection.commit();
        } catch (error) {
          await connection.rollback().catch(() => {});
          throw error;
        }
      }
    } catch (error) {
      await connection.query(
        `UPDATE qbxsql_internal.schema_actions
            SET status = 'failed', error = $3, updated_at = CURRENT_TIMESTAMP
          WHERE resource_name = $1 AND action_key = $2`,
        [resource, actionKey, errorMessage(error)],
      ).catch(() => {});
      throw error;
    }
  }

  private async finishSchema(
    connection: DatabaseConnection,
    resource: string,
    schema: PostgresResourceSchema,
    checksum: string,
  ): Promise<void> {
    await connection.beginTransaction();
    try {
      await connection.query(`SET LOCAL lock_timeout = '${this.lockTimeout}ms'`);
      for (const table of Object.keys(schema.tables)) {
        await connection.query(
          `INSERT INTO qbxsql_internal.owned_tables
             (table_schema, table_name, resource_name, updated_at)
           VALUES ('public', $1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (table_schema, table_name) DO UPDATE
             SET resource_name = CASE
               WHEN qbxsql_internal.owned_tables.resource_name = EXCLUDED.resource_name
               THEN EXCLUDED.resource_name
               ELSE qbxsql_internal.owned_tables.resource_name
             END,
             updated_at = CURRENT_TIMESTAMP`,
          [table, resource],
        );
        const owner = first(await connection.query(
          `SELECT resource_name AS resource
             FROM qbxsql_internal.owned_tables
            WHERE table_schema = 'public' AND table_name = $1`,
          [table],
        ).then((result) => result.rows));
        if (owner?.resource !== resource) {
          throw new Error(
            `PostgreSQL table public.${table} is owned by '${String(owner?.resource)}'.`,
          );
        }
      }
      await connection.query(
        `INSERT INTO qbxsql_internal.schema_registry
           (resource_name, version, checksum, tables_json, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, CURRENT_TIMESTAMP)
         ON CONFLICT (resource_name) DO UPDATE
           SET version = EXCLUDED.version,
               checksum = EXCLUDED.checksum,
               tables_json = EXCLUDED.tables_json,
               updated_at = CURRENT_TIMESTAMP`,
        [resource, schema.version, checksum, JSON.stringify(Object.keys(schema.tables).sort())],
      );
      // Reconcile rows exist to resume a run interrupted partway through. Once
      // the schema is converged they have served their purpose, and keeping
      // them would make an identical action a permanent no-op: if the same
      // drift reappeared out of band, the replan would skip every statement and
      // then fail the convergence re-check with no way to recover.
      await connection.query(
        `DELETE FROM qbxsql_internal.schema_actions
          WHERE resource_name = $1 AND action_key LIKE 'reconcile:%'`,
        [resource],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    }
  }
}
