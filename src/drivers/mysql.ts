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
  FieldMetadata,
} from '../core/types.js';
import { serializeForRuntime } from '../core/serialize.js';

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

function fieldMetadata(fields?: readonly FieldPacket[]): FieldMetadata[] {
  if (!fields) return [];
  return fields.map((field) => {
    const metadata: FieldMetadata = { name: field.name };
    if (field.table) metadata.table = field.table;
    if (field.schema) metadata.schema = field.schema;
    if (field.columnType !== undefined) metadata.columnType = field.columnType;
    if (field.characterSet !== undefined) metadata.characterSet = field.characterSet;
    return metadata;
  });
}

function normalizeDriverResult(
  rows: RowDataPacket[] | RowDataPacket[][] | ResultSetHeader | ResultSetHeader[],
  fields?: readonly FieldPacket[],
): DriverResult {
  const header = !Array.isArray(rows) ? rows : null;
  return {
    rows: serializeForRuntime(rows),
    fields: fieldMetadata(fields),
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
  const [rows, fields] = prepared
    ? await executor.execute(sql, parameters)
    : await executor.query(sql, parameters);

  return normalizeDriverResult(
    rows as RowDataPacket[] | RowDataPacket[][] | ResultSetHeader | ResultSetHeader[],
    fields as FieldPacket[] | undefined,
  );
}

class MySqlConnection implements DatabaseConnection {
  public constructor(private readonly connection: PoolConnection) {}

  public query(sql: string, parameters: readonly unknown[] = []): Promise<DriverResult> {
    return runQuery(this.connection, sql, parameters, false);
  }

  public execute(sql: string, parameters: readonly unknown[] = []): Promise<DriverResult> {
    return runQuery(this.connection, sql, parameters, true);
  }

  public beginTransaction(): Promise<void> {
    return this.connection.beginTransaction();
  }

  public commit(): Promise<void> {
    return this.connection.commit();
  }

  public rollback(): Promise<void> {
    return this.connection.rollback();
  }

  public release(): void {
    this.connection.release();
  }
}

export class MySqlDriver implements DatabaseDriver {
  public readonly dialect = 'mysql' as const;
  public databaseName: string | null = null;
  public serverVersion: string | null = null;
  public ready = false;

  private pool: Pool | null = null;

  public constructor(private readonly config: QbxSqlConfig) {}

  public async connect(): Promise<void> {
    if (this.ready) return;

    const options: ConnectionOptions = {
      uri: this.config.connectionString,
      connectionLimit: this.config.connectionLimit,
      connectTimeout: this.config.connectTimeout,
      supportBigNumbers: true,
      jsonStrings: true,
      namedPlaceholders: false,
      trace: false,
      typeCast,
    };

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
    return runQuery(this.requirePool(), sql, parameters, false);
  }

  public execute(sql: string, parameters: readonly unknown[] = []): Promise<DriverResult> {
    return runQuery(this.requirePool(), sql, parameters, true);
  }

  public async acquire(): Promise<DatabaseConnection> {
    return new MySqlConnection(await this.requirePool().getConnection());
  }

  private requirePool(): Pool {
    if (!this.pool || !this.ready) throw new Error('Database connection is not ready.');
    return this.pool;
  }
}
