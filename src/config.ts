export type TransactionIsolationLevel =
  | 'READ COMMITTED'
  | 'READ UNCOMMITTED'
  | 'REPEATABLE READ'
  | 'SERIALIZABLE';

export type SchemaMode = 'auto' | 'plan' | 'off';
export type DatabaseDebug = boolean | readonly string[];

/**
 * Runtime configuration consumed by one database service. This remains the
 * public construction type used by tests and embedders.
 */
export interface QbxSqlConfig {
  connectionString: string;
  connectionLimit: number;
  connectTimeout: number;
  slowQueryWarning: number;
  resultsetWarning?: number;
  debug: DatabaseDebug;
  transactionIsolationLevel: TransactionIsolationLevel;
  connectionWaitTimeout: number;
  connectionQueueLimit: number;
  healthInterval: number;
  connectionRetryMax: number;
  transactionTimeout: number;
  schemaMode: SchemaMode;
  schemaAllowBlocking: boolean;
  schemaConnectionString?: string;
  schemaLockTimeout?: number;
  schemaLockAcquireTimeout?: number;
  connectionLimitExplicit?: boolean;
  connectTimeoutExplicit?: boolean;
}

export interface PostgresSqlConfig extends QbxSqlConfig {
  minimumServerVersion: number;
  parseVectorResults?: boolean;
}

export interface QbxSqlRuntimeConfig {
  mysql?: QbxSqlConfig;
  postgres?: PostgresSqlConfig;
  schemaMode: SchemaMode;
  schemaAllowBlocking: boolean;
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

function firstConvar(...names: string[]): string | undefined {
  for (const name of names) {
    const value = readOptionalConvar(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function integerOption(
  names: readonly string[],
  fallback: number,
  minimum: number,
): { value: number; explicit: boolean } {
  const raw = firstConvar(...names);
  if (raw === undefined) return { value: fallback, explicit: false };

  if (!/^-?\d+$/.test(raw.trim())) {
    console.warn(`[qbxsql] Ignoring invalid integer convar ${names[0]}.`);
    return { value: fallback, explicit: false };
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < minimum) {
    console.warn(`[qbxsql] Ignoring out-of-range convar ${names[0]}; minimum is ${minimum}.`);
    return { value: fallback, explicit: false };
  }

  return { value, explicit: true };
}

function debugOption(): DatabaseDebug {
  const raw = firstConvar('qbxsql_debug', 'mysql_debug');
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

function schemaMode(): SchemaMode {
  const raw = readOptionalConvar('qbxsql_schema_mode')?.trim().toLowerCase();
  if (!raw) return 'auto';
  if (raw === 'auto' || raw === 'plan' || raw === 'off') return raw;
  console.warn('[qbxsql] qbxsql_schema_mode must be auto, plan, or off; using auto.');
  return 'auto';
}

function isolationOption(): TransactionIsolationLevel {
  const raw = firstConvar(
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

interface DatabaseConfigOptions {
  dialect: 'mysql' | 'postgresql';
  connectionString: string;
  schemaConnectionString?: string;
  mode: SchemaMode;
  allowBlocking: boolean;
}

function databaseConfig(options: DatabaseConfigOptions): QbxSqlConfig {
  const prefix =
    options.dialect === 'mysql' ? 'qbxsql_mysql_' : 'qbxsql_postgres_';
  const connectionLimit = integerOption(
    [`${prefix}connection_limit`, 'qbxsql_connection_limit'],
    10,
    1,
  );
  const connectTimeout = integerOption(
    [`${prefix}connect_timeout`, 'qbxsql_connect_timeout'],
    60_000,
    1_000,
  );

  return {
    connectionString: options.connectionString,
    connectionLimit: connectionLimit.value,
    connectionLimitExplicit: connectionLimit.explicit,
    connectTimeout: connectTimeout.value,
    connectTimeoutExplicit: connectTimeout.explicit,
    slowQueryWarning: integerOption(
      [`${prefix}slow_query_warning`, 'qbxsql_slow_query_warning', 'mysql_slow_query_warning'],
      200,
      0,
    ).value,
    resultsetWarning: integerOption(
      [`${prefix}resultset_warning`, 'qbxsql_resultset_warning', 'mysql_resultset_warning'],
      1_000,
      0,
    ).value,
    debug: debugOption(),
    transactionIsolationLevel: isolationOption(),
    connectionWaitTimeout: integerOption(
      [`${prefix}connection_wait_timeout`, 'qbxsql_connection_wait_timeout'],
      30_000,
      1,
    ).value,
    connectionQueueLimit: integerOption(
      [`${prefix}connection_queue_limit`, 'qbxsql_connection_queue_limit'],
      1_000,
      1,
    ).value,
    healthInterval: integerOption(
      [`${prefix}health_interval`, 'qbxsql_health_interval'],
      10_000,
      1_000,
    ).value,
    connectionRetryMax: integerOption(
      [`${prefix}connection_retry_max`, 'qbxsql_connection_retry_max'],
      30_000,
      250,
    ).value,
    transactionTimeout: integerOption(
      [`${prefix}transaction_timeout`, 'qbxsql_transaction_timeout'],
      30_000,
      1,
    ).value,
    schemaMode: options.mode,
    schemaAllowBlocking: options.allowBlocking,
    schemaLockTimeout: integerOption(
      [`${prefix}schema_lock_timeout`, 'qbxsql_schema_lock_timeout'],
      options.dialect === 'postgresql' ? 2_000 : 30_000,
      1,
    ).value,
    schemaLockAcquireTimeout: integerOption(
      [`${prefix}schema_lock_acquire_timeout`, 'qbxsql_schema_lock_acquire_timeout'],
      30_000,
      1_000,
    ).value,
    ...(options.schemaConnectionString
      ? { schemaConnectionString: options.schemaConnectionString }
      : {}),
  };
}

export function loadConfig(): QbxSqlRuntimeConfig {
  const mode = schemaMode();
  const allowBlocking = booleanConvar('qbxsql_schema_allow_blocking', false);
  const postgresConnectionString = readOptionalConvar('qbxsql_postgres_connection_string');
  const mysqlConnectionString = firstConvar(
    'qbxsql_mysql_connection_string',
    'qbxsql_connection_string',
    'mysql_connection_string',
  );

  if (!mysqlConnectionString && !postgresConnectionString) {
    throw new Error(
      '[qbxsql] No database configured. Set mysql_connection_string, qbxsql_mysql_connection_string, or qbxsql_postgres_connection_string.',
    );
  }

  const mysqlSchemaConnectionString = firstConvar(
    'qbxsql_mysql_schema_connection_string',
    'qbxsql_schema_connection_string',
  );
  const postgresSchemaConnectionString = readOptionalConvar(
    'qbxsql_postgres_schema_connection_string',
  );

  return {
    schemaMode: mode,
    schemaAllowBlocking: allowBlocking,
    ...(mysqlConnectionString
      ? {
          mysql: databaseConfig({
            dialect: 'mysql',
            connectionString: mysqlConnectionString,
            mode,
            allowBlocking,
            ...(mysqlSchemaConnectionString
              ? { schemaConnectionString: mysqlSchemaConnectionString }
              : {}),
          }),
        }
      : {}),
    ...(postgresConnectionString
      ? {
          postgres: {
            ...databaseConfig({
              dialect: 'postgresql',
              connectionString: postgresConnectionString,
              mode,
              allowBlocking,
              ...(postgresSchemaConnectionString
                ? { schemaConnectionString: postgresSchemaConnectionString }
                : {}),
            }),
            minimumServerVersion: 160_000,
            parseVectorResults: booleanConvar('qbxsql_postgres_parse_vector_results', true),
          },
        }
      : {}),
  };
}
