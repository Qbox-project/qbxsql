import {
  Pool,
  types as defaultTypes,
  type FieldDef,
  type PoolClient,
  type PoolConfig,
  type QueryResult,
} from 'pg';
import type { PostgresSqlConfig } from '../config.js';
import { normalizePostgresParameters } from '../core/postgres-parameters.js';
import { serializeForRuntime } from '../core/serialize.js';
import type {
  DatabaseConnection,
  DatabaseDriver,
  DriverResult,
  PoolStatus,
  SqlParameter,
  SqlParameters,
} from '../core/types.js';

const resourceName =
  typeof GetCurrentResourceName === 'function' ? GetCurrentResourceName() : 'qbxsql';
const enhancedServer = /(?:^|[\\/])cfx-server(?:\.exe)?$/i.test(process.execPath);

function scheduleResourceTick(): void {
  if (!enhancedServer && typeof ScheduleResourceTick === 'function') {
    ScheduleResourceTick(resourceName);
  }
}

const oid = {
  date: 1082,
  timestamp: 1114,
  timestamptz: 1184,
} as const;

const postgresTypes = {
  getTypeParser(typeId: number, format?: 'text' | 'binary') {
    if (format === 'binary') return defaultTypes.getTypeParser(typeId, format);
    if (typeId === oid.date) {
      return (value: string) => new Date(`${value}T00:00:00.000Z`);
    }
    if (typeId === oid.timestamp) {
      return (value: string) => new Date(`${value.replace(' ', 'T')}Z`);
    }
    if (typeId === oid.timestamptz) {
      return (value: string) => new Date(value);
    }
    return defaultTypes.getTypeParser(typeId, format);
  },
};

function fieldMetadata(fields: readonly FieldDef[]) {
  return fields.map((field) => ({
    name: field.name,
    columnType: field.dataTypeID,
  }));
}

function normalizeResult(result: QueryResult): DriverResult {
  return {
    rows: serializeForRuntime(result.rows),
    fields: fieldMetadata(result.fields),
    affectedRows: result.rowCount ?? 0,
    changedRows: result.rowCount ?? 0,
    insertId: null,
    warningStatus: null,
    hasResultSetHeader: false,
    command: result.command,
  };
}

async function runQuery(
  connection: Pool | PoolClient,
  sql: string,
  parameters: readonly unknown[],
): Promise<DriverResult> {
  scheduleResourceTick();
  return normalizeResult(await connection.query(sql, [...parameters]));
}

const fatalNetworkCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
]);
const fatalPostgresCodes = new Set(['57P01', '57P02', '57P03']);

export function isFatalPostgresError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === 'string' &&
    (fatalNetworkCodes.has(code) || fatalPostgresCodes.has(code) || code.startsWith('08'))
  );
}

class PostgresConnection implements DatabaseConnection {
  private closed = false;

  public constructor(
    private readonly client: PoolClient,
    private readonly isolationLevel: PostgresSqlConfig['transactionIsolationLevel'],
    private readonly reportFatalError: (error: unknown) => void,
  ) {}

  public query(sql: string, parameters: readonly unknown[] = []): Promise<DriverResult> {
    return this.guard(runQuery(this.client, sql, parameters));
  }

  public execute(sql: string, parameters: readonly unknown[] = []): Promise<DriverResult> {
    return this.query(sql, parameters);
  }

  public beginTransaction(): Promise<void> {
    const level =
      this.isolationLevel === 'READ UNCOMMITTED' ? 'READ COMMITTED' : this.isolationLevel;
    return this.guard(
      this.client.query(`BEGIN ISOLATION LEVEL ${level}`).then(() => undefined),
    );
  }

  public commit(): Promise<void> {
    return this.guard(this.client.query('COMMIT').then(() => undefined));
  }

  public rollback(): Promise<void> {
    return this.guard(this.client.query('ROLLBACK').then(() => undefined));
  }

  public release(): void {
    if (this.closed) return;
    this.closed = true;
    this.client.release();
  }

  public destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.client.release(true);
  }

  private async guard<T>(operation: Promise<T>): Promise<T> {
    try {
      return await operation;
    } catch (error) {
      if (isFatalPostgresError(error)) this.reportFatalError(error);
      throw error;
    }
  }
}

export class PostgresDriver implements DatabaseDriver {
  public readonly dialect = 'postgresql' as const;
  public databaseName: string | null = null;
  public serverVersion: string | null = null;
  public ready = false;
  public readonly namedPlaceholders = false;

  private pool: Pool | null = null;
  private fatalErrorListener: ((error: unknown) => void) | null = null;

  public constructor(private readonly config: PostgresSqlConfig) {}

  public normalizeParameters(
    sql: string,
    parameters?: SqlParameters,
  ): [query: string, parameters: SqlParameter[]] {
    return normalizePostgresParameters(sql, parameters);
  }

  public async connect(): Promise<void> {
    if (this.ready) return;

    const options: PoolConfig = {
      connectionString: this.config.connectionString,
      max: this.config.connectionLimit,
      connectionTimeoutMillis: this.config.connectTimeout,
      application_name: resourceName,
      keepAlive: true,
      options: '-c search_path=public,pg_catalog',
      types: postgresTypes,
    };
    const pool = new Pool(options);
    pool.on('error', (error) => this.reportFatalError(error));

    try {
      const result = await pool.query<{
        serverVersion: string;
        serverVersionNumber: string;
        databaseName: string;
      }>(
        `SELECT current_setting('server_version') AS "serverVersion",
                current_setting('server_version_num') AS "serverVersionNumber",
                current_database() AS "databaseName"`,
      );
      const first = result.rows[0];
      const serverVersionNumber = Number.parseInt(first?.serverVersionNumber ?? '0', 10);
      if (
        !Number.isSafeInteger(serverVersionNumber) ||
        serverVersionNumber < this.config.minimumServerVersion
      ) {
        throw new Error(
          `PostgreSQL 16 or newer is required; server reported ${first?.serverVersion ?? 'unknown'}.`,
        );
      }

      this.serverVersion = first?.serverVersion ?? null;
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
    return this.guard(runQuery(this.requirePool(), sql, parameters));
  }

  public execute(sql: string, parameters: readonly unknown[] = []): Promise<DriverResult> {
    return this.query(sql, parameters);
  }

  public async acquire(): Promise<DatabaseConnection> {
    try {
      return new PostgresConnection(
        await this.requirePool().connect(),
        this.config.transactionIsolationLevel,
        (error) => this.reportFatalError(error),
      );
    } catch (error) {
      if (isFatalPostgresError(error)) this.reportFatalError(error);
      throw error;
    }
  }

  public async healthCheck(): Promise<void> {
    await this.guard(this.requirePool().query('SELECT 1').then(() => undefined));
  }

  public getPoolStatus(): PoolStatus {
    const pool = this.pool;
    if (!pool) return { total: 0, free: 0, acquired: 0, queued: 0 };
    return {
      total: pool.totalCount,
      free: pool.idleCount,
      acquired: Math.max(0, pool.totalCount - pool.idleCount),
      queued: pool.waitingCount,
    };
  }

  public onFatalError(listener: (error: unknown) => void): void {
    this.fatalErrorListener = listener;
  }

  private requirePool(): Pool {
    if (!this.pool || !this.ready) throw new Error('PostgreSQL pool is not connected.');
    return this.pool;
  }

  private reportFatalError(error: unknown): void {
    this.fatalErrorListener?.(error);
  }

  private async guard<T>(operation: Promise<T>): Promise<T> {
    try {
      return await operation;
    } catch (error) {
      if (isFatalPostgresError(error)) this.reportFatalError(error);
      throw error;
    }
  }
}
