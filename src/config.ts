export interface QbxSqlConfig {
  connectionString: string;
  connectionLimit: number;
  connectTimeout: number;
  slowQueryWarning: number;
  debug: boolean;
  transactionIsolationLevel:
    | 'READ COMMITTED'
    | 'READ UNCOMMITTED'
    | 'REPEATABLE READ'
    | 'SERIALIZABLE';
}

function readConvar(name: string, fallback: string): string {
  if (typeof GetConvar !== 'function') return process.env[name] ?? fallback;
  return GetConvar(name, fallback);
}

function readInteger(name: string, fallback: number): number {
  const value = Number.parseInt(readConvar(name, String(fallback)), 10);
  return Number.isFinite(value) ? value : fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = readConvar(name, String(fallback)).toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function readIsolationLevel(): QbxSqlConfig['transactionIsolationLevel'] {
  switch (readInteger('mysql_transaction_isolation_level', 2)) {
    case 1:
      return 'REPEATABLE READ';
    case 3:
      return 'READ UNCOMMITTED';
    case 4:
      return 'SERIALIZABLE';
    default:
      return 'READ COMMITTED';
  }
}

export function loadConfig(): QbxSqlConfig {
  return {
    connectionString:
      readConvar('mysql_connection_string', '') ||
      process.env.DB_CONNECTION ||
      'mysql://root@127.0.0.1/qbxsql',
    connectionLimit: Math.max(1, readInteger('qbxsql_connection_limit', 10)),
    connectTimeout: Math.max(1_000, readInteger('qbxsql_connect_timeout', 60_000)),
    slowQueryWarning: Math.max(0, readInteger('qbxsql_slow_query_warning', 200)),
    debug: readBoolean('qbxsql_debug', false),
    transactionIsolationLevel: readIsolationLevel(),
  };
}

