import { afterEach, describe, expect, test } from 'bun:test';
import { loadConfig } from '../../src/config.js';

const originalGetConvar = globalThis.GetConvar;

function convars(values: Record<string, string>): void {
  globalThis.GetConvar = ((name: string, fallback: string) => values[name] ?? fallback) as typeof GetConvar;
}

afterEach(() => {
  globalThis.GetConvar = originalGetConvar;
});

describe('connector configuration', () => {
  test('uses production lifecycle defaults', () => {
    convars({ mysql_connection_string: 'mysql://root@127.0.0.1/qbxsql' });
    const config = loadConfig();
    const mysql = config.mysql!;

    expect(mysql.connectionWaitTimeout).toBe(30_000);
    expect(mysql.connectionQueueLimit).toBe(1_000);
    expect(mysql.healthInterval).toBe(10_000);
    expect(mysql.connectionRetryMax).toBe(30_000);
    expect(mysql.transactionTimeout).toBe(30_000);
    expect(mysql.resultsetWarning).toBe(1_000);
    expect(mysql.schemaLockTimeout).toBe(30_000);
    expect(mysql.schemaLockAcquireTimeout).toBe(30_000);
    expect(config.schemaMode).toBe('auto');
    expect(config.schemaAllowBlocking).toBe(false);
  });

  test('prefers qbxsql-native aliases over legacy oxmysql convars', () => {
    convars({
      qbxsql_connection_string: 'mysql://native/qbox',
      mysql_connection_string: 'mysql://legacy/qbox',
      qbxsql_slow_query_warning: '900',
      mysql_slow_query_warning: '100',
      qbxsql_resultset_warning: '700',
      mysql_resultset_warning: '100',
      qbxsql_transaction_isolation_level: 'serializable',
      mysql_transaction_isolation_level: '1',
    });
    const config = loadConfig();

    expect(config.mysql?.connectionString).toBe('mysql://native/qbox');
    expect(config.mysql?.slowQueryWarning).toBe(900);
    expect(config.mysql?.resultsetWarning).toBe(700);
    expect(config.mysql?.transactionIsolationLevel).toBe('SERIALIZABLE');
  });

  test('supports mysql_debug as a resource-name array', () => {
    convars({
      mysql_connection_string: 'mysql://root@127.0.0.1/qbxsql',
      mysql_debug: '["qbx_core","ox_inventory","qbx_core"]',
    });

    expect(loadConfig().mysql?.debug).toEqual(['qbx_core', 'ox_inventory']);
  });

  test('loads optional schema credentials without replacing the application connection', () => {
    convars({
      mysql_connection_string: 'mysql://application/qbox',
      qbxsql_schema_connection_string: 'mysql://schema/qbox',
    });
    const config = loadConfig();

    expect(config.mysql?.connectionString).toBe('mysql://application/qbox');
    expect(config.mysql?.schemaConnectionString).toBe('mysql://schema/qbox');
  });

  test('supports PostgreSQL-only and dual-database configurations', () => {
    convars({
      qbxsql_postgres_connection_string: 'postgresql://postgres@127.0.0.1/qbxsql',
      qbxsql_postgres_schema_connection_string: 'postgresql://schema@127.0.0.1/qbxsql',
      qbxsql_postgres_connection_limit: '15',
    });
    const postgresOnly = loadConfig();

    expect(postgresOnly.mysql).toBeUndefined();
    expect(postgresOnly.postgres).toMatchObject({
      connectionString: 'postgresql://postgres@127.0.0.1/qbxsql',
      schemaConnectionString: 'postgresql://schema@127.0.0.1/qbxsql',
      connectionLimit: 15,
      schemaLockTimeout: 2_000,
      minimumServerVersion: 160_000,
    });

    convars({
      mysql_connection_string: 'mysql://root@127.0.0.1/qbxsql',
      qbxsql_postgres_connection_string: 'postgresql://postgres@127.0.0.1/qbxsql',
    });
    const dual = loadConfig();
    expect(dual.mysql).toBeDefined();
    expect(dual.postgres).toBeDefined();
  });

  test('requires at least one explicitly configured database', () => {
    convars({});
    expect(() => loadConfig()).toThrow('No database configured');
  });
});
