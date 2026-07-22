export type SqlPrimitive = string | number | boolean | bigint | null | Date | Buffer;
export type SqlParameter = SqlPrimitive | readonly SqlPrimitive[] | Record<string, unknown>;
export type SqlParameters = readonly SqlParameter[] | Record<string, SqlParameter> | undefined;

export interface FieldMetadata {
  name: string;
  table?: string;
  schema?: string;
  columnType?: number;
  characterSet?: number;
}

export interface DriverResult {
  rows: unknown;
  fields: FieldMetadata[];
  affectedRows: number;
  changedRows: number;
  insertId: number | string;
  warningStatus: number;
}

export interface QueryOptions {
  invokingResource?: string;
  prepared?: boolean;
}

export interface DatabaseConnection {
  query(sql: string, parameters?: readonly unknown[]): Promise<DriverResult>;
  execute(sql: string, parameters?: readonly unknown[]): Promise<DriverResult>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface DatabaseDriver {
  readonly dialect: 'mysql' | 'postgresql';
  readonly databaseName: string | null;
  readonly serverVersion: string | null;
  readonly ready: boolean;

  connect(): Promise<void>;
  close(): Promise<void>;
  query(sql: string, parameters?: readonly unknown[]): Promise<DriverResult>;
  execute(sql: string, parameters?: readonly unknown[]): Promise<DriverResult>;
  acquire(): Promise<DatabaseConnection>;
}

export interface TransactionStatement {
  query: string;
  parameters?: SqlParameters;
}

