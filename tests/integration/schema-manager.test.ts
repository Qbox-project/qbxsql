import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createConnection } from 'mysql2/promise';
import type { QbxSqlConfig } from '../../src/config.js';
import { DatabaseService } from '../../src/core/database.js';
import { MySqlDriver } from '../../src/drivers/mysql.js';
import { introspectDatabase } from '../../src/schema/introspect.js';
import {
  SchemaAdoptionRequiredError,
  SchemaDisabledError,
  SchemaManager,
  SchemaMigrationRequiredError,
  SchemaPendingChangesError,
} from '../../src/schema/manager.js';
import type { ResourceSchema } from '../../src/schema/types.js';

const databaseName = 'qbxsql_schema_test';
const adminConnection = process.env.QBXSQL_TEST_ADMIN_URL ?? 'mysql://root@127.0.0.1';
const connectionString = `${adminConnection}/${databaseName}`;
const config: QbxSqlConfig = {
  connectionString,
  connectionLimit: 4,
  connectTimeout: 5_000,
  slowQueryWarning: 10_000,
  debug: false,
  transactionIsolationLevel: 'READ COMMITTED',
  connectionWaitTimeout: 30_000,
  connectionQueueLimit: 1_000,
  healthInterval: 10_000,
  connectionRetryMax: 30_000,
  transactionTimeout: 30_000,
  schemaMode: 'auto',
  schemaAllowBlocking: false,
};

let database: DatabaseService;
let manager: SchemaManager;
const auxiliaryDatabases: DatabaseService[] = [];

function propertiesSchema(length: number, version = 1): ResourceSchema {
  return {
    version,
    tables: {
      properties: {
        columns: {
          id: { type: 'bigint', unsigned: true, autoIncrement: true, primary: true },
          label: { type: 'varchar', length },
        },
      },
    },
  };
}

function resumableAdoptionSchema(): ResourceSchema {
  return {
    version: 2,
    tables: {
      adoption_child: {
        columns: {
          id: { type: 'int', primary: true },
        },
      },
    },
    migrations: [
      {
        version: 2,
        name: 'migrate an adoption source table',
        operations: [
          {
            type: 'addColumn',
            table: 'adoption_migration_source',
            column: 'note',
            definition: { type: 'text', nullable: true },
          },
        ],
      },
    ],
  };
}

describe('resource schema manager integration', () => {
  beforeAll(async () => {
    const admin = await createConnection(adminConnection);
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.query(
      `CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await admin.end();
    database = new DatabaseService(new MySqlDriver(config), config);
    manager = new SchemaManager(database);
  });

  afterAll(async () => {
    await Promise.all(auxiliaryDatabases.map((entry) => entry.close()));
    if (database) await database.close();
    const admin = await createConnection(adminConnection);
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.end();
  });

  test('creates and records a resource-owned schema', async () => {
    const result = await manager.ensure('housing', propertiesSchema(50));
    expect(result.appliedActions).toHaveLength(1);
    expect(result.appliedActions[0]).toContain('CREATE TABLE `properties`');

    const actual = await introspectDatabase(database);
    expect(actual.get('properties')?.columns.get('label')?.maximumLength).toBe(50);
    expect(
      await database.scalar(
        `SELECT COUNT(*) FROM qbxsql_schema_tables
         WHERE table_name = 'properties' AND resource_name = 'housing'`,
      ),
    ).toBe(1);
  });

  test('is idempotent when the declared schema is unchanged', async () => {
    const result = await manager.ensure('housing', propertiesSchema(50));
    expect(result.appliedActions).toEqual([]);
    expect(result.appliedMigrations).toEqual([]);
  });

  test('automatically widens a varchar online without requiring a version bump', async () => {
    const result = await manager.ensure('housing', propertiesSchema(60));
    expect(result.appliedActions).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('without a version bump');
    const actual = await introspectDatabase(database);
    expect(actual.get('properties')?.columns.get('label')?.maximumLength).toBe(60);
  });

  test('refuses destructive synchronization without an explicit migration', async () => {
    let error: unknown;
    try {
      await manager.ensure('housing', propertiesSchema(50));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SchemaMigrationRequiredError);
    const actual = await introspectDatabase(database);
    expect(actual.get('properties')?.columns.get('label')?.maximumLength).toBe(60);
  });

  test('returns a migration-required plan when the database rejects enforced online DDL', async () => {
    const originalQuery = database.query.bind(database);
    database.query = async (sql, parameters, options) => {
      if (sql.includes('ALTER TABLE `properties`') && sql.includes('LOCK=NONE')) {
        throw Object.assign(new Error('LOCK=NONE is not supported for this operation'), {
          code: 'ER_ALTER_OPERATION_NOT_SUPPORTED_REASON',
        });
      }
      return originalQuery(sql, parameters, options);
    };

    let error: unknown;
    try {
      await manager.ensure('housing', propertiesSchema(61));
    } catch (caught) {
      error = caught;
    } finally {
      database.query = originalQuery;
    }

    expect(error).toBeInstanceOf(SchemaMigrationRequiredError);
    expect((error as SchemaMigrationRequiredError).plan.actions[0]).toMatchObject({
      automatic: false,
      onlineSafe: false,
      risk: 'high',
    });
    expect((error as SchemaMigrationRequiredError).plan.actions[0]?.reason).toContain(
      'database rejected INPLACE/LOCK=NONE',
    );
    expect((await introspectDatabase(database)).get('properties')?.columns.get('label')?.maximumLength).toBe(
      60,
    );
  });

  test('returns a migration-required plan when structured online migration DDL is rejected', async () => {
    await manager.ensure('online_migration_rejection', {
      version: 1,
      tables: {
        online_migration_rejection_table: {
          columns: { id: { type: 'int', primary: true } },
        },
      },
    });
    const target: ResourceSchema = {
      version: 2,
      tables: {
        online_migration_rejection_table: {
          columns: {
            id: { type: 'int', primary: true },
            note: { type: 'text', nullable: true },
          },
        },
      },
      migrations: [
        {
          version: 2,
          name: 'add online note',
          operations: [
            {
              type: 'addColumn',
              table: 'online_migration_rejection_table',
              column: 'note',
              definition: { type: 'text', nullable: true },
            },
          ],
        },
      ],
    };
    const originalQuery = database.query.bind(database);
    database.query = async (sql, parameters, options) => {
      if (sql.includes('ALTER TABLE `online_migration_rejection_table`')) {
        throw new Error('ALGORITHM=INSTANT is unavailable');
      }
      return originalQuery(sql, parameters, options);
    };

    let error: unknown;
    try {
      await manager.ensure('online_migration_rejection', target);
    } catch (caught) {
      error = caught;
    } finally {
      database.query = originalQuery;
    }

    expect(error).toBeInstanceOf(SchemaMigrationRequiredError);
    expect((error as SchemaMigrationRequiredError).plan.actions[0]).toMatchObject({
      kind: 'migration:addColumn',
      automatic: false,
      algorithm: 'INSTANT',
    });
    expect(
      await database.scalar(
        `SELECT status FROM qbxsql_schema_migrations
         WHERE resource_name = 'online_migration_rejection' AND version = 2`,
      ),
    ).toBe('failed');
  });

  test('applies and journals an explicitly authorized destructive migration', async () => {
    const target = propertiesSchema(50, 2);
    target.migrations = [
      {
        version: 2,
        name: 'shrink property labels',
        allowBlocking: true,
        operations: [
          {
            type: 'alterColumn',
            table: 'properties',
            column: 'label',
            definition: { type: 'varchar', length: 50 },
            allowDataLoss: true,
          },
        ],
      },
    ];
    const result = await new SchemaManager(database, { allowBlocking: true }).ensure('housing', target);
    expect(result.appliedMigrations).toEqual([2]);
    const actual = await introspectDatabase(database);
    expect(actual.get('properties')?.columns.get('label')?.maximumLength).toBe(50);
    expect(
      await database.scalar(
        `SELECT status FROM qbxsql_schema_migrations
         WHERE resource_name = 'housing' AND version = 2`,
      ),
    ).toBe('success');
  });

  test('prevents another resource from taking ownership of a table', async () => {
    let message = '';
    try {
      await manager.ensure('other_resource', propertiesSchema(50));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("owned by resource 'housing'");
  });

  test('supports dry-run plans without changing the database', async () => {
    const result = await manager.ensure(
      'dry_resource',
      {
        version: 1,
        tables: {
          dry_table: {
            columns: { id: { type: 'int', autoIncrement: true, primary: true } },
          },
        },
      },
      true,
    );
    expect(result.dryRun).toBe(true);
    expect(result.actions[0]?.kind).toBe('createTable');
    expect((await introspectDatabase(database)).has('dry_table')).toBe(false);
  });

  test('creates related tables before adding foreign keys', async () => {
    const result = await manager.ensure('garage', {
      version: 1,
      tables: {
        garages: {
          columns: { id: { type: 'int', autoIncrement: true, primary: true } },
        },
        vehicles: {
          columns: {
            id: { type: 'int', autoIncrement: true, primary: true },
            garage_id: { type: 'int', nullable: true },
          },
          indexes: [{ name: 'vehicles_garage_idx', columns: ['garage_id'] }],
          foreignKeys: [
            {
              name: 'vehicles_garage_fk',
              columns: ['garage_id'],
              references: { table: 'garages', columns: ['id'] },
              onDelete: 'SET NULL',
            },
          ],
        },
      },
    });
    expect(result.appliedActions).toHaveLength(2);
    expect((await introspectDatabase(database)).get('vehicles')?.foreignKeys.has('vehicles_garage_fk')).toBe(
      true,
    );
  });

  test('serializes concurrent resource schema startup without conflicts', async () => {
    const [first, second] = await Promise.all([
      manager.ensure('concurrent_first', {
        version: 1,
        tables: {
          concurrent_first_table: { columns: { id: { type: 'int', primary: true } } },
        },
      }),
      manager.ensure('concurrent_second', {
        version: 1,
        tables: {
          concurrent_second_table: { columns: { id: { type: 'int', primary: true } } },
        },
      }),
    ]);

    expect(first.appliedActions).toHaveLength(1);
    expect(second.appliedActions).toHaveLength(1);
    const actual = await introspectDatabase(database, [
      'concurrent_first_table',
      'concurrent_second_table',
    ]);
    expect([...actual.keys()].sort()).toEqual([
      'concurrent_first_table',
      'concurrent_second_table',
    ]);
  });

  test('plan and off modes never apply resource DDL', async () => {
    const schema: ResourceSchema = {
      version: 1,
      tables: {
        mode_probe: { columns: { id: { type: 'int', primary: true } } },
      },
    };
    const planManager = new SchemaManager(database, { mode: 'plan' });
    await expect(planManager.ensure('mode_probe_resource', schema)).rejects.toBeInstanceOf(
      SchemaPendingChangesError,
    );
    expect((await introspectDatabase(database)).has('mode_probe')).toBe(false);

    const offManager = new SchemaManager(database, { mode: 'off' });
    await expect(offManager.ensure('mode_probe_resource', schema)).rejects.toBeInstanceOf(
      SchemaDisabledError,
    );
    expect((await offManager.plan('mode_probe_resource', schema)).actions[0]).toMatchObject({
      kind: 'createTable',
      automatic: true,
    });
    expect((await introspectDatabase(database)).has('mode_probe')).toBe(false);
  });

  test('renames and removes ownership only after successful table migrations', async () => {
    await manager.ensure('ownership_lifecycle', {
      version: 1,
      tables: {
        ownership_old: { columns: { id: { type: 'int', primary: true } } },
      },
    });
    await manager.ensure('ownership_lifecycle', {
      version: 2,
      tables: {
        ownership_new: { columns: { id: { type: 'int', primary: true } } },
      },
      migrations: [
        {
          version: 2,
          name: 'rename owned table',
          operations: [{ type: 'renameTable', from: 'ownership_old', to: 'ownership_new' }],
        },
      ],
    });
    expect(
      await database.scalar(
        `SELECT COUNT(*) FROM qbxsql_schema_tables
         WHERE table_name = 'ownership_new' AND resource_name = 'ownership_lifecycle'`,
      ),
    ).toBe(1);
    expect(
      await database.scalar(
        `SELECT COUNT(*) FROM qbxsql_schema_tables WHERE table_name = 'ownership_old'`,
      ),
    ).toBe(0);

    await manager.ensure('ownership_lifecycle', {
      version: 3,
      tables: {},
      migrations: [
        {
          version: 3,
          name: 'drop owned table',
          operations: [{ type: 'dropTable', table: 'ownership_new', allowDataLoss: true }],
        },
      ],
    });
    expect((await introspectDatabase(database)).has('ownership_new')).toBe(false);
    expect(
      await database.scalar(
        `SELECT COUNT(*) FROM qbxsql_schema_tables WHERE table_name = 'ownership_new'`,
      ),
    ).toBe(0);
  });

  test('requires explicit ownership release when a table leaves the declaration', async () => {
    const initial: ResourceSchema = {
      version: 1,
      tables: {
        released_table: { columns: { id: { type: 'int', primary: true } } },
      },
    };
    await manager.ensure('ownership_release', initial);
    await expect(
      manager.ensure('ownership_release', { version: 2, tables: {} }),
    ).rejects.toThrow('was removed from the declaration but is still managed');
    expect(
      await database.scalar(
        `SELECT COUNT(*) FROM qbxsql_schema_tables
         WHERE table_name = 'released_table' AND resource_name = 'ownership_release'`,
      ),
    ).toBe(1);

    await manager.ensure('ownership_release', {
      version: 2,
      tables: {},
      migrations: [
        {
          version: 2,
          name: 'release legacy table',
          operations: [
            { type: 'releaseTable', table: 'released_table', allowOwnershipTransfer: true },
          ],
        },
      ],
    });
    expect((await introspectDatabase(database)).has('released_table')).toBe(true);
    expect(
      await database.scalar(
        `SELECT COUNT(*) FROM qbxsql_schema_tables WHERE table_name = 'released_table'`,
      ),
    ).toBe(0);
  });

  test('adds a primary key when the table does not already have one', async () => {
    await manager.ensure('primary_key_migration', {
      version: 1,
      tables: {
        primary_key_migration_table: {
          columns: { id: { type: 'int' } },
        },
      },
    });

    const result = await manager.ensure('primary_key_migration', {
      version: 2,
      tables: {
        primary_key_migration_table: {
          columns: { id: { type: 'int' } },
          primaryKey: ['id'],
        },
      },
      migrations: [
        {
          version: 2,
          name: 'add the first primary key',
          operations: [
            { type: 'setPrimaryKey', table: 'primary_key_migration_table', columns: ['id'] },
          ],
        },
      ],
    });

    expect(result.appliedMigrations).toEqual([2]);
    expect(
      (await introspectDatabase(database))
        .get('primary_key_migration_table')
        ?.indexes.get('PRIMARY')?.columns,
    ).toEqual(['id']);
  });

  test('requires both migration and operator approval for blocking DDL', async () => {
    await manager.ensure('blocking_gate', {
      version: 1,
      tables: {
        blocking_gate_table: { columns: { id: { type: 'int', primary: true } } },
      },
    });
    const target: ResourceSchema = {
      version: 2,
      tables: {
        blocking_gate_table: { columns: { id: { type: 'int', primary: true } } },
      },
      migrations: [
        {
          version: 2,
          name: 'explicit blocking maintenance',
          allowBlocking: true,
          operations: [
            {
              type: 'sql',
              sql: 'OPTIMIZE TABLE `blocking_gate_table`',
              allowDataLoss: true,
            },
          ],
        },
      ],
    };

    await expect(manager.ensure('blocking_gate', target)).rejects.toThrow(
      'requires both migration allowBlocking=true and qbxsql_schema_allow_blocking=true',
    );
    await expect(
      new SchemaManager(database, { allowBlocking: true }).ensure('blocking_gate', target),
    ).resolves.toMatchObject({ appliedMigrations: [2] });
  });

  test('adopts an unmanaged legacy schema from an explicit baseline', async () => {
    await database.query(
      `CREATE TABLE legacy_properties (
        id INT NOT NULL PRIMARY KEY
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const schema: ResourceSchema = {
      version: 2,
      tables: {
        legacy_properties: {
          columns: {
            id: { type: 'int', primary: true },
            label: { type: 'varchar', length: 50, nullable: true },
          },
        },
      },
      migrations: [
        {
          version: 2,
          name: 'add legacy property label',
          operations: [
            {
              type: 'addColumn',
              table: 'legacy_properties',
              column: 'label',
              definition: { type: 'varchar', length: 50, nullable: true },
            },
          ],
        },
      ],
    };

    await expect(manager.ensure('legacy_housing', schema)).rejects.toBeInstanceOf(
      SchemaAdoptionRequiredError,
    );
    const plan = await manager.planAdoption('legacy_housing', schema, 1);
    expect(plan).toMatchObject({ adoption: true, baselineVersion: 1, dryRun: true });
    expect(plan.actions[0]).toMatchObject({ kind: 'migration:addColumn', automatic: true });

    const adopted = await manager.adopt('legacy_housing', schema, 1);
    expect(adopted.appliedMigrations).toEqual([2]);
    expect(
      await database.scalar(
        `SELECT version FROM qbxsql_schema_registry WHERE resource_name = 'legacy_housing'`,
      ),
    ).toBe(2);
    expect(
      await database.scalar(
        `SELECT baseline_version FROM qbxsql_schema_adoptions
         WHERE resource_name = 'legacy_housing' AND status = 'success'`,
      ),
    ).toBe(1);
    await expect(manager.planAdoption('invalid_baseline', schema, 2)).rejects.toThrow(
      'integer from 0 through 1',
    );
  });

  test('refuses adoption for an already managed resource', async () => {
    await expect(
      manager.planAdoption('legacy_housing', { version: 1, tables: {} }, 0),
    ).rejects.toThrow('already has a managed schema');
  });

  test('persists the baseline when an adoption migration fails', async () => {
    await database.query(
      `CREATE TABLE adoption_child (
        id INT NOT NULL PRIMARY KEY
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const adoptionManager = new SchemaManager(database);
    await expect(
      adoptionManager.adopt('resumable_adoption', resumableAdoptionSchema(), 1),
    ).rejects.toThrow();
  });

  test('records the adoption baseline before running later migrations', async () => {
    expect(
      await database.scalar(
        `SELECT baseline_version FROM qbxsql_schema_adoptions
         WHERE resource_name = 'resumable_adoption' AND status = 'failed'`,
      ),
    ).toBe(1);
  });

  test('resumes adoption from the persisted baseline after a failed migration', async () => {
    await database.query(
      `CREATE TABLE adoption_migration_source (
        id INT NOT NULL PRIMARY KEY
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const adoptionManager = new SchemaManager(database);
    expect(
      (
        await adoptionManager.adopt(
          'resumable_adoption',
          resumableAdoptionSchema(),
          1,
        )
      ).appliedMigrations,
    ).toEqual([2]);
    expect(
      (await introspectDatabase(database))
        .get('adoption_migration_source')
        ?.columns.has('note'),
    ).toBe(true);
  });

  test('allows verified separate schema credentials for the same server and database', async () => {
    const schemaDatabase = new DatabaseService(new MySqlDriver(config), config);
    auxiliaryDatabases.push(schemaDatabase);
    const separateManager = new SchemaManager(schemaDatabase, { applicationDatabase: database });
    const result = await separateManager.ensure('separate_credentials', {
      version: 1,
      tables: {
        separate_credentials_table: {
          columns: { id: { type: 'int', primary: true } },
        },
      },
    });

    expect(result.appliedActions[0]).toContain('CREATE TABLE `separate_credentials_table`');
    expect((await introspectDatabase(database)).has('separate_credentials_table')).toBe(true);
  });

  test('rejects schema credentials for a different database', async () => {
    const wrongDatabaseName = 'qbxsql_schema_wrong_target';
    const admin = await createConnection(adminConnection);
    await admin.query(`DROP DATABASE IF EXISTS \`${wrongDatabaseName}\``);
    await admin.query(`CREATE DATABASE \`${wrongDatabaseName}\``);
    await admin.end();
    const wrongConfig = { ...config, connectionString: `${adminConnection}/${wrongDatabaseName}` };
    const schemaDatabase = new DatabaseService(new MySqlDriver(wrongConfig), wrongConfig);
    auxiliaryDatabases.push(schemaDatabase);
    const separateManager = new SchemaManager(schemaDatabase, { applicationDatabase: database });

    await expect(
      separateManager.plan('wrong_credentials', { version: 1, tables: {} }),
    ).rejects.toThrow('different server or database');

    const cleanup = await createConnection(adminConnection);
    await cleanup.query(`DROP DATABASE IF EXISTS \`${wrongDatabaseName}\``);
    await cleanup.end();
  });

  test('supports introspection scoped to relevant tables', async () => {
    const scoped = await introspectDatabase(database, ['properties', 'vehicles']);

    expect([...scoped.keys()].sort()).toEqual(['properties', 'vehicles']);
    expect(scoped.has('legacy_properties')).toBe(false);
  });

});
