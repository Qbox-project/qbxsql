import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import type { PostgresSqlConfig } from '../../src/config.js';
import { DatabaseService } from '../../src/core/database.js';
import { PostgresDriver } from '../../src/drivers/postgres.js';
import { introspectPostgresDatabase } from '../../src/postgres-schema/introspect.js';
import {
  PostgresSchemaDisabledError,
  PostgresSchemaManager,
  PostgresSchemaMigrationRequiredError,
  PostgresSchemaPendingChangesError,
} from '../../src/postgres-schema/manager.js';
import type { PostgresResourceSchema } from '../../src/postgres-schema/types.js';

const databaseName = 'qbxsql_postgres_test';
const credentialDatabaseName = 'qbxsql_postgres_credentials_test';
const schemaUser = 'qbxsql_postgres_schema_agent';
const schemaPassword = 'qbxsql-postgres-schema-password';
const adminConnection =
  process.env.QBXSQL_TEST_POSTGRES_ADMIN_URL ??
  'postgresql://postgres:root@127.0.0.1:5432/postgres';
const connectionString = new URL(adminConnection);
connectionString.pathname = `/${databaseName}`;

const config: PostgresSqlConfig = {
  connectionString: connectionString.toString(),
  connectionLimit: 4,
  connectTimeout: 5_000,
  slowQueryWarning: 10_000,
  debug: false,
  transactionIsolationLevel: 'READ COMMITTED',
  connectionWaitTimeout: 30_000,
  connectionQueueLimit: 1_000,
  healthInterval: 10_000,
  connectionRetryMax: 30_000,
  transactionTimeout: 1_000,
  schemaMode: 'auto',
  schemaAllowBlocking: false,
  schemaLockTimeout: 2_000,
  minimumServerVersion: 160_000,
  parseVectorResults: true,
};

let database: DatabaseService;
let manager: PostgresSchemaManager;
const auxiliaryDatabases: DatabaseService[] = [];

function propertySchema(length = 64, version = 1): PostgresResourceSchema {
  return {
    version,
    tables: {
      pg_properties: {
        columns: {
          id: { type: 'bigint', identity: 'byDefault', primary: true },
          owner: { type: 'varchar', length },
          price: { type: 'numeric', precision: 12, scale: 2, default: 0 },
          metadata: { type: 'jsonb', default: {} },
          created_at: {
            type: 'timestamptz',
            defaultExpression: 'CURRENT_TIMESTAMP',
          },
        },
        checks: [{ name: 'pg_properties_price_check', expression: 'price >= 0' }],
        indexes: [{ name: 'pg_properties_owner_idx', columns: ['owner'] }],
      },
    },
  };
}

describe('PostgreSQL driver and schema integration', () => {
  test('runs concurrent schema operations with a single query connection', async () => {
    const smallConfig = { ...config, connectionLimit: 1 };
    const small = new DatabaseService(new PostgresDriver(smallConfig), smallConfig);
    auxiliaryDatabases.push(small);
    const schemas = new PostgresSchemaManager(small);
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => {
      const name = `audit_pg_small_pool_${index}`;
      return schemas.ensure(name, {
        version: 1,
        tables: { [name]: { columns: { id: { type: 'integer', primary: true } } } },
      });
    }));
    expect(results.every((result) => result.appliedActions.length > 0)).toBe(true);
    expect(small.getStatus().pool.acquired).toBe(0);
    expect(small.getStatus().pool.total).toBeLessThanOrEqual(2);
  });

  test('rejects multiple statements before executing their side effects', async () => {
    await expect(database.query('CREATE TABLE audit_batch_side_effect (id int); SELECT 1'))
      .rejects.toMatchObject({ code: '42601' });
    expect(await database.scalar("SELECT to_regclass('public.audit_batch_side_effect')")).toBeNull();
  });

  test('binds parameters after a standard string ending in a backslash', async () => {
    expect(await database.single(String.raw`SELECT '\' AS slash, $1::text AS value`, ['ok']))
      .toEqual({ slash: '\\', value: 'ok' });
  });

  test('repairs safe drift even when the same reconciliation action completed before', async () => {
    const schema: PostgresResourceSchema = {
      version: 1,
      tables: {
        audit_pg_drift: {
          columns: { id: { type: 'integer', primary: true }, note: { type: 'text', nullable: true } },
          indexes: [{ name: 'audit_pg_drift_note_idx', columns: ['note'] }],
        },
      },
    };
    await manager.ensure('audit_pg_drift', schema);
    await database.query('DROP INDEX audit_pg_drift_note_idx');
    const repaired = await manager.ensure('audit_pg_drift', schema);
    expect(repaired.appliedActions.some((sql) => sql.includes('CREATE INDEX'))).toBe(true);
    await database.query('DROP TABLE audit_pg_drift');
    const recreated = await manager.ensure('audit_pg_drift', schema);
    expect(recreated.appliedActions.some((sql) => sql.includes('CREATE TABLE'))).toBe(true);
    expect((await manager.ensure('audit_pg_drift', schema)).appliedActions).toEqual([]);
  });

  test('requires data-loss approval for pending conversions before touching data', async () => {
    const schemas = new PostgresSchemaManager(database, { allowBlocking: true });
    const schema: PostgresResourceSchema = {
      version: 1,
      tables: { audit_pg_cast: { columns: { value: { type: 'text' } } } },
    };
    await schemas.ensure('audit_pg_cast', schema);
    await database.query('INSERT INTO audit_pg_cast VALUES ($1)', ['abcdef']);
    schema.version = 2;
    schema.tables.audit_pg_cast!.columns.value = { type: 'varchar', length: 3 };
    schema.migrations = [{
      version: 2, name: 'shorten value', allowBlocking: true,
      operations: [{
        type: 'alterColumn', table: 'audit_pg_cast', column: 'value',
        definition: { type: 'varchar', length: 3 }, using: 'left(value, 3)',
      }],
    }];
    const plan = await schemas.plan('audit_pg_cast', schema);
    expect(plan.actions.find((action) => action.kind === 'migration:alterColumn'))
      .toMatchObject({ automatic: false, dataSafe: false });
    let refused: unknown;
    try {
      await schemas.ensure('audit_pg_cast', schema);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(PostgresSchemaMigrationRequiredError);
    expect((refused as Error).message).toContain('allowDataLoss=true');
    expect(await database.scalar('SELECT value FROM audit_pg_cast')).toBe('abcdef');
    Object.assign(schema.migrations[0]!.operations[0]!, { allowDataLoss: true });
    await schemas.ensure('audit_pg_cast', schema);
    expect(await database.scalar('SELECT value FROM audit_pg_cast')).toBe('abc');
    expect((await schemas.ensure('audit_pg_cast', schema)).appliedActions).toEqual([]);
  });

  beforeAll(async () => {
    const admin = new Pool({ connectionString: adminConnection });
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.query(`DROP DATABASE IF EXISTS "${credentialDatabaseName}"`);
    await admin.query(`DROP ROLE IF EXISTS "${schemaUser}"`);
    await admin.query(
      `CREATE ROLE "${schemaUser}" LOGIN PASSWORD '${schemaPassword}'`,
    );
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await admin.query(`CREATE DATABASE "${credentialDatabaseName}"`);
    await admin.query(
      `GRANT CONNECT, CREATE ON DATABASE "${credentialDatabaseName}" TO "${schemaUser}"`,
    );
    await admin.end();

    const extensionAdmin = new Pool({ connectionString: connectionString.toString() });
    await extensionAdmin.query('CREATE EXTENSION vector');
    await extensionAdmin.query('CREATE EXTENSION btree_gist');
    await extensionAdmin.end();

    const credentialAdminUrl = new URL(adminConnection);
    credentialAdminUrl.pathname = `/${credentialDatabaseName}`;
    const credentialAdmin = new Pool({ connectionString: credentialAdminUrl.toString() });
    await credentialAdmin.query(
      `GRANT USAGE, CREATE ON SCHEMA public TO "${schemaUser}"`,
    );
    await credentialAdmin.end();

    database = new DatabaseService(new PostgresDriver(config), config);
    await database.connect();
    manager = new PostgresSchemaManager(database, { lockTimeout: 2_000 });
  });

  afterAll(async () => {
    await Promise.all(auxiliaryDatabases.map((entry) => entry.close()));
    if (database) await database.close();
    const admin = new Pool({ connectionString: adminConnection });
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.query(`DROP DATABASE IF EXISTS "${credentialDatabaseName}"`);
    await admin.query(`DROP ROLE IF EXISTS "${schemaUser}"`);
    await admin.end();
  });

  test('connects and reports PostgreSQL metadata', () => {
    expect(database.getStatus()).toMatchObject({
      dialect: 'postgresql',
      databaseFamily: 'PostgreSQL',
      databaseName,
      state: 'ready',
    });
  });

  test('normalizes PostgreSQL values without losing numeric precision', async () => {
    await database.query(`
      CREATE TABLE values_test (
        id BIGINT PRIMARY KEY,
        amount NUMERIC(30, 4) NOT NULL,
        enabled BOOLEAN NOT NULL,
        payload JSONB NOT NULL,
        happened_at TIMESTAMPTZ NOT NULL,
        bytes BYTEA NOT NULL
      )
    `);
    const happenedAt = '2026-07-24T12:30:00.000Z';
    const returned = await database.single(
      `INSERT INTO values_test
         (id, amount, enabled, payload, happened_at, bytes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        '9007199254740993',
        '12345678901234567890.1234',
        true,
        { source: 'fivem', nested: [1, 2] },
        happenedAt,
        Buffer.from([1, 2, 255]),
      ],
    ) as Record<string, unknown>;

    expect(returned).toEqual({
      id: '9007199254740993',
      amount: '12345678901234567890.1234',
      enabled: true,
      payload: { source: 'fivem', nested: [1, 2] },
      happened_at: Date.parse(happenedAt),
      bytes: [1, 2, 255],
    });
  });

  test('verifies pgvector requirements and manages vector types and indexes', async () => {
    const vectorSchema: PostgresResourceSchema = {
      version: 1,
      extensions: [{ name: 'vector', minimumVersion: '0.8.0' }],
      tables: {
        pg_embeddings: {
          columns: {
            id: { type: 'integer', primary: true },
            embedding: { type: 'vector', dimensions: 3 },
            half_embedding: { type: 'halfvec', dimensions: 3, nullable: true },
            sparse_embedding: { type: 'sparsevec', dimensions: 10, nullable: true },
          },
          indexes: [{
            name: 'pg_embeddings_hnsw_idx',
            method: 'hnsw',
            columns: [{
              name: 'embedding',
              operatorClass: 'vector_cosine_ops',
            }],
            options: { m: 8, ef_construction: 32 },
          }],
        },
      },
    };
    const created = await manager.ensure('postgres_vectors', vectorSchema);
    expect(created.extensions).toMatchObject({
      satisfied: true,
      extensions: [{ name: 'vector', state: 'ready' }],
    });

    await database.query(
      `INSERT INTO pg_embeddings (id, embedding, half_embedding, sparse_embedding)
       VALUES ($1, $2::vector, $3::halfvec, $4::sparsevec)`,
      [1, '[0.1,0.2,0.3]', '[0.4,0.5,0.6]', '{1:1,5:2}/10'],
    );
    const row = await database.single(
      'SELECT embedding, half_embedding, sparse_embedding FROM pg_embeddings WHERE id = $1',
      [1],
    ) as Record<string, unknown>;
    expect(row.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(Array.isArray(row.half_embedding)).toBe(true);
    expect((row.half_embedding as number[])).toHaveLength(3);
    expect((row.half_embedding as number[])[0]).toBeCloseTo(0.4, 3);
    expect(row.sparse_embedding).toBe('{1:1,5:2}/10');

    const actual = await introspectPostgresDatabase(database, ['pg_embeddings']);
    expect(actual.get('pg_embeddings')?.columns.get('embedding')?.formattedType).toBe('vector(3)');
    expect(actual.get('pg_embeddings')?.indexes.get('pg_embeddings_hnsw_idx')).toMatchObject({
      method: 'hnsw',
      operatorClasses: ['vector_cosine_ops'],
      options: { m: '8', ef_construction: '32' },
    });
    expect((await manager.plan('postgres_vectors', vectorSchema)).actions).toEqual([]);
  });

  test('manages extension-backed exclusion constraints', async () => {
    const bookingSchema: PostgresResourceSchema = {
      version: 1,
      extensions: [{ name: 'btree_gist' }],
      tables: {
        pg_room_bookings: {
          columns: {
            id: { type: 'integer', primary: true },
            room_id: { type: 'integer' },
            during: { type: 'tstzrange' },
          },
          exclusions: [{
            name: 'pg_room_bookings_no_overlap',
            method: 'gist',
            elements: [
              { column: 'room_id', operator: '=' },
              { column: 'during', operator: '&&' },
            ],
          }],
        },
      },
    };
    const result = await manager.ensure('postgres_bookings', bookingSchema);
    expect(result.extensions?.satisfied).toBe(true);
    await database.query(
      `INSERT INTO pg_room_bookings (id, room_id, during)
       VALUES ($1, $2, tstzrange($3, $4, '[)'))`,
      [1, 10, '2026-07-24T10:00:00Z', '2026-07-24T11:00:00Z'],
    );
    let overlapError: unknown;
    try {
      await database.query(
        `INSERT INTO pg_room_bookings (id, room_id, during)
         VALUES ($1, $2, tstzrange($3, $4, '[)'))`,
        [2, 10, '2026-07-24T10:30:00Z', '2026-07-24T11:30:00Z'],
      );
    } catch (error) {
      overlapError = error;
    }
    expect(overlapError).toMatchObject({ code: '23P01' });
    const actual = await introspectPostgresDatabase(database, ['pg_room_bookings']);
    expect(actual.get('pg_room_bookings')?.exclusions?.has('pg_room_bookings_no_overlap'))
      .toBe(true);
    expect((await manager.plan('postgres_bookings', bookingSchema)).actions).toEqual([]);
  }, 15_000);

  test('pins transactions and rolls failed statements back', async () => {
    await database.query('CREATE TABLE transaction_test (id INTEGER PRIMARY KEY)');
    const results = await database.transactionResults([
      { query: 'INSERT INTO transaction_test VALUES ($1) RETURNING id', parameters: [1] },
      { query: 'INSERT INTO transaction_test VALUES ($1) RETURNING id', parameters: [2] },
    ], 'postgres-integration');
    expect(results.map((result) => result.rows)).toEqual([[{ id: 1 }], [{ id: 2 }]]);

    let failure: unknown;
    try {
      await database.transactionResults([
        { query: 'INSERT INTO transaction_test VALUES ($1)', parameters: [3] },
        { query: 'INSERT INTO transaction_test VALUES ($1)', parameters: [2] },
      ]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: '23505' });
    expect(await database.scalar('SELECT COUNT(*)::int FROM transaction_test')).toBe(2);

    await database.withTransaction(async (query) => {
      await query('INSERT INTO transaction_test VALUES ($1)', [4]);
      return true;
    });
    expect(await database.scalar('SELECT COUNT(*)::int FROM transaction_test')).toBe(3);
  });

  test('creates, records, widens, and idempotently verifies resource schemas', async () => {
    const created = await manager.ensure('postgres_housing', propertySchema());
    expect(created.appliedActions.some((sql) => sql.includes('CREATE TABLE'))).toBe(true);
    expect(created.appliedActions.some((sql) => sql.includes('CREATE INDEX'))).toBe(true);

    const actual = await introspectPostgresDatabase(database, ['pg_properties']);
    expect(actual.get('pg_properties')?.columns.get('owner')?.formattedType)
      .toBe('character varying(64)');
    expect(actual.get('pg_properties')?.checks.get('pg_properties_price_check')?.validated)
      .toBe(true);
    expect(
      await database.scalar(
        `SELECT COUNT(*)::int
           FROM qbxsql_internal.owned_tables
          WHERE table_name = 'pg_properties' AND resource_name = 'postgres_housing'`,
      ),
    ).toBe(1);

    const idempotent = await manager.ensure('postgres_housing', propertySchema());
    expect(idempotent.appliedActions).toEqual([]);

    const widened = await manager.ensure('postgres_housing', propertySchema(128, 2));
    expect(widened.appliedActions.some((sql) => sql.includes('TYPE CHARACTER VARYING(128)')))
      .toBe(true);
  });

  test('requires explicit migrations for narrowing and validates adoption baselines', async () => {
    await expect(manager.ensure('postgres_housing', propertySchema(32, 3)))
      .rejects.toBeInstanceOf(PostgresSchemaMigrationRequiredError);

    await database.query(
      `CREATE TABLE legacy_postgres_properties (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        owner TEXT NOT NULL
      )`,
    );
    const adoption: PostgresResourceSchema = {
      version: 2,
      tables: {
        legacy_postgres_properties: {
          columns: {
            id: { type: 'bigint', identity: 'byDefault', primary: true },
            owner: { type: 'text' },
            note: { type: 'text', nullable: true },
          },
        },
      },
      migrations: [{
        version: 2,
        name: 'add optional note',
        operations: [{
          type: 'addColumn',
          table: 'legacy_postgres_properties',
          column: 'note',
          definition: { type: 'text', nullable: true },
        }],
      }],
    };

    const result = await manager.adopt('postgres_legacy', adoption, 1);
    expect(result.adoption).toBe(true);
    expect(result.appliedMigrations).toEqual([2]);
    expect(
      await database.scalar(
        `SELECT COUNT(*)::int
           FROM qbxsql_internal.owned_tables
          WHERE table_name = 'legacy_postgres_properties'
            AND resource_name = 'postgres_legacy'`,
      ),
    ).toBe(1);
  });

  test('adds and validates checks and foreign keys on existing tables', async () => {
    const base: PostgresResourceSchema = {
      version: 1,
      tables: {
        pg_accounts: {
          columns: {
            id: { type: 'integer', primary: true },
          },
        },
        pg_account_entries: {
          columns: {
            id: { type: 'integer', primary: true },
            account_id: { type: 'integer' },
            amount: { type: 'numeric', precision: 12, scale: 2 },
          },
        },
      },
    };
    await manager.ensure('postgres_accounts', base);
    const constrained: PostgresResourceSchema = {
      ...base,
      version: 2,
      tables: {
        ...base.tables,
        pg_account_entries: {
          ...base.tables.pg_account_entries!,
          checks: [{ name: 'pg_entries_amount_check', expression: 'amount <> 0' }],
          foreignKeys: [{
            name: 'pg_entries_account_fk',
            columns: ['account_id'],
            references: { table: 'pg_accounts', columns: ['id'] },
            onDelete: 'CASCADE',
          }],
        },
      },
    };
    const changed = await manager.ensure('postgres_accounts', constrained);
    expect(changed.appliedActions.some((sql) => sql.includes('NOT VALID'))).toBe(true);
    expect(changed.appliedActions.filter((sql) => sql.includes('VALIDATE CONSTRAINT')))
      .toHaveLength(2);

    const actual = await introspectPostgresDatabase(database, ['pg_account_entries']);
    expect(actual.get('pg_account_entries')?.checks.get('pg_entries_amount_check')?.validated)
      .toBe(true);
    expect(actual.get('pg_account_entries')?.foreignKeys.get('pg_entries_account_fk'))
      .toMatchObject({ validated: true, onDelete: 'CASCADE' });
  });

  test('fails quickly on DDL lock contention and safely resumes', async () => {
    const lockedManager = new PostgresSchemaManager(database, { lockTimeout: 250 });
    const base: PostgresResourceSchema = {
      version: 1,
      tables: {
        pg_lock_test: {
          columns: { id: { type: 'integer', primary: true } },
        },
      },
    };
    await lockedManager.ensure('postgres_locking', base);
    const next: PostgresResourceSchema = {
      version: 2,
      tables: {
        pg_lock_test: {
          columns: {
            id: { type: 'integer', primary: true },
            note: { type: 'text', nullable: true },
          },
        },
      },
    };

    const blocker = new Pool({ connectionString: connectionString.toString() });
    const client = await blocker.connect();
    await client.query('BEGIN');
    await client.query('SELECT * FROM pg_lock_test');
    const started = performance.now();
    await expect(lockedManager.ensure('postgres_locking', next))
      .rejects.toBeInstanceOf(PostgresSchemaMigrationRequiredError);
    expect(performance.now() - started).toBeLessThan(1_500);
    await client.query('ROLLBACK');
    client.release();
    await blocker.end();

    const resumed = await lockedManager.ensure('postgres_locking', next);
    expect(resumed.appliedActions.some((sql) => sql.includes('ADD COLUMN'))).toBe(true);
  });

  test('recovers an invalid interrupted concurrent index', async () => {
    const base: PostgresResourceSchema = {
      version: 1,
      tables: {
        pg_index_recovery: {
          columns: {
            id: { type: 'integer', primary: true },
            external_id: { type: 'text' },
          },
        },
      },
    };
    await manager.ensure('postgres_index_recovery', base);
    await database.query(
      `INSERT INTO pg_index_recovery (id, external_id)
       VALUES (1, 'duplicate'), (2, 'duplicate')`,
    );
    const indexed: PostgresResourceSchema = {
      ...base,
      version: 2,
      tables: {
        pg_index_recovery: {
          ...base.tables.pg_index_recovery!,
          indexes: [{
            name: 'pg_index_recovery_external_uidx',
            columns: ['external_id'],
            unique: true,
          }],
        },
      },
    };

    let indexFailure: unknown;
    try {
      await manager.ensure('postgres_index_recovery', indexed);
    } catch (error) {
      indexFailure = error;
    }
    expect(indexFailure).toBeInstanceOf(PostgresSchemaMigrationRequiredError);
    expect(
      await database.scalar(
        `SELECT NOT indisvalid
           FROM pg_index
          WHERE indexrelid = 'public.pg_index_recovery_external_uidx'::regclass`,
      ),
    ).toBe(true);

    await database.query('DELETE FROM pg_index_recovery WHERE id = 2');
    const recovered = await manager.ensure('postgres_index_recovery', indexed);
    expect(recovered.appliedActions.some((sql) => sql.includes('DROP INDEX CONCURRENTLY')))
      .toBe(true);
    expect(
      await database.scalar(
        `SELECT indisvalid
           FROM pg_index
          WHERE indexrelid = 'public.pg_index_recovery_external_uidx'::regclass`,
      ),
    ).toBe(true);
  });

  test('renames and explicitly releases ownership without dropping the table', async () => {
    const blockingManager = new PostgresSchemaManager(database, {
      allowBlocking: true,
      lockTimeout: 2_000,
    });
    const versionOne: PostgresResourceSchema = {
      version: 1,
      tables: {
        pg_owned_before: {
          columns: { id: { type: 'integer', primary: true } },
        },
      },
    };
    await blockingManager.ensure('postgres_ownership', versionOne);
    const renameMigration = {
      version: 2,
      name: 'rename the owned table',
      allowBlocking: true as const,
      operations: [{
        type: 'renameTable' as const,
        from: 'pg_owned_before',
        to: 'pg_owned_after',
      }],
    };
    const versionTwo: PostgresResourceSchema = {
      version: 2,
      tables: {
        pg_owned_after: {
          columns: { id: { type: 'integer', primary: true } },
        },
      },
      migrations: [renameMigration],
    };
    await blockingManager.ensure('postgres_ownership', versionTwo);
    expect(
      await database.scalar(
        `SELECT COUNT(*)::int
           FROM qbxsql_internal.owned_tables
          WHERE table_name = 'pg_owned_after' AND resource_name = 'postgres_ownership'`,
      ),
    ).toBe(1);

    const versionThree: PostgresResourceSchema = {
      version: 3,
      tables: {},
      migrations: [
        renameMigration,
        {
          version: 3,
          name: 'release the renamed table',
          operations: [{
            type: 'releaseTable',
            table: 'pg_owned_after',
            allowOwnershipTransfer: true,
          }],
        },
      ],
    };
    await blockingManager.ensure('postgres_ownership', versionThree);
    expect(
      await database.scalar(`SELECT to_regclass('public.pg_owned_after') IS NOT NULL`),
    ).toBe(true);
    expect(
      await database.scalar(
        `SELECT COUNT(*)::int
           FROM qbxsql_internal.owned_tables
          WHERE table_name = 'pg_owned_after'`,
      ),
    ).toBe(0);
  });

  test('supports separate schema credentials and rejects a different target database', async () => {
    const applicationUrl = new URL(adminConnection);
    applicationUrl.pathname = `/${credentialDatabaseName}`;
    const schemaUrl = new URL(applicationUrl);
    schemaUrl.username = schemaUser;
    schemaUrl.password = schemaPassword;
    const applicationConfig: PostgresSqlConfig = {
      ...config,
      connectionString: applicationUrl.toString(),
    };
    const schemaConfig: PostgresSqlConfig = {
      ...config,
      connectionString: schemaUrl.toString(),
    };
    const applicationDatabase = new DatabaseService(
      new PostgresDriver(applicationConfig),
      applicationConfig,
    );
    const schemaDatabase = new DatabaseService(
      new PostgresDriver(schemaConfig),
      schemaConfig,
    );
    auxiliaryDatabases.push(applicationDatabase, schemaDatabase);
    const separateManager = new PostgresSchemaManager(schemaDatabase, {
      applicationDatabase,
    });
    await separateManager.ensure('postgres_separate_credentials', {
      version: 1,
      tables: {
        pg_separate_credentials: {
          columns: { id: { type: 'integer', primary: true } },
        },
      },
    });
    expect(await applicationDatabase.scalar(
      `SELECT COUNT(*)::int
         FROM qbxsql_internal.owned_tables
        WHERE resource_name = 'postgres_separate_credentials'`,
    )).toBe(1);

    const wrongManager = new PostgresSchemaManager(database, {
      applicationDatabase,
    });
    let wrongTargetError: unknown;
    try {
      await wrongManager.initialize();
    } catch (error) {
      wrongTargetError = error;
    }
    expect(wrongTargetError).toBeInstanceOf(Error);
    expect((wrongTargetError as Error).message).toContain(
      'must target the same PostgreSQL server and database',
    );
  });

  test('keeps plan and off modes free of resource DDL', async () => {
    const plannedSchema: PostgresResourceSchema = {
      version: 1,
      tables: {
        pg_plan_only: {
          columns: { id: { type: 'integer', primary: true } },
        },
      },
    };
    const planManager = new PostgresSchemaManager(database, { mode: 'plan' });
    let pending: unknown;
    try {
      await planManager.ensure('postgres_plan_mode', plannedSchema);
    } catch (error) {
      pending = error;
    }
    expect(pending).toBeInstanceOf(PostgresSchemaPendingChangesError);
    expect(
      (pending as PostgresSchemaPendingChangesError).result.actions,
    ).toContainEqual(expect.objectContaining({ kind: 'createTable' }));
    expect(await database.scalar(`SELECT to_regclass('public.pg_plan_only') IS NULL`)).toBe(true);

    const offManager = new PostgresSchemaManager(database, { mode: 'off' });
    let disabled: unknown;
    try {
      await offManager.ensure('postgres_off_mode', plannedSchema);
    } catch (error) {
      disabled = error;
    }
    expect(disabled).toBeInstanceOf(PostgresSchemaDisabledError);
    const explicitPlan = await offManager.plan('postgres_off_mode', plannedSchema);
    expect(explicitPlan.dryRun).toBe(true);
    expect(await database.scalar(`SELECT to_regclass('public.pg_plan_only') IS NULL`)).toBe(true);
  });

  test('prevents another resource from taking a PostgreSQL table and reports manual drift', async () => {
    const owned: PostgresResourceSchema = {
      version: 1,
      tables: {
        pg_ownership_conflict: {
          columns: {
            id: { type: 'integer', primary: true },
            note: { type: 'varchar', length: 64, nullable: true },
          },
        },
      },
    };
    await manager.ensure('postgres_owner_one', owned);

    let conflict: unknown;
    try {
      await manager.ensure('postgres_owner_two', owned);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(Error);
    expect((conflict as Error).message).toContain('owned by');

    await database.query(
      'ALTER TABLE pg_ownership_conflict ALTER COLUMN note TYPE VARCHAR(32)',
    );
    const drift = await manager.plan('postgres_owner_one', owned);
    expect(drift.actions).toContainEqual(expect.objectContaining({
      kind: 'alterColumnType',
      automatic: true,
      algorithm: 'TRANSACTIONAL',
    }));
    await manager.ensure('postgres_owner_one', owned);
    const actual = await introspectPostgresDatabase(database, ['pg_ownership_conflict']);
    expect(actual.get('pg_ownership_conflict')?.columns.get('note')?.formattedType)
      .toBe('character varying(64)');
  });

  test('converges on defaults, checks, and predicates PostgreSQL rewrites', async () => {
    const schema: PostgresResourceSchema = {
      version: 1,
      tables: {
        pg_canonical: {
          columns: {
            id: { type: 'bigint', identity: 'byDefault', primary: true },
            status: { type: 'varchar', length: 20, default: 'active' },
            started_on: { type: 'date', default: '2024-01-01' },
            offset_value: { type: 'integer', default: -5 },
            metadata: { type: 'jsonb', default: { enabled: true, tier: 1 } },
            address: { type: 'inet', default: '127.0.0.1' },
          },
          checks: [
            {
              name: 'pg_canonical_status_check',
              expression: "(status = 'active') OR (status = 'retired')",
            },
            { name: 'pg_canonical_offset_check', expression: 'offset_value > -100' },
          ],
          indexes: [{
            name: 'pg_canonical_active_idx',
            columns: ['status'],
            where: "status = 'active'",
          }],
        },
      },
    };
    await manager.ensure('pg_canonical_resource', schema);
    // The deparsed catalog text for every one of these (casts, re-quoted
    // literals, re-parenthesized expressions) differs from the author text; a
    // brand-new manager re-planning from the catalog must still see zero
    // drift, or every boot would fail to converge.
    const again = await new PostgresSchemaManager(database, { lockTimeout: 2_000 })
      .ensure('pg_canonical_resource', schema);
    expect(again.actions).toHaveLength(0);
    expect((await manager.plan('pg_canonical_resource', schema)).actions).toHaveLength(0);
  });

  test('refuses to absorb an existing unmanaged table added to a managed declaration', async () => {
    const columns = { id: { type: 'int', primary: true } } as const;
    await manager.ensure('pg_adoption_hole_resource', {
      version: 1,
      tables: { pg_adoption_hole_a: { columns: { ...columns } } },
    });
    await database.query('CREATE TABLE pg_adoption_hole_b (id INT PRIMARY KEY)');
    let caught: unknown = null;
    try {
      await manager.ensure('pg_adoption_hole_resource', {
        version: 2,
        tables: {
          pg_adoption_hole_a: { columns: { ...columns } },
          pg_adoption_hole_b: { columns: { ...columns } },
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('unmanaged tables');
  });

  test('reconnects after the server terminates its backends', async () => {
    await database.connect();
    const reconnected = new Promise<void>((resolve) => {
      const unsubscribe = database.onLifecycle((event) => {
        if (event === 'reconnected') {
          unsubscribe();
          resolve();
        }
      });
    });

    const admin = new Pool({ connectionString: adminConnection });
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    );
    await admin.end();

    // Queries fail until the dead pool is detected and rebuilt; the service
    // must classify the failure as fatal and recover on its own.
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        await database.query('SELECT 1');
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    await reconnected;
    expect(database.getStatus().totals.reconnects).toBeGreaterThanOrEqual(1);
    expect(database.getStatus().state).toBe('ready');
  });
});
