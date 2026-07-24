export type TransactionIsolationLevel =
  | 'READ COMMITTED'
  | 'READ UNCOMMITTED'
  | 'REPEATABLE READ'
  | 'SERIALIZABLE';

export interface QbxSqlConfig {
  connectionString: string;
  connectionLimit: number;
  connectTimeout: number;
  slowQueryWarning: number;
  resultsetWarning?: number;
  debug: boolean | readonly string[];
  transactionIsolationLevel: TransactionIsolationLevel;
  connectionWaitTimeout: number;
  connectionQueueLimit: number;
  healthInterval: number;
  connectionRetryMax: number;
  transactionTimeout: number;
  schemaMode: 'auto' | 'plan' | 'off';
  schemaAllowBlocking: boolean;
  schemaConnectionString?: string;
  connectionLimitExplicit?: boolean;
  connectTimeoutExplicit?: boolean;
}

const unsetConvar = '__qbxsql_convar_not_set__';

function readOptionalConvar(name: string): string | undefined {
  const value =
    typeof GetConvar === 'function'
      ? GetConvar(name, unsetConvar)
      : process.env[name] ?? unsetConvar;

  if (value === unsetConvar || value.trim() === '') return undefined;
  return value;
}

function preferredConvar(nativeName: string, legacyName?: string): string | undefined {
  return readOptionalConvar(nativeName) ?? (legacyName ? readOptionalConvar(legacyName) : undefined);
}

function integerOption(
  nativeName: string,
  fallback: number,
  minimum: number,
  legacyName?: string,
): { value: number; explicit: boolean } {
  const raw = preferredConvar(nativeName, legacyName);
  if (raw === undefined) return { value: fallback, explicit: false };

  if (!/^-?\d+$/.test(raw.trim())) {
    console.warn(`[qbxsql] Ignoring invalid integer convar ${nativeName}.`);
    return { value: fallback, explicit: false };
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < minimum) {
    console.warn(`[qbxsql] Ignoring out-of-range convar ${nativeName}; minimum is ${minimum}.`);
    return { value: fallback, explicit: false };
  }

  return { value, explicit: true };
}

function debugOption(): boolean | readonly string[] {
  const raw = preferredConvar('qbxsql_debug', 'mysql_debug');
  if (raw === undefined) return false;

  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;

  try {
    const resources = JSON.parse(raw) as unknown;
    if (Array.isArray(resources) && resources.every((entry) => typeof entry === 'string')) {
      return [...new Set(resources)];
    }
  } catch {
    // The warning below explains the accepted format.
  }

  console.warn('[qbxsql] mysql_debug/qbxsql_debug must be a boolean or a JSON array of resource names.');
  return false;
}

function booleanConvar(name: string, fallback: boolean): boolean {
  const raw = readOptionalConvar(name);
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  console.warn(`[qbxsql] Ignoring invalid boolean convar ${name}.`);
  return fallback;
}

function schemaMode(): QbxSqlConfig['schemaMode'] {
  const raw = readOptionalConvar('qbxsql_schema_mode')?.trim().toLowerCase();
  if (!raw) return 'auto';
  if (raw === 'auto' || raw === 'plan' || raw === 'off') return raw;
  console.warn('[qbxsql] qbxsql_schema_mode must be auto, plan, or off; using auto.');
  return 'auto';
}

function isolationOption(): TransactionIsolationLevel {
  const raw = preferredConvar(
    'qbxsql_transaction_isolation_level',
    'mysql_transaction_isolation_level',
  );
  if (raw === undefined) return 'READ COMMITTED';

  const normalized = raw.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').toUpperCase();
  const levels: Record<string, TransactionIsolationLevel> = {
    '1': 'REPEATABLE READ',
    '2': 'READ COMMITTED',
    '3': 'READ UNCOMMITTED',
    '4': 'SERIALIZABLE',
    'READ COMMITTED': 'READ COMMITTED',
    'READ UNCOMMITTED': 'READ UNCOMMITTED',
    'REPEATABLE READ': 'REPEATABLE READ',
    SERIALIZABLE: 'SERIALIZABLE',
  };

  if (levels[normalized]) return levels[normalized];
  console.warn('[qbxsql] Ignoring invalid transaction isolation level.');
  return 'READ COMMITTED';
}

export function loadConfig(): QbxSqlConfig {
  const connectionLimit = integerOption('qbxsql_connection_limit', 10, 1);
  const connectTimeout = integerOption('qbxsql_connect_timeout', 60_000, 1_000);

  const schemaConnectionString = readOptionalConvar('qbxsql_schema_connection_string');
  return {
    connectionString:
      preferredConvar('qbxsql_connection_string', 'mysql_connection_string') ??
      process.env.DB_CONNECTION ??
      'mysql://root@127.0.0.1/qbxsql',
    connectionLimit: connectionLimit.value,
    connectionLimitExplicit: connectionLimit.explicit,
    connectTimeout: connectTimeout.value,
    connectTimeoutExplicit: connectTimeout.explicit,
    slowQueryWarning: integerOption(
      'qbxsql_slow_query_warning',
      200,
      0,
      'mysql_slow_query_warning',
    ).value,
    resultsetWarning: integerOption(
      'qbxsql_resultset_warning',
      1_000,
      0,
      'mysql_resultset_warning',
    ).value,
    debug: debugOption(),
    transactionIsolationLevel: isolationOption(),
    connectionWaitTimeout: integerOption('qbxsql_connection_wait_timeout', 30_000, 1).value,
    connectionQueueLimit: integerOption('qbxsql_connection_queue_limit', 1_000, 1).value,
    healthInterval: integerOption('qbxsql_health_interval', 10_000, 1_000).value,
    connectionRetryMax: integerOption('qbxsql_connection_retry_max', 30_000, 250).value,
    transactionTimeout: integerOption('qbxsql_transaction_timeout', 30_000, 1).value,
    schemaMode: schemaMode(),
    schemaAllowBlocking: booleanConvar('qbxsql_schema_allow_blocking', false),
    ...(schemaConnectionString ? { schemaConnectionString } : {}),
  };
}
