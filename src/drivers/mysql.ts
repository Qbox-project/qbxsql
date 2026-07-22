import {
  createPool,
  type FieldPacket,
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';
import type { ConnectionOptions, TypeCastField, TypeCastNext } from 'mysql2';
import type { QbxSqlConfig } from '../config.js';
import type {
  DatabaseConnection,
  DatabaseDriver,
  DriverResult,
  PoolStatus,
} from '../core/types.js';
import { serializeForRuntime } from '../core/serialize.js';

function booleanOption(value: string, key: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  throw new Error(`Connection-string option '${key}' must be a boolean.`);
}

function integerOption(value: string, key: string, minimum: number): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`Connection-string option '${key}' must be an integer.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`Connection-string option '${key}' must be at least ${minimum}.`);
  }
  return parsed;
}

function warnMultipleStatements(enabled: boolean, warn: (message: string) => void): void {
  if (enabled) {
    warn(
      '[qbxsql] WARNING: multipleStatements is enabled. This increases SQL injection impact and should only be used when absolutely required.',
    );
  }
}

export function parseMySqlConnectionString(
  connectionString: string,
  warn: (message: string) => void = console.warn,
): ConnectionOptions {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(connectionString)) {
    const url = new URL(connectionString);
    const parameters = [...url.searchParams];
    url.search = '';
    const options: Record<string, unknown> = { uri: url.toString() };
    for (const [sourceKey, value] of parameters) {
      const normalized = sourceKey.toLowerCase().replace(/[ _-]/g, '');
      const integerKeys: Record<string, { name: string; minimum: number }> = {
        connectionlimit: { name: 'connectionLimit', minimum: 1 },
        connecttimeout: { name: 'connectTimeout', minimum: 1 },
        queuelimit: { name: 'queueLimit', minimum: 0 },
        maxidle: { name: 'maxIdle', minimum: 0 },
        idletimeout: { name: 'idleTimeout', minimum: 1 },
        keepaliveinitialdelay: { name: 'keepAliveInitialDelay', minimum: 0 },
      };
      const booleanKeys: Record<string, string> = {
        multiplestatements: 'multipleStatements',
        decimalnumbers: 'decimalNumbers',
        bignumberstrings: 'bigNumberStrings',
        supportbignumbers: 'supportBigNumbers',
        waitforconnections: 'waitForConnections',
        jsonstrings: 'jsonStrings',
        namedplaceholders: 'namedPlaceholders',
        trace: 'trace',
        enablekeepalive: 'enableKeepAlive',
      };
      if (integerKeys[normalized]) {
        const target = integerKeys[normalized]!;
        options[target.name] = integerOption(value, target.name, target.minimum);
      } else if (booleanKeys[normalized]) {
        const target = booleanKeys[normalized]!;
        options[target] = booleanOption(value, target);
        if (target === 'multipleStatements') {
          warnMultipleStatements(options[target] as boolean, warn);
        }
      } else if (
        normalized === 'charset' ||
        normalized === 'timezone' ||
        normalized === 'socketpath'
      ) {
        options[normalized === 'socketpath' ? 'socketPath' : normalized] = value;
      } else if (normalized === 'ssl') {
        try {
          options.ssl = JSON.parse(value);
        } catch {
          options.ssl = value;
        }
      } else {
        warn(`[qbxsql] Ignoring unknown connection-string option '${sourceKey}'.`);
      }
    }
    return options as ConnectionOptions;
  }

  const options: Record<string, unknown> = {};
  for (const segment of connectionString.split(';')) {
    if (!segment.trim()) continue;
    const separator = segment.indexOf('=');
    if (separator === -1) throw new Error(`Invalid connection-string segment '${segment}'.`);
    const sourceKey = segment.slice(0, separator).trim().toLowerCase().replace(/[ _-]/g, '');
    const value = segment.slice(separator + 1).trim();

    if (['host', 'hostname', 'ip', 'server', 'datasource', 'addr', 'address'].includes(sourceKey)) {
      options.host = value;
    } else if (['user', 'userid', 'username', 'uid'].includes(sourceKey)) {
      options.user = value;
    } else if (['password', 'pwd', 'pass'].includes(sourceKey)) {
      options.password = value;
    } else if (['database', 'db', 'initialcatalog'].includes(sourceKey)) {
      options.database = value;
    } else if (
      [
        'port',
        'connectionlimit',
        'connecttimeout',
        'queuelimit',
        'maxidle',
        'idletimeout',
        'keepaliveinitialdelay',
      ].includes(sourceKey)
    ) {
      const integerKeys: Record<string, { name: string; minimum: number }> = {
        port: { name: 'port', minimum: 1 },
        connectionlimit: { name: 'connectionLimit', minimum: 1 },
        connecttimeout: { name: 'connectTimeout', minimum: 1 },
        queuelimit: { name: 'queueLimit', minimum: 0 },
        maxidle: { name: 'maxIdle', minimum: 0 },
        idletimeout: { name: 'idleTimeout', minimum: 1 },
        keepaliveinitialdelay: { name: 'keepAliveInitialDelay', minimum: 0 },
      };
      const target = integerKeys[sourceKey]!;
      options[target.name] = integerOption(value, target.name, target.minimum);
    } else if (
      [
        'multiplestatements',
        'decimalnumbers',
        'bignumberstrings',
        'supportbignumbers',
        'waitforconnections',
        'jsonstrings',
        'namedplaceholders',
        'trace',
        'enablekeepalive',
      ].includes(sourceKey)
    ) {
      const booleanKeys: Record<string, string> = {
        multiplestatements: 'multipleStatements',
        decimalnumbers: 'decimalNumbers',
        bignumberstrings: 'bigNumberStrings',
        supportbignumbers: 'supportBigNumbers',
        waitforconnections: 'waitForConnections',
        jsonstrings: 'jsonStrings',
        namedplaceholders: 'namedPlaceholders',
        trace: 'trace',
        enablekeepalive: 'enableKeepAlive',
      };
      const key = booleanKeys[sourceKey]!;
      options[key] = booleanOption(value, key);
      if (key === 'multipleStatements') warnMultipleStatements(options[key] as boolean, warn);
    } else if (sourceKey === 'charset' || sourceKey === 'timezone' || sourceKey === 'socketpath') {
      options[sourceKey === 'socketpath' ? 'socketPath' : sourceKey] = value;
    } else if (sourceKey === 'ssl') {
      try {
        options.ssl = JSON.parse(value);
      } catch {
        options.ssl = value;
      }
    } else {
      warn(`[qbxsql] Ignoring unknown connection-string option '${segment.slice(0, separator).trim()}'.`);
    }
  }
  return options as ConnectionOptions;
}

function typeCast(field: TypeCastField, next: TypeCastNext): unknown {
  switch (field.type) {
    case 'DATETIME':
    case 'DATETIME2':
    case 'TIMESTAMP':
    case 'TIMESTAMP2':
    case 'NEWDATE': {
      const value = field.string();
      return value ? new Date(value).getTime() : null;
    }
    case 'DATE': {
      const value = field.string();
      return value ? new Date(`${value} 00:00:00`).getTime() : null;
    }
    case 'TINY': {
      if (field.length !== 1) return next();
      const value = field.string();
      if (value === '0') return false;
      if (value === '1') return true;
      return next();
    }
    case 'BIT': {
      const value = field.buffer();
      if (!value || value.length !== 1) return next();
      if (value[0] === 0) return false;
      if (value[0] === 1) return true;
      return next();
    }
    default:
      return next();
  }
}

function normalizeDriverResult(
  rows: RowDataPacket[] | RowDataPacket[][] | ResultSetHeader | ResultSetHeader[],
): DriverResult {
  const header = !Array.isArray(rows) ? rows : null;
  return {
    rows: serializeForRuntime(rows),
    fields: [],
    affectedRows: header?.affectedRows ?? 0,
    changedRows: header?.changedRows ?? 0,
    insertId: header?.insertId ?? 0,
    warningStatus: header?.warningStatus ?? 0,
  };
}

async function runQuery(
  connection: Pool | PoolConnection,
  sql: string,
  parameters: readonly unknown[],
  prepared: boolean,
): Promise<DriverResult> {
  const executor = connection as unknown as {
    query(sql: string, values: readonly unknown[]): Promise<[unknown, FieldPacket[]]>;
    execute(sql: string, values: readonly unknown[]): Promise<[unknown, FieldPacket[]]>;
  };
  const [rows] = prepared
    ? await executor.execute(sql, parameters)
    : await executor.query(sql, parameters);

  return normalizeDriverResult(
    rows as RowDataPacket[] | RowDataPacket[][] | ResultSetHeader | ResultSetHeader[],
  );
}

const fatalErrorCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_PACKETS_OUT_OF_ORDER',
]);

export function isFatalDatabaseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; fatal?: unknown };
  return candidate.fatal === true ||
    (typeof candidate.code === 'string' && fatalErrorCodes.has(candidate.code));
}

class MySqlConnection implements DatabaseConnection {
  private destroyed = false;

  public constructor(
    private readonly connection: PoolConnection,
    private readonly reportFatalError: (error: unknown) => void,
  ) {}

  public query(sql: string, parameters: readonly unknown[] = []): Promise<DriverResult> {
    return this.guard(runQuery(this.connection, sql, parameters, false));
  }

  public execute(sql: string, parameters: readonly unknown[] = []): Promise<DriverResult> {
    return this.guard(runQuery(this.connection, sql, parameters, true));
  }

  public beginTransaction(): Promise<void> {
    return this.guard(this.connection.beginTransaction());
  }

  public commit(): Promise<void> {
    return this.guard(this.connection.commit());
  }

  public rollback(): Promise<void> {
    return this.guard(this.connection.rollback());
  }

  public release(): void {
    if (!this.destroyed) this.connection.release();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.connection.destroy();
  }

  private async guard<T>(operation: Promise<T>): Promise<T> {
    try {
      return await operation;
    } catch (error) {
      if (isFatalDatabaseError(error)) this.reportFatalError(error);
      throw error;
    }
  }
}

export class MySqlDriver implements DatabaseDriver {
  public readonly dialect = 'mysql' as const;
  public databaseName: string | null = null;
  public serverVersion: string | null = null;
  public ready = false;

  private pool: Pool | null = null;
  private fatalErrorListener: ((error: unknown) => void) | null = null;

  public constructor(private readonly config: QbxSqlConfig) {}

  public async connect(): Promise<void> {
    if (this.ready) return;

    const parsedOptions = parseMySqlConnectionString(this.config.connectionString);
    const options: ConnectionOptions = {
      supportBigNumbers: true,
      jsonStrings: true,
      namedPlaceholders: false,
      trace: false,
      ...parsedOptions,
      connectionLimit: parsedOptions.connectionLimit ?? this.config.connectionLimit,
      connectTimeout: parsedOptions.connectTimeout ?? this.config.connectTimeout,
      typeCast,
    };
    if (this.config.connectionLimitExplicit) options.connectionLimit = this.config.connectionLimit;
    if (this.config.connectTimeoutExplicit) options.connectTimeout = this.config.connectTimeout;

    const pool = createPool(options);
    pool.on('connection', (connection) => {
      connection.query(
        `SET SESSION TRANSACTION ISOLATION LEVEL ${this.config.transactionIsolationLevel}`,
      );
    });

    try {
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT VERSION() AS version, DATABASE() AS databaseName',
      );
      const first = rows[0] as { version?: string; databaseName?: string | null } | undefined;
      this.serverVersion = first?.version ?? null;
      this.databaseName = first?.databaseName ?? null;
      this.pool = pool;
      this.ready = true;
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  public async close(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    this.ready = false;
    if (pool) await pool.end();
  }

  public query(sql: string, parameters: readonly unknown[] = []): Promise<DriverResult> {
    return this.guard(runQuery(this.requirePool(), sql, parameters, false));
  }

  public execute(sql: string, parameters: readonly unknown[] = []): Promise<DriverResult> {
    return this.guard(runQuery(this.requirePool(), sql, parameters, true));
  }

  public async acquire(): Promise<DatabaseConnection> {
    try {
      return new MySqlConnection(
        await this.requirePool().getConnection(),
        (error) => this.reportFatalError(error),
      );
    } catch (error) {
      if (isFatalDatabaseError(error)) this.reportFatalError(error);
      throw error;
    }
  }

  public async healthCheck(): Promise<void> {
    await this.guard(this.requirePool().query('SELECT 1').then(() => undefined));
  }

  public getPoolStatus(): PoolStatus {
    const internal = this.pool as unknown as {
      pool?: {
        _allConnections?: { length?: number; size?: number };
        _freeConnections?: { length?: number; size?: number };
        _connectionQueue?: { length?: number; size?: number };
      };
    } | null;
    const pool = internal?.pool;
    const size = (value: { length?: number; size?: number } | undefined): number =>
      value?.length ?? value?.size ?? 0;
    const total = size(pool?._allConnections);
    const free = size(pool?._freeConnections);
    return {
      total,
      free,
      acquired: Math.max(0, total - free),
      queued: size(pool?._connectionQueue),
    };
  }

  public onFatalError(listener: (error: unknown) => void): void {
    this.fatalErrorListener = listener;
  }

  private requirePool(): Pool {
    if (!this.pool || !this.ready) throw new Error('Database connection is not ready.');
    return this.pool;
  }

  private async guard<T>(operation: Promise<T>): Promise<T> {
    try {
      return await operation;
    } catch (error) {
      if (isFatalDatabaseError(error)) this.reportFatalError(error);
      throw error;
    }
  }

  private reportFatalError(error: unknown): void {
    this.ready = false;
    this.fatalErrorListener?.(error);
  }
}
