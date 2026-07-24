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
    convars({});
    const config = loadConfig();

    expect(config.connectionWaitTimeout).toBe(30_000);
    expect(config.connectionQueueLimit).toBe(1_000);
    expect(config.healthInterval).toBe(10_000);
    expect(config.connectionRetryMax).toBe(30_000);
    expect(config.transactionTimeout).toBe(30_000);
    expect(config.resultsetWarning).toBe(1_000);
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

    expect(config.connectionString).toBe('mysql://native/qbox');
    expect(config.slowQueryWarning).toBe(900);
    expect(config.resultsetWarning).toBe(700);
    expect(config.transactionIsolationLevel).toBe('SERIALIZABLE');
  });

  test('supports mysql_debug as a resource-name array', () => {
    convars({ mysql_debug: '["qbx_core","ox_inventory","qbx_core"]' });

    expect(loadConfig().debug).toEqual(['qbx_core', 'ox_inventory']);
  });

  test('loads optional schema credentials without replacing the application connection', () => {
    convars({
      mysql_connection_string: 'mysql://application/qbox',
      qbxsql_schema_connection_string: 'mysql://schema/qbox',
    });
    const config = loadConfig();

    expect(config.connectionString).toBe('mysql://application/qbox');
    expect(config.schemaConnectionString).toBe('mysql://schema/qbox');
  });
});
