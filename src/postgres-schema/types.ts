export type PostgresColumnType =
  | 'smallint'
  | 'integer'
  | 'int'
  | 'bigint'
  | 'numeric'
  | 'decimal'
  | 'real'
  | 'double'
  | 'boolean'
  | 'char'
  | 'varchar'
  | 'text'
  | 'bytea'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'timestamptz'
  | 'uuid'
  | 'json'
  | 'jsonb'
  | 'inet'
  | 'cidr'
  | 'int4range'
  | 'int8range'
  | 'numrange'
  | 'tsrange'
  | 'tstzrange'
  | 'daterange'
  | 'geometry'
  | 'geography'
  | 'vector'
  | 'halfvec'
  | 'sparsevec';

export type PostgresDefaultExpression =
  | 'CURRENT_TIMESTAMP'
  | 'CURRENT_DATE'
  | 'CURRENT_TIME'
  | 'gen_random_uuid()';

export type PostgresSpatialSubtype =
  | 'geometry'
  | 'point'
  | 'linestring'
  | 'polygon'
  | 'multipoint'
  | 'multilinestring'
  | 'multipolygon'
  | 'geometrycollection';

export interface PostgresColumnDefinition {
  type: PostgresColumnType;
  length?: number;
  precision?: number;
  scale?: number;
  dimensions?: number;
  spatialType?: PostgresSpatialSubtype;
  srid?: number;
  nullable?: boolean;
  default?: unknown;
  defaultExpression?: PostgresDefaultExpression;
  identity?: 'always' | 'byDefault';
  primary?: boolean;
  comment?: string;
}

export interface PostgresExtensionRequirement {
  name: string;
  minimumVersion?: string;
}

export type PostgresExtensionState =
  | 'ready'
  | 'not-installed'
  | 'unavailable'
  | 'version-too-old';

export interface PostgresExtensionCheck extends PostgresExtensionRequirement {
  state: PostgresExtensionState;
  availableVersion: string | null;
  installedVersion: string | null;
  schema: string | null;
  message: string;
}

export interface PostgresExtensionReport {
  resource: string;
  satisfied: boolean;
  checkedAt: number;
  extensions: PostgresExtensionCheck[];
}

export interface PostgresIndexColumnDefinition {
  name: string;
  operatorClass?: string;
  order?: 'ASC' | 'DESC';
  nulls?: 'FIRST' | 'LAST';
}

export type PostgresIndexColumn = string | PostgresIndexColumnDefinition;
export type PostgresIndexOption = string | number | boolean;

export interface PostgresIndexDefinition {
  name: string;
  columns: PostgresIndexColumn[];
  unique?: boolean;
  method?: 'btree' | 'gin' | 'gist' | 'spgist' | 'brin' | 'hash' | 'hnsw' | 'ivfflat';
  include?: string[];
  options?: Record<string, PostgresIndexOption>;
  where?: string;
}

export interface PostgresCheckDefinition {
  name: string;
  expression: string;
}

export interface PostgresForeignKeyDefinition {
  name: string;
  columns: string[];
  references: {
    table: string;
    columns: string[];
  };
  onDelete?: 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'NO ACTION';
  onUpdate?: 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'NO ACTION';
  deferrable?: boolean;
  initiallyDeferred?: boolean;
}

export interface PostgresExclusionElementDefinition {
  column: string;
  operator: '=' | '<>' | '&&' | '&&&' | '<@' | '@>' | '-|-' | '&<' | '&>' | '<<' | '>>';
  operatorClass?: string;
}

export interface PostgresExclusionDefinition {
  name: string;
  method?: 'gist' | 'spgist';
  elements: PostgresExclusionElementDefinition[];
  where?: string;
  deferrable?: boolean;
  initiallyDeferred?: boolean;
}

export interface PostgresTableDefinition {
  columns: Record<string, PostgresColumnDefinition>;
  primaryKey?: string[];
  indexes?: PostgresIndexDefinition[];
  checks?: PostgresCheckDefinition[];
  foreignKeys?: PostgresForeignKeyDefinition[];
  exclusions?: PostgresExclusionDefinition[];
  comment?: string;
}

export type PostgresMigrationOperation =
  | { type: 'renameTable'; from: string; to: string }
  | { type: 'renameColumn'; table: string; from: string; to: string }
  | { type: 'dropTable'; table: string; allowDataLoss: true }
  | { type: 'dropColumn'; table: string; column: string; allowDataLoss: true }
  | {
      type: 'addColumn';
      table: string;
      column: string;
      definition: PostgresColumnDefinition;
    }
  | {
      type: 'alterColumn';
      table: string;
      column: string;
      definition: PostgresColumnDefinition;
      using?: string;
      allowDataLoss?: boolean;
    }
  | { type: 'addIndex'; table: string; definition: PostgresIndexDefinition }
  | { type: 'dropIndex'; table: string; index: string }
  | {
      type: 'addForeignKey';
      table: string;
      definition: PostgresForeignKeyDefinition;
    }
  | {
      type: 'addExclusion';
      table: string;
      definition: PostgresExclusionDefinition;
    }
  | { type: 'addCheck'; table: string; definition: PostgresCheckDefinition }
  | { type: 'dropConstraint'; table: string; constraint: string }
  | { type: 'validateConstraint'; table: string; constraint: string }
  | { type: 'setPrimaryKey'; table: string; columns: string[] }
  | { type: 'dropPrimaryKey'; table: string; constraint?: string }
  | { type: 'releaseTable'; table: string; allowOwnershipTransfer: true }
  | { type: 'sql'; sql: string; allowDataLoss: true };

export interface PostgresMigrationDefinition {
  version: number;
  name: string;
  operations: PostgresMigrationOperation[];
  allowBlocking?: boolean;
}

export interface PostgresResourceSchema {
  version: number;
  extensions?: PostgresExtensionRequirement[];
  tables: Record<string, PostgresTableDefinition>;
  migrations?: PostgresMigrationDefinition[];
}

export interface ActualPostgresColumn {
  name: string;
  formattedType: string;
  nullable: boolean;
  defaultExpression: string | null;
  identity: '' | 'a' | 'd';
  comment: string;
}

export interface ActualPostgresIndex {
  name: string;
  columns: string[];
  include: string[];
  unique: boolean;
  primary: boolean;
  valid: boolean;
  method: string;
  operatorClasses?: string[];
  /** Raw pg_index.indoption bits per key column: 0x1 DESC, 0x2 NULLS FIRST. */
  columnOptions?: number[];
  options?: Record<string, string>;
  predicate: string | null;
}

export interface ActualPostgresCheck {
  name: string;
  expression: string;
  validated: boolean;
}

export interface ActualPostgresForeignKey {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete: string;
  onUpdate: string;
  deferrable: boolean;
  initiallyDeferred: boolean;
  validated: boolean;
}

export interface ActualPostgresExclusion {
  name: string;
  definition: string;
  deferrable: boolean;
  initiallyDeferred: boolean;
}

export interface ActualPostgresTable {
  name: string;
  comment: string;
  columns: Map<string, ActualPostgresColumn>;
  indexes: Map<string, ActualPostgresIndex>;
  checks: Map<string, ActualPostgresCheck>;
  foreignKeys: Map<string, ActualPostgresForeignKey>;
  exclusions?: Map<string, ActualPostgresExclusion>;
  primaryKey: string[];
  primaryKeyName: string | null;
}

export interface PostgresSchemaAction {
  kind: string;
  sql: string;
  safe: boolean;
  dataSafe: boolean;
  onlineSafe: boolean;
  automatic: boolean;
  risk: 'low' | 'medium' | 'high';
  algorithm:
    | 'CREATE'
    | 'TRANSACTIONAL'
    | 'CONCURRENT'
    | 'NOT VALID'
    | 'VALIDATE'
    | 'MANUAL';
  reason: string;
  table?: string;
}

export interface PostgresSchemaPlan {
  resource: string;
  version: number;
  actions: PostgresSchemaAction[];
  warnings: string[];
  extensions?: PostgresExtensionReport;
}

export interface PostgresSchemaEnsureResult extends PostgresSchemaPlan {
  checksum: string;
  dryRun: boolean;
  appliedActions: string[];
  appliedMigrations: number[];
}

export interface PostgresSchemaAdoptionResult extends PostgresSchemaEnsureResult {
  adoption: true;
  baselineVersion: number;
}
