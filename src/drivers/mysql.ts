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

const resourceName =
  typeof GetCurrentResourceName === 'function' ? GetCurrentResourceName() : 'qbxsql';
// Enhanced runs script resources at the server tick rate and deprecates this native.
const enhancedServer = /(?:^|[\\/])cfx-server(?:\.exe)?$/i.test(process.execPath);

function scheduleResourceTick(): void {
  if (!enhancedServer && typeof ScheduleResourceTick === 'function') {
    ScheduleResourceTick(resourceName);
  }
}

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

function jsonOption(value: string, key: 'dateStrings' | 'flags'): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Connection-string option '${key}' must be valid JSON.`);
  }

  if (
    key === 'flags' &&
    (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string'))
  ) {
    throw new Error("Connection-string option 'flags' must be a JSON array of strings.");
  }
  if (
    key === 'dateStrings' &&
    typeof parsed !== 'boolean' &&
    typeof parsed !== 'string' &&
    (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string'))
  ) {
    throw new Error(
      "Connection-string option 'dateStrings' must be a boolean, string, or JSON array of strings.",
    );
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

const integerConnectionOptions: Record<string, { name: string; minimum: number }> = {
  connectionlimit: { name: 'connectionLimit', minimum: 1 },
  connecttimeout: { name: 'connectTimeout', minimum: 1 },
  queuelimit: { name: 'queueLimit', minimum: 0 },
  maxidle: { name: 'maxIdle', minimum: 0 },
  idletimeout: { name: 'idleTimeout', minimum: 1 },
  keepaliveinitialdelay: { name: 'keepAliveInitialDelay', minimum: 0 },
};

const booleanConnectionOptions: Record<string, string> = {
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

function normalizeOptionKey(key: string): string {
  return key.toLowerCase().replace(/[ _-]/g, '');
}

function applyConnectionOption(
  options: Record<string, unknown>,
  normalized: string,
  value: string,
  sourceKey: string,
  warn: (message: string) => void,
): void {
  const integer = integerConnectionOptions[normalized];
  const boolean = booleanConnectionOptions[normalized];
  if (integer) {
    options[integer.name] = integerOption(value, integer.name, integer.minimum);
  } else if (boolean) {
    options[boolean] = booleanOption(value, boolean);
    if (boolean === 'multipleStatements') warnMultipleStatements(options[boolean] as boolean, warn);
  } else if (normalized === 'charset' || normalized === 'timezone' || normalized === 'socketpath') {
    options[normalized === 'socketpath' ? 'socketPath' : normalized] = value;
  } else if (normalized === 'flags' || normalized === 'datestrings') {
    const key = normalized === 'flags' ? 'flags' : 'dateStrings';
    options[key] = jsonOption(value, key);
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
      applyConnectionOption(options, normalizeOptionKey(sourceKey), value, sourceKey, warn);
    }
    return options as ConnectionOptions;
  }

  const options: Record<string, unknown> = {};
  for (const segment of connectionString.split(';')) {
    if (!segment.trim()) continue;
    const separator = segment.indexOf('=');
    if (separator === -1) throw new Error('Invalid connection-string segment; expected key=value.');
    const sourceKey = segment.slice(0, separator).trim();
    const normalized = normalizeOptionKey(sourceKey);
    const value = segment.slice(separator + 1).trim();

    if (['host', 'hostname', 'ip', 'server', 'datasource', 'addr', 'address'].includes(normalized)) {
      options.host = value;
    } else if (['user', 'userid', 'username', 'uid'].includes(normalized)) {
      options.user = value;
    } else if (['password', 'pwd', 'pass'].includes(normalized)) {
      options.password = value;
    } else if (['database', 'db', 'initialcatalog'].includes(normalized)) {
      options.database = value;
    } else if (normalized === 'port') {
      options.port = integerOption(value, 'port', 1);
    } else {
      applyConnectionOption(options, normalized, value, sourceKey, warn);
    }
  }
  return options as ConnectionOptions;
}

export function typeCast(field: TypeCastField, next: TypeCastNext): unknown {
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
    case 'TINY':
      return field.length === 1 ? field.string() === '1' : next();
    case 'BIT': {
      const value = field.buffer();
      return field.length === 1 ? value?.[0] === 1 : value?.[0];
    }
    default:
      return next();
  }
}

export function typeCastExecute(field: TypeCastField, next: TypeCastNext): unknown {
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
    default:
      return next();
  }
}

const binaryCharset = 63;
const blobColumnTypes = new Set([249, 250, 251, 252]);

function replaceNullBinaryBlobs(rows: unknown, fields: FieldPacket[] | FieldPacket[][]): unknown {
  if (!Array.isArray(rows) || !Array.isArray(fields) || fields.length === 0) return rows;
  if (Array.isArray(fields[0])) {
    return rows.map((result, index) =>
      replaceNullBinaryBlobs(result, (fields as FieldPacket[][])[index] ?? []),
    );
  }

  const binaryBlobNames = (fields as FieldPacket[])
    .filter(
      (field) =>
        field.characterSet === binaryCharset &&
        blobColumnTypes.has(field.type ?? -1),
    )
    .map((field) => field.name);
  if (binaryBlobNames.length === 0) return rows;

  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const source = row as Record<string, unknown>;
    let result: Record<string, unknown> | null = null;
    for (const name of binaryBlobNames) {
      if (source[name] !== null) continue;
      result ??= { ...source };
      result[name] = [null];
    }
    return result ?? row;
  });
}

function normalizeDriverResult(
  rows: RowDataPacket[] | RowDataPacket[][] | ResultSetHeader | ResultSetHeader[],
  fields: FieldPacket[] | FieldPacket[][] = [],
  prepared: boolean,
): DriverResult {
  const header = !Array.isArray(rows) ? rows : null;
  const serializedRows = serializeForRuntime(rows);
  return {
    rows: prepared ? serializedRows : replaceNullBinaryBlobs(serializedRows, fields),
    fields: (Array.isArray(fields[0]) ? fields.flat() : fields as FieldPacket[]).map((field) => ({
      name: field.name,
      ...(field.table ? { table: field.table } : {}),
      ...(field.schema ? { schema: field.schema } : {}),
      ...(field.type === undefined ? {} : { columnType: field.type }),
      ...(field.characterSet === undefined ? {} : { characterSet: field.characterSet }),
    })),
    affectedRows: header?.affectedRows ?? null,
    changedRows: header?.changedRows ?? null,
    insertId: header?.insertId ?? null,
    warningStatus: header?.warningStatus ?? null,
    hasResultSetHeader: header !== null,
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
    execute(
      options: { sql: string; typeCast: typeof typeCastExecute },
      values: readonly unknown[],
    ): Promise<[unknown, FieldPacket[]]>;
  };
  scheduleResourceTick();
  const [rows, fields] = prepared
    ? await executor.execute({ sql, typeCast: typeCastExecute }, parameters)
    : await executor.query(sql, parameters);

  return normalizeDriverResult(
    rows as RowDataPacket[] | RowDataPacket[][] | ResultSetHeader | ResultSetHeader[],
    fields as FieldPacket[] | FieldPacket[][],
    prepared,
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
  public readonly isFatalError = isFatalDatabaseError;
  public readonly dialect = 'mysql' as const;
  public databaseName: string | null = null;
  public serverVersion: string | null = null;
  public ready = false;
  public readonly namedPlaceholders: boolean;

  private pool: Pool | null = null;
  private schemaPool: Pool | null = null;
  private fatalErrorListener: ((error: unknown) => void) | null = null;
  private readonly parsedOptions: ConnectionOptions;

  public constructor(private readonly config: QbxSqlConfig) {
    this.parsedOptions = parseMySqlConnectionString(config.connectionString);
    this.namedPlaceholders = this.parsedOptions.namedPlaceholders !== false;
  }

  public async connect(): Promise<void> {
    if (this.ready) return;

    const parsedOptions = this.parsedOptions;
    const options: ConnectionOptions = {
      supportBigNumbers: true,
      jsonStrings: true,
      trace: false,
      ...parsedOptions,
      namedPlaceholders: false,
      connectionLimit: parsedOptions.connectionLimit ?? this.config.connectionLimit,
      connectTimeout: parsedOptions.connectTimeout ?? this.config.connectTimeout,
      typeCast,
    };
    if (this.config.connectionLimitExplicit) options.connectionLimit = this.config.connectionLimit;
    if (this.config.connectTimeoutExplicit) options.connectTimeout = this.config.connectTimeout;

    const pool = createPool(options);
    const initializeConnection = (connection: unknown) => {
      // The event delivers the underlying callback-API connection. Without a
      // callback, a failure here would surface as an unhandled 'error' event;
      // with one, a connection whose isolation level could not be set is
      // discarded instead of serving queries at the wrong level.
      const raw = connection as unknown as {
        query(sql: string, callback: (error: unknown) => void): void;
        destroy(): void;
      };
      raw.query(
        `SET SESSION TRANSACTION ISOLATION LEVEL ${this.config.transactionIsolationLevel}`,
        (error: unknown) => {
          if (!error) return;
          console.error(
            '[qbxsql] failed to set the session transaction isolation level; discarding the connection',
            error,
          );
          raw.destroy();
        },
      );
    };
    pool.on('connection', initializeConnection);

    try {
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT VERSION() AS version, DATABASE() AS databaseName',
      );
      const first = rows[0] as { version?: string; databaseName?: string | null } | undefined;
      this.serverVersion = first?.version ?? null;
      this.databaseName = first?.databaseName ?? null;
      // Lock holders must leave query connections available for metadata,
      // introspection and foreign-key checks, even with connectionLimit=1.
      this.schemaPool = createPool({ ...options, connectionLimit: 1, maxIdle: 1 });
      this.schemaPool.on('connection', initializeConnection);
      this.pool = pool;
      this.ready = true;
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  public async close(): Promise<void> {
    const pool = this.pool;
    const schemaPool = this.schemaPool;
    this.pool = null;
    this.schemaPool = null;
    this.ready = false;
    await Promise.all([pool?.end(), schemaPool?.end()]);
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

  public async acquireSchemaConnection(): Promise<DatabaseConnection> {
    this.requirePool();
    const pool = this.schemaPool!;
    return this.guard(pool.getConnection().then((connection) =>
      new MySqlConnection(connection, (error) => this.reportFatalError(error)),
    ));
  }

  public getPoolStatus(): PoolStatus {
    const poolStatus = (value: Pool | null): PoolStatus => {
      const internal = value as unknown as {
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
    };
    const queries = poolStatus(this.pool);
    const schema = poolStatus(this.schemaPool);
    return {
      total: queries.total + schema.total,
      free: queries.free + schema.free,
      acquired: queries.acquired + schema.acquired,
      queued: queries.queued + schema.queued,
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
