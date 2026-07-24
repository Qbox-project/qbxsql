import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createConnection } from 'mysql2/promise';
import { Pool } from 'pg';
import {
  registerCompatibilityExports,
  type ExportFunction,
  type RuntimeBindings,
} from '../../src/api/compatibility.js';
import { registerPostgresExports } from '../../src/api/postgres.js';
import type { PostgresSqlConfig, QbxSqlConfig } from '../../src/config.js';
import { DatabaseService } from '../../src/core/database.js';
import { MySqlDriver } from '../../src/drivers/mysql.js';
import { PostgresDriver } from '../../src/drivers/postgres.js';

const mysqlDatabaseName = 'qbxsql_dual_mysql_test';
const postgresDatabaseName = 'qbxsql_dual_postgres_test';
const mysqlAdmin =
  process.env.QBXSQL_TEST_ADMIN_URL ?? 'mysql://root:root@127.0.0.1:3306';
const postgresAdmin =
  process.env.QBXSQL_TEST_POSTGRES_ADMIN_URL ??
  'postgresql://postgres:root@127.0.0.1:5432/postgres';

function baseConfig(connectionString: string): QbxSqlConfig {
  return {
    connectionString,
    connectionLimit: 2,
    connectTimeout: 5_000,
    slowQueryWarning: 10_000,
    debug: false,
    transactionIsolationLevel: 'READ COMMITTED',
    connectionWaitTimeout: 2_000,
    connectionQueueLimit: 100,
    healthInterval: 10_000,
    connectionRetryMax: 1_000,
    transactionTimeout: 2_000,
    schemaMode: 'auto',
    schemaAllowBlocking: false,
  };
}

let mysql: DatabaseService;
let postgres: DatabaseService;
let mysqlClosed = false;

describe('dual-database routing', () => {
  beforeAll(async () => {
    const mysqlAdminConnection = await createConnection(mysqlAdmin);
    await mysqlAdminConnection.query(`DROP DATABASE IF EXISTS \`${mysqlDatabaseName}\``);
    await mysqlAdminConnection.query(`CREATE DATABASE \`${mysqlDatabaseName}\``);
    await mysqlAdminConnection.end();

    const postgresAdminPool = new Pool({ connectionString: postgresAdmin });
    await postgresAdminPool.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [postgresDatabaseName],
    );
    await postgresAdminPool.query(`DROP DATABASE IF EXISTS "${postgresDatabaseName}"`);
    await postgresAdminPool.query(`CREATE DATABASE "${postgresDatabaseName}"`);
    await postgresAdminPool.end();

    const mysqlConfig = baseConfig(`${mysqlAdmin}/${mysqlDatabaseName}`);
    const postgresUrl = new URL(postgresAdmin);
    postgresUrl.pathname = `/${postgresDatabaseName}`;
    const postgresConfig: PostgresSqlConfig = {
      ...baseConfig(postgresUrl.toString()),
      minimumServerVersion: 160_000,
    };
    mysql = new DatabaseService(new MySqlDriver(mysqlConfig), mysqlConfig);
    postgres = new DatabaseService(new PostgresDriver(postgresConfig), postgresConfig);
    await Promise.all([mysql.connect(), postgres.connect()]);
  });

  afterAll(async () => {
    if (mysql && !mysqlClosed) await mysql.close();
    if (postgres) await postgres.close();
    const mysqlAdminConnection = await createConnection(mysqlAdmin);
    await mysqlAdminConnection.query(`DROP DATABASE IF EXISTS \`${mysqlDatabaseName}\``);
    await mysqlAdminConnection.end();
    const postgresAdminPool = new Pool({ connectionString: postgresAdmin });
    await postgresAdminPool.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [postgresDatabaseName],
    );
    await postgresAdminPool.query(`DROP DATABASE IF EXISTS "${postgresDatabaseName}"`);
    await postgresAdminPool.end();
  });

  test('keeps legacy exports on MySQL and native exports on PostgreSQL', async () => {
    const direct = new Map<string, ExportFunction>();
    const provider = new Map<string, ExportFunction>();
    const bindings: RuntimeBindings = {
      addExport: (name, callback) => direct.set(name, callback),
      addProviderExport: (resource, name, callback) =>
        provider.set(`${resource}:${name}`, callback),
      invokingResource: () => 'dual-integration',
    };
    registerCompatibilityExports(mysql, bindings, { legacyProviders: true });
    registerPostgresExports(postgres, bindings);

    const callbackValue = (
      method: ExportFunction,
      query: string,
    ): Promise<unknown> =>
      new Promise((resolve, reject) => {
        method(query, [], (result: unknown, error?: unknown) =>
          error ? reject(error) : resolve(result));
      });

    expect(await callbackValue(provider.get('oxmysql:scalar')!, `SELECT 'mysql' AS engine`))
      .toBe('mysql');
    expect(await callbackValue(direct.get('postgresScalar')!, `SELECT 'postgres' AS engine`))
      .toBe('postgres');
    expect(mysql.getStatus()).toMatchObject({ dialect: 'mysql', state: 'ready' });
    expect(postgres.getStatus()).toMatchObject({ dialect: 'postgresql', state: 'ready' });
  });

  test('keeps PostgreSQL available when the MySQL lane closes', async () => {
    await mysql.close();
    mysqlClosed = true;
    expect(mysql.getStatus().state).toBe('closing');
    expect(await postgres.scalar(`SELECT 'still-ready'`)).toBe('still-ready');
    expect(postgres.getStatus().state).toBe('ready');
  });
});
