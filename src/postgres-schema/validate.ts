import { stableChecksum } from '../schema/validate.js';
import type {
  PostgresCheckDefinition,
  PostgresColumnDefinition,
  PostgresColumnType,
  PostgresForeignKeyDefinition,
  PostgresIndexDefinition,
  PostgresMigrationDefinition,
  PostgresMigrationOperation,
  PostgresResourceSchema,
  PostgresTableDefinition,
} from './types.js';

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const columnTypes = new Set<PostgresColumnType>([
  'smallint',
  'integer',
  'int',
  'bigint',
  'numeric',
  'decimal',
  'real',
  'double',
  'boolean',
  'char',
  'varchar',
  'text',
  'bytea',
  'date',
  'time',
  'timestamp',
  'timestamptz',
  'uuid',
  'json',
  'jsonb',
  'inet',
  'cidr',
]);
const integerTypes = new Set<PostgresColumnType>(['smallint', 'integer', 'int', 'bigint']);
const defaultExpressions = new Set([
  'CURRENT_TIMESTAMP',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'gen_random_uuid()',
]);

function rejectFields(
  value: object,
  fields: readonly string[],
  label: string,
): void {
  for (const field of fields) {
    if (Object.hasOwn(value, field)) {
      throw new Error(`${label} cannot define MySQL-only field '${field}'.`);
    }
  }
}

export function assertPostgresIdentifier(identifier: string, label = 'identifier'): void {
  if (
    typeof identifier !== 'string' ||
    !identifierPattern.test(identifier) ||
    Buffer.byteLength(identifier, 'utf8') > 63
  ) {
    throw new Error(
      `Invalid ${label} '${String(identifier)}'. Use at most 63 bytes of letters, numbers, and underscores.`,
    );
  }
}

function orderedArray<T>(value: unknown, label: string): T[] {
  if (Array.isArray(value)) return [...value] as T[];
  if (!value || typeof value !== 'object') throw new Error(`${label} must be an array.`);
  const entries = Object.entries(value);
  if (!entries.every(([key]) => /^\d+$/.test(key))) throw new Error(`${label} must be an array.`);
  if (entries.length === 0) return [];
  const base = Object.hasOwn(value, '0') ? 0 : 1;
  const highest = Math.max(...entries.map(([key]) => Number(key)));
  return Array.from({ length: highest - base + 1 }, (_, index) =>
    (value as Record<string, T>)[String(index + base)]!,
  );
}

function sqlFragment(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.includes('\0') ||
    value.includes(';')
  ) {
    throw new Error(`${label} must be one SQL expression without a semicolon.`);
  }
  return value.trim();
}

function validateColumn(name: string, source: PostgresColumnDefinition): PostgresColumnDefinition {
  assertPostgresIdentifier(name, 'column name');
  if (!source || typeof source !== 'object') throw new Error(`Column '${name}' must be an object.`);
  rejectFields(
    source,
    ['unsigned', 'autoIncrement', 'onUpdateCurrentTimestamp', 'values'],
    `PostgreSQL column '${name}'`,
  );
  if (!columnTypes.has(source.type)) {
    throw new Error(`Column '${name}' has unsupported PostgreSQL type '${source.type}'.`);
  }
  const type = source.type === 'int'
    ? 'integer'
    : source.type === 'decimal'
      ? 'numeric'
      : source.type;
  const column = { ...source, type } as PostgresColumnDefinition;

  if (type === 'char' || type === 'varchar') {
    if (
      !Number.isInteger(column.length) ||
      (column.length ?? 0) < 1 ||
      (column.length ?? 0) > 10_485_760
    ) {
      throw new Error(`Column '${name}' requires a length between 1 and 10485760.`);
    }
  } else if (column.length !== undefined) {
    throw new Error(`Column '${name}' cannot define length for type '${type}'.`);
  }

  if (type === 'numeric') {
    if (
      !Number.isInteger(column.precision) ||
      (column.precision ?? 0) < 1 ||
      (column.precision ?? 0) > 1_000
    ) {
      throw new Error(`Numeric column '${name}' requires precision between 1 and 1000.`);
    }
    if (
      !Number.isInteger(column.scale) ||
      (column.scale ?? -1) < 0 ||
      (column.scale ?? 0) > (column.precision ?? 0)
    ) {
      throw new Error(`Numeric column '${name}' requires scale between 0 and precision.`);
    }
  } else if (column.precision !== undefined || column.scale !== undefined) {
    throw new Error(`Column '${name}' can only define precision/scale for numeric.`);
  }

  if (column.default !== undefined && column.defaultExpression !== undefined) {
    throw new Error(`Column '${name}' cannot define both default and defaultExpression.`);
  }
  if (
    column.defaultExpression !== undefined &&
    !defaultExpressions.has(column.defaultExpression)
  ) {
    throw new Error(`Column '${name}' has an unsupported default expression.`);
  }
  if (
    column.default !== undefined &&
    column.default !== null &&
    typeof column.default === 'object' &&
    type !== 'json' &&
    type !== 'jsonb'
  ) {
    throw new Error(`Object defaults are only supported for json/jsonb column '${name}'.`);
  }
  if (column.identity && !integerTypes.has(type)) {
    throw new Error(`Identity column '${name}' must use an integer type.`);
  }
  if (column.identity && column.nullable) {
    throw new Error(`Identity column '${name}' cannot be nullable.`);
  }
  if (column.comment !== undefined && typeof column.comment !== 'string') {
    throw new Error(`Column '${name}' comment must be a string.`);
  }
  return column;
}

function validateIndex(
  index: PostgresIndexDefinition,
  columns: Record<string, PostgresColumnDefinition>,
): PostgresIndexDefinition {
  assertPostgresIdentifier(index.name, 'index name');
  const indexColumns = orderedArray<string>(index.columns, `Index '${index.name}' columns`);
  if (indexColumns.length === 0) throw new Error(`Index '${index.name}' requires columns.`);
  for (const column of indexColumns) {
    assertPostgresIdentifier(column, `index '${index.name}' column`);
    if (!columns[column]) throw new Error(`Index '${index.name}' references missing column '${column}'.`);
  }
  const include = index.include
    ? orderedArray<string>(index.include, `Index '${index.name}' include`)
    : undefined;
  for (const column of include ?? []) {
    assertPostgresIdentifier(column, `index '${index.name}' include column`);
    if (!columns[column]) {
      throw new Error(`Index '${index.name}' includes missing column '${column}'.`);
    }
  }
  if (index.unique && index.method && index.method !== 'btree') {
    throw new Error(`Unique index '${index.name}' must use btree.`);
  }
  return {
    ...index,
    columns: indexColumns,
    ...(include ? { include } : {}),
    ...(index.where ? { where: sqlFragment(index.where, `Index '${index.name}' predicate`) } : {}),
  };
}

function validateCheck(check: PostgresCheckDefinition): PostgresCheckDefinition {
  assertPostgresIdentifier(check.name, 'check constraint name');
  return {
    name: check.name,
    expression: sqlFragment(check.expression, `Check '${check.name}' expression`),
  };
}

function validateForeignKey(
  foreignKey: PostgresForeignKeyDefinition,
  columns: Record<string, PostgresColumnDefinition>,
): PostgresForeignKeyDefinition {
  assertPostgresIdentifier(foreignKey.name, 'foreign key name');
  assertPostgresIdentifier(foreignKey.references?.table, `foreign key '${foreignKey.name}' table`);
  const local = orderedArray<string>(foreignKey.columns, `Foreign key '${foreignKey.name}' columns`);
  const referenced = orderedArray<string>(
    foreignKey.references?.columns,
    `Foreign key '${foreignKey.name}' referenced columns`,
  );
  if (local.length === 0 || local.length !== referenced.length) {
    throw new Error(`Foreign key '${foreignKey.name}' requires matching non-empty column lists.`);
  }
  for (const column of local) {
    assertPostgresIdentifier(column, `foreign key '${foreignKey.name}' column`);
    if (!columns[column]) {
      throw new Error(`Foreign key '${foreignKey.name}' references missing local column '${column}'.`);
    }
  }
  for (const column of referenced) {
    assertPostgresIdentifier(column, `foreign key '${foreignKey.name}' referenced column`);
  }
  if (foreignKey.initiallyDeferred && !foreignKey.deferrable) {
    throw new Error(`Foreign key '${foreignKey.name}' cannot be initially deferred unless deferrable.`);
  }
  return {
    ...foreignKey,
    columns: local,
    references: { table: foreignKey.references.table, columns: referenced },
  };
}

function validateTable(name: string, source: PostgresTableDefinition): PostgresTableDefinition {
  assertPostgresIdentifier(name, 'table name');
  if (!source || typeof source !== 'object' || !source.columns || typeof source.columns !== 'object') {
    throw new Error(`Table '${name}' must define columns.`);
  }
  rejectFields(
    source,
    ['engine', 'charset', 'collation'],
    `PostgreSQL table '${name}'`,
  );
  const columns = Object.fromEntries(
    Object.entries(source.columns).map(([column, definition]) => [
      column,
      validateColumn(column, definition),
    ]),
  );
  if (Object.keys(columns).length === 0) throw new Error(`Table '${name}' requires columns.`);

  const primaryKey = source.primaryKey
    ? orderedArray<string>(source.primaryKey, `Table '${name}' primary key`)
    : Object.entries(columns).filter(([, column]) => column.primary).map(([column]) => column);
  for (const column of primaryKey) {
    if (!columns[column]) throw new Error(`Table '${name}' primary key references '${column}'.`);
  }
  const indexes = orderedArray<PostgresIndexDefinition>(source.indexes ?? [], `Table '${name}' indexes`)
    .map((index) => validateIndex(index, columns));
  const checks = orderedArray<PostgresCheckDefinition>(source.checks ?? [], `Table '${name}' checks`)
    .map(validateCheck);
  const foreignKeys = orderedArray<PostgresForeignKeyDefinition>(
    source.foreignKeys ?? [],
    `Table '${name}' foreign keys`,
  ).map((foreignKey) => validateForeignKey(foreignKey, columns));
  const names = [...indexes, ...checks, ...foreignKeys].map((entry) => entry.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`Table '${name}' contains duplicate index or constraint names.`);
  }

  return {
    ...source,
    columns,
    ...(primaryKey.length > 0 ? { primaryKey } : {}),
    indexes,
    checks,
    foreignKeys,
  };
}

function validateOperation(operation: PostgresMigrationOperation): PostgresMigrationOperation {
  if (!operation || typeof operation !== 'object' || typeof operation.type !== 'string') {
    throw new Error('Migration operation must be an object with a type.');
  }
  const operationRecord = operation as unknown as Record<string, unknown>;
  for (const key of ['table', 'from', 'to', 'column', 'index', 'constraint'] as const) {
    if (typeof operationRecord[key] === 'string') {
      assertPostgresIdentifier(operationRecord[key] as string, `migration ${key}`);
    }
  }
  if ('definition' in operation) {
    if (operation.type === 'addColumn' || operation.type === 'alterColumn') {
      return {
        ...operation,
        definition: validateColumn(operation.column, operation.definition),
        ...(operation.type === 'alterColumn' && operation.using
          ? { using: sqlFragment(operation.using, 'ALTER COLUMN USING expression') }
          : {}),
      };
    }
    if (operation.type === 'addIndex') {
      // Column existence is checked against the final schema and at execution time.
      assertPostgresIdentifier(operation.definition.name, 'migration index name');
    } else if (operation.type === 'addCheck') {
      return { ...operation, definition: validateCheck(operation.definition) };
    } else if (operation.type === 'addForeignKey') {
      assertPostgresIdentifier(operation.definition.name, 'migration foreign key name');
    }
  }
  if (operation.type === 'sql') {
    if (typeof operation.sql !== 'string' || operation.sql.trim().length === 0) {
      throw new Error('Raw migration SQL cannot be empty.');
    }
  }
  return operation;
}

function validateMigrations(
  source: PostgresMigrationDefinition[] | undefined,
  version: number,
): PostgresMigrationDefinition[] {
  const migrations = orderedArray<PostgresMigrationDefinition>(source ?? [], 'Migrations')
    .map((migration) => ({
      ...migration,
      operations: orderedArray<PostgresMigrationOperation>(
        migration.operations,
        `Migration ${migration.version} operations`,
      ).map(validateOperation),
    }));
  const versions = migrations.map((migration) => migration.version);
  if (
    migrations.some(
      (migration) =>
        !Number.isInteger(migration.version) ||
        migration.version < 1 ||
        migration.version > version ||
        typeof migration.name !== 'string' ||
        migration.name.trim().length === 0 ||
        migration.operations.length === 0,
    ) ||
    new Set(versions).size !== versions.length
  ) {
    throw new Error('Migrations require unique integer versions within the schema version.');
  }
  return migrations.sort((left, right) => left.version - right.version);
}

export function validatePostgresSchema(input: PostgresResourceSchema): PostgresResourceSchema {
  if (!input || typeof input !== 'object') throw new Error('PostgreSQL schema must be an object.');
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new Error('PostgreSQL schema version must be a positive integer.');
  }
  if (!input.tables || typeof input.tables !== 'object') {
    throw new Error('PostgreSQL schema must define tables.');
  }
  const tables = Object.fromEntries(
    Object.entries(input.tables).map(([name, table]) => [name, validateTable(name, table)]),
  );
  return {
    version: input.version,
    tables,
    migrations: validateMigrations(input.migrations, input.version),
  };
}

export function postgresSchemaChecksum(schema: PostgresResourceSchema): string {
  return stableChecksum(schema);
}
