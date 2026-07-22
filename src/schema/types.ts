export type ColumnType =
  | 'tinyint'
  | 'smallint'
  | 'mediumint'
  | 'int'
  | 'bigint'
  | 'decimal'
  | 'float'
  | 'double'
  | 'boolean'
  | 'char'
  | 'varchar'
  | 'tinytext'
  | 'text'
  | 'mediumtext'
  | 'longtext'
  | 'binary'
  | 'varbinary'
  | 'tinyblob'
  | 'blob'
  | 'mediumblob'
  | 'longblob'
  | 'date'
  | 'datetime'
  | 'timestamp'
  | 'time'
  | 'year'
  | 'json'
  | 'enum';

export type DefaultExpression =
  | 'CURRENT_TIMESTAMP'
  | 'CURRENT_TIMESTAMP(1)'
  | 'CURRENT_TIMESTAMP(2)'
  | 'CURRENT_TIMESTAMP(3)'
  | 'CURRENT_TIMESTAMP(4)'
  | 'CURRENT_TIMESTAMP(5)'
  | 'CURRENT_TIMESTAMP(6)';

export interface ColumnDefinition {
  type: ColumnType;
  length?: number;
  precision?: number;
  scale?: number;
  values?: string[];
  unsigned?: boolean;
  nullable?: boolean;
  default?: string | number | boolean | null;
  defaultExpression?: DefaultExpression;
  autoIncrement?: boolean;
  primary?: boolean;
  onUpdateCurrentTimestamp?: boolean;
  comment?: string;
}

export interface IndexDefinition {
  name: string;
  columns: string[];
  unique?: boolean;
  fulltext?: boolean;
}

export interface ForeignKeyDefinition {
  name: string;
  columns: string[];
  references: {
    table: string;
    columns: string[];
  };
  onDelete?: 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'NO ACTION';
  onUpdate?: 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'NO ACTION';
}

export interface TableDefinition {
  columns: Record<string, ColumnDefinition>;
  primaryKey?: string[];
  indexes?: IndexDefinition[];
  foreignKeys?: ForeignKeyDefinition[];
  engine?: 'InnoDB';
  charset?: 'utf8mb4';
  collation?: string;
}

export type MigrationOperation =
  | { type: 'renameTable'; from: string; to: string }
  | { type: 'renameColumn'; table: string; from: string; to: string }
  | { type: 'dropTable'; table: string; allowDataLoss: true }
  | { type: 'dropColumn'; table: string; column: string; allowDataLoss: true }
  | { type: 'addColumn'; table: string; column: string; definition: ColumnDefinition }
  | {
      type: 'alterColumn';
      table: string;
      column: string;
      definition: ColumnDefinition;
      allowDataLoss?: boolean;
    }
  | { type: 'addIndex'; table: string; definition: IndexDefinition }
  | { type: 'dropIndex'; table: string; index: string }
  | { type: 'sql'; sql: string; allowDataLoss: true };

export interface MigrationDefinition {
  version: number;
  name: string;
  operations: MigrationOperation[];
}

export interface ResourceSchema {
  version: number;
  tables: Record<string, TableDefinition>;
  migrations?: MigrationDefinition[];
}

export interface ActualColumn {
  name: string;
  type: string;
  columnType: string;
  nullable: boolean;
  defaultValue: string | number | null;
  extra: string;
  maximumLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  comment: string;
}

export interface ActualIndex {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  indexType: string;
}

export interface ActualForeignKey {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete: string;
  onUpdate: string;
}

export interface ActualTable {
  name: string;
  engine: string;
  collation: string | null;
  columns: Map<string, ActualColumn>;
  indexes: Map<string, ActualIndex>;
  foreignKeys: Map<string, ActualForeignKey>;
}

export interface SchemaAction {
  kind: string;
  sql: string;
  safe: boolean;
  reason: string;
  table?: string;
}

export interface SchemaPlan {
  resource: string;
  version: number;
  actions: SchemaAction[];
  warnings: string[];
}

export interface SchemaEnsureResult extends SchemaPlan {
  checksum: string;
  dryRun: boolean;
  appliedActions: string[];
  appliedMigrations: number[];
}
