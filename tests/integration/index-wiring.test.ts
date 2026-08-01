import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createConnection } from 'mysql2/promise';
import { Pool } from 'pg';

/**
 * Executes the real FXServer entry point (src/index.ts) under faked CFX
 * globals against live databases. Everything else in the suite tests the
 * layers individually; this is the only CI coverage that the module-level
 * wiring -- convar loading, export registration, provider aliases, lifecycle
 * events, and console commands -- actually holds together.
 */
const databaseName = 'qbxsql_wiring_test';
const mysqlAdmin = process.env.QBXSQL_TEST_ADMIN_URL ?? 'mysql://root@127.0.0.1';
const postgresAdmin =
  process.env.QBXSQL_TEST_POSTGRES_ADMIN_URL ??
  'postgresql://postgres:root@127.0.0.1:5432/postgres';

const directExports = new Map<string, (...args: unknown[]) => unknown>();
const providerEvents = new Set<string>();
const registeredCommands = new Map<string, (source: number) => void>();
const emittedEvents: string[] = [];

type RuntimeModule = typeof import('../../src/index.js');
let runtime: RuntimeModule;

describe('FXServer entry point wiring', () => {
  beforeAll(async () => {
    const admin = await createConnection(mysqlAdmin);
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.query(`CREATE DATABASE \`${databaseName}\``);
    await admin.end();

    const pgAdmin = new Pool({ connectionString: postgresAdmin });
    await pgAdmin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    );
    await pgAdmin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await pgAdmin.query(`CREATE DATABASE "${databaseName}"`);
    await pgAdmin.end();

    const mysqlUrl = new URL(mysqlAdmin);
    mysqlUrl.pathname = `/${databaseName}`;
    const postgresUrl = new URL(postgresAdmin);
    postgresUrl.pathname = `/${databaseName}`;
    const convars = new Map<string, string>([
      ['mysql_connection_string', mysqlUrl.toString()],
      ['qbxsql_postgres_connection_string', postgresUrl.toString()],
    ]);

    const runtimeGlobal = globalThis as Record<string, unknown>;
    runtimeGlobal.GetConvar = (name: string, fallback: string) =>
      convars.get(name) ?? fallback;
    runtimeGlobal.GetCurrentResourceName = () => 'qbxsql';
    runtimeGlobal.GetNumResources = () => 0;
    runtimeGlobal.GetResourceByFindIndex = () => '';
    runtimeGlobal.GetInvokingResource = () => 'wiring_test';
    runtimeGlobal.ScheduleResourceTick = () => {};
    runtimeGlobal.RegisterCommand = (
      name: string,
      handler: (source: number) => void,
    ) => {
      registeredCommands.set(name, handler);
    };
    runtimeGlobal.emit = (name: string) => {
      emittedEvents.push(name);
    };
    runtimeGlobal.on = (event: string) => {
      if (event.startsWith('__cfx_export_')) providerEvents.add(event);
    };
    runtimeGlobal.exports = (name: string, callback: (...args: unknown[]) => unknown) => {
      directExports.set(name, callback);
    };

    runtime = await import('../../src/index.js');
  });

  afterAll(async () => {
    await runtime?.mysqlDatabase?.close();
    await runtime?.postgresDatabase?.close();
  });

  test('registers the compatibility, PostgreSQL, and schema surfaces', () => {
    for (const name of [
      'query', 'single', 'scalar', 'insert', 'update', 'prepare', 'rawExecute',
      'transaction', 'startTransaction', 'store', 'isReady', 'awaitConnection',
      'getStatus', 'getStatuses', 'query_async', 'querySync',
      'postgresQuery', 'postgresExecute', 'postgresTransaction', 'postgresIsReady',
      'ensureSchema', 'planSchema', 'adoptSchema', 'planSchemaAdoption',
      'postgresEnsureSchema', 'postgresPlanSchema', 'postgresGetExtensions',
    ]) {
      expect(directExports.has(name)).toBe(true);
    }
    // Legacy provider aliases are exposed through CFX export events.
    expect(providerEvents.has('__cfx_export_oxmysql_query')).toBe(true);
    expect(providerEvents.has('__cfx_export_mysql-async_mysql_fetch_all')).toBe(true);
    expect(providerEvents.has('__cfx_export_ghmattimysql_execute')).toBe(true);
    expect(registeredCommands.has('qbxsql_status')).toBe(true);
    expect(registeredCommands.has('qbxsql_extensions')).toBe(true);
  });

  test('serves queries through both lanes end to end', async () => {
    await directExports.get('awaitConnection')!();
    await directExports.get('postgresAwaitConnection')!();
    expect(emittedEvents).toContain('qbxsql:ready');
    expect(emittedEvents).toContain('qbxsql:mysql:ready');
    expect(emittedEvents).toContain('qbxsql:postgres:ready');

    await new Promise<void>((resolve, reject) => {
      directExports.get('query')!(
        'CREATE TABLE wiring (id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(50))',
        [],
        (result: unknown, error?: string) => (error ? reject(new Error(error)) : resolve()),
        'wiring_test',
        true,
      );
    });
    const insertId = await directExports.get('insert_async')!(
      'INSERT INTO wiring (label) VALUES (?)',
      ['hello'],
    );
    expect(insertId).toBe(1);
    expect(await directExports.get('scalar_async')!(
      'SELECT label FROM wiring WHERE id = ?',
      [1],
    )).toBe('hello');

    const postgresResult = await new Promise<{ rows: unknown }>((resolve, reject) => {
      directExports.get('postgresExecute')!(
        'SELECT 41 + 1 AS answer',
        [],
        (result: { rows: unknown }, error?: unknown) =>
          (error ? reject(error) : resolve(result)),
        'wiring_test',
      );
    });
    expect(postgresResult.rows).toEqual([{ answer: 42 }]);

    const statuses = (await directExports.get('getStatuses')!()) as {
      mysql: { state: string } | null;
      postgresql: { state: string } | null;
    };
    expect(statuses.mysql?.state).toBe('ready');
    expect(statuses.postgresql?.state).toBe('ready');
  });
});
