import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createConnection } from 'mysql2/promise';
import type { QbxSqlConfig } from '../../src/config.js';
import { DatabaseService } from '../../src/core/database.js';
import { MySqlDriver } from '../../src/drivers/mysql.js';
import { introspectDatabase } from '../../src/schema/introspect.js';
import {
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

});
