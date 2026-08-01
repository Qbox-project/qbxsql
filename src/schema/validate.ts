import { createHash } from 'node:crypto';
import type {
  ColumnDefinition,
  ColumnType,
  ForeignKeyDefinition,
  IndexDefinition,
  MigrationDefinition,
  MigrationOperation,
  ResourceSchema,
  TableDefinition,
} from './types.js';

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const columnTypes = new Set<ColumnType>([
  'tinyint',
  'smallint',
  'mediumint',
  'int',
  'bigint',
  'decimal',
  'float',
  'double',
  'boolean',
  'char',
  'varchar',
  'tinytext',
  'text',
  'mediumtext',
  'longtext',
  'binary',
  'varbinary',
  'tinyblob',
  'blob',
  'mediumblob',
  'longblob',
  'date',
  'datetime',
  'timestamp',
  'time',
  'year',
  'json',
  'enum',
]);
const integerTypes = new Set<ColumnType>(['tinyint', 'smallint', 'mediumint', 'int', 'bigint']);
const lengthTypes = new Set<ColumnType>(['char', 'varchar', 'binary', 'varbinary']);
const expressionPattern = /^CURRENT_TIMESTAMP(?:\([0-6]\))?$/;
// Engine, charset, and collation are interpolated into DDL without identifier
// quoting, so they are restricted to bare words the same way collation is.
const tableOptionPattern = /^[A-Za-z0-9_]+$/;
// InnoDB parses SET DEFAULT but rejects it, so it is deliberately excluded.
const referentialActions = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION'] as const;
type ReferentialAction = (typeof referentialActions)[number];

export function assertIdentifier(identifier: string, label = 'identifier'): void {
  if (!identifierPattern.test(identifier)) {
    throw new Error(`Invalid ${label} '${identifier}'. Use letters, numbers, and underscores only.`);
  }
}

function assertTableOption(value: unknown, label: string, subject: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || !tableOptionPattern.test(value)) {
    throw new Error(`${subject} has an invalid ${label}. Use letters, numbers, and underscores only.`);
  }
}

/**
 * Referential actions are interpolated into DDL verbatim, so only the canonical
 * spellings are accepted. The canonical form is written back to the definition
 * so generated SQL never contains caller-supplied text.
 */
function canonicalReferentialAction(
  value: unknown,
  subject: string,
): ReferentialAction | undefined {
  if (value === undefined || value === null) return undefined;
  const canonical =
    typeof value === 'string'
      ? referentialActions.find(
          (action) => action === value.trim().replace(/\s+/g, ' ').toUpperCase(),
        )
      : undefined;
  if (!canonical) throw new Error(`${subject} must be one of ${referentialActions.join(', ')}.`);
  return canonical;
}

function applyReferentialActions(foreignKey: ForeignKeyDefinition, subject: string): void {
  const onDelete = canonicalReferentialAction(foreignKey.onDelete, `${subject} onDelete`);
  const onUpdate = canonicalReferentialAction(foreignKey.onUpdate, `${subject} onUpdate`);
  if (onDelete === undefined) delete foreignKey.onDelete;
  else foreignKey.onDelete = onDelete;
  if (onUpdate === undefined) delete foreignKey.onUpdate;
  else foreignKey.onUpdate = onUpdate;
}

function validateColumn(name: string, column: ColumnDefinition): void {
  assertIdentifier(name, 'column name');
  if (!column || typeof column !== 'object') throw new Error(`Column '${name}' must be an object.`);
  if (!columnTypes.has(column.type)) throw new Error(`Column '${name}' has unsupported type '${column.type}'.`);

  if (lengthTypes.has(column.type)) {
    if (!Number.isInteger(column.length) || (column.length ?? 0) < 1 || (column.length ?? 0) > 65_535) {
      throw new Error(`Column '${name}' requires a length between 1 and 65535.`);
    }
  }

  if (column.type === 'decimal') {
    if (!Number.isInteger(column.precision) || (column.precision ?? 0) < 1 || (column.precision ?? 0) > 65) {
      throw new Error(`Decimal column '${name}' requires precision between 1 and 65.`);
    }
    if (!Number.isInteger(column.scale) || (column.scale ?? -1) < 0 || (column.scale ?? 0) > 30) {
      throw new Error(`Decimal column '${name}' requires scale between 0 and 30.`);
    }
    if ((column.scale ?? 0) > (column.precision ?? 0)) {
      throw new Error(`Decimal column '${name}' cannot have scale greater than precision.`);
    }
  }

  if (column.type === 'enum') {
    if (!Array.isArray(column.values) || column.values.length === 0) {
      throw new Error(`Enum column '${name}' requires at least one value.`);
    }
    if (new Set(column.values).size !== column.values.length) {
      throw new Error(`Enum column '${name}' contains duplicate values.`);
    }
  }

  if (column.unsigned && !integerTypes.has(column.type) && !['decimal', 'float', 'double'].includes(column.type)) {
    throw new Error(`Column '${name}' cannot be unsigned because it is ${column.type}.`);
  }
  if (column.autoIncrement && !integerTypes.has(column.type)) {
    throw new Error(`Auto-increment column '${name}' must use an integer type.`);
  }
  if (column.autoIncrement && column.nullable) {
    throw new Error(`Auto-increment column '${name}' cannot be nullable.`);
  }
  if (column.default !== undefined && column.defaultExpression !== undefined) {
    throw new Error(`Column '${name}' cannot define both default and defaultExpression.`);
  }
  if (column.defaultExpression && !expressionPattern.test(column.defaultExpression)) {
    throw new Error(`Column '${name}' has an unsafe default expression.`);
  }
  if (column.onUpdateCurrentTimestamp && !['datetime', 'timestamp'].includes(column.type)) {
    throw new Error(`Column '${name}' can only use onUpdateCurrentTimestamp with datetime or timestamp.`);
  }
}

function validateIndex(tableName: string, table: TableDefinition, index: IndexDefinition): void {
  assertIdentifier(index.name, 'index name');
  if (!Array.isArray(index.columns) || index.columns.length === 0) {
    throw new Error(`Index '${index.name}' on '${tableName}' requires columns.`);
  }
  for (const column of index.columns) {
    if (!table.columns[column]) throw new Error(`Index '${index.name}' references missing column '${column}'.`);
  }
  if (index.unique && index.fulltext) {
    throw new Error(`Index '${index.name}' cannot be both unique and fulltext.`);
  }
}

function validateForeignKey(
  tableName: string,
  table: TableDefinition,
  foreignKey: ForeignKeyDefinition,
): void {
  assertIdentifier(foreignKey.name, 'foreign key name');
  assertIdentifier(foreignKey.references.table, 'referenced table name');
  if (
    !Array.isArray(foreignKey.columns) ||
    foreignKey.columns.length === 0 ||
    foreignKey.columns.length !== foreignKey.references.columns.length
  ) {
    throw new Error(`Foreign key '${foreignKey.name}' on '${tableName}' has mismatched columns.`);
  }
  for (const column of foreignKey.columns) {
    if (!table.columns[column]) {
      throw new Error(`Foreign key '${foreignKey.name}' references missing local column '${column}'.`);
    }
  }
  for (const column of foreignKey.references.columns) assertIdentifier(column, 'referenced column name');
  applyReferentialActions(foreignKey, `Foreign key '${foreignKey.name}' on '${tableName}'`);
}

function validateTable(name: string, table: TableDefinition): void {
  assertIdentifier(name, 'table name');
  if (name.startsWith('qbxsql_')) throw new Error(`Table '${name}' uses qbxsql's reserved prefix.`);
  if (!table || typeof table !== 'object' || !table.columns || Object.keys(table.columns).length === 0) {
    throw new Error(`Table '${name}' requires at least one column.`);
  }

  for (const [columnName, column] of Object.entries(table.columns)) validateColumn(columnName, column);
  for (const column of table.primaryKey ?? []) {
    if (!table.columns[column]) throw new Error(`Primary key on '${name}' references missing column '${column}'.`);
  }
  for (const [columnName, column] of Object.entries(table.columns)) {
    if (column.primary && table.primaryKey && !table.primaryKey.includes(columnName)) {
      throw new Error(`Column '${columnName}' conflicts with the table-level primary key.`);
    }
  }
  for (const index of table.indexes ?? []) validateIndex(name, table, index);
  for (const foreignKey of table.foreignKeys ?? []) validateForeignKey(name, table, foreignKey);
  assertTableOption(table.engine, 'engine', `Table '${name}'`);
  assertTableOption(table.charset, 'charset', `Table '${name}'`);
  assertTableOption(table.collation, 'collation', `Table '${name}'`);
}

function validateMigrationOperation(operation: MigrationOperation): void {
  switch (operation.type) {
    case 'renameTable':
      assertIdentifier(operation.from, 'source table name');
      assertIdentifier(operation.to, 'target table name');
      break;
    case 'renameColumn':
      assertIdentifier(operation.table, 'table name');
      assertIdentifier(operation.from, 'source column name');
      assertIdentifier(operation.to, 'target column name');
      break;
    case 'dropTable':
      assertIdentifier(operation.table, 'table name');
      if (operation.allowDataLoss !== true) throw new Error('dropTable requires allowDataLoss=true.');
      break;
    case 'dropColumn':
      assertIdentifier(operation.table, 'table name');
      assertIdentifier(operation.column, 'column name');
      if (operation.allowDataLoss !== true) throw new Error('dropColumn requires allowDataLoss=true.');
      break;
    case 'addColumn':
    case 'alterColumn':
      assertIdentifier(operation.table, 'table name');
      assertIdentifier(operation.column, 'column name');
      validateColumn(operation.column, operation.definition);
      break;
    case 'addIndex':
      assertIdentifier(operation.table, 'table name');
      assertIdentifier(operation.definition.name, 'index name');
      for (const column of operation.definition.columns) assertIdentifier(column, 'index column name');
      break;
    case 'dropIndex':
      assertIdentifier(operation.table, 'table name');
      assertIdentifier(operation.index, 'index name');
      break;
    case 'addForeignKey':
      assertIdentifier(operation.table, 'table name');
      assertIdentifier(operation.definition.name, 'foreign key name');
      assertIdentifier(operation.definition.references.table, 'referenced table name');
      if (
        !Array.isArray(operation.definition.columns) ||
        operation.definition.columns.length === 0 ||
        operation.definition.columns.length !== operation.definition.references.columns.length
      ) {
        throw new Error(`Foreign key '${operation.definition.name}' has mismatched columns.`);
      }
      for (const column of operation.definition.columns) assertIdentifier(column, 'foreign key column');
      for (const column of operation.definition.references.columns) {
        assertIdentifier(column, 'referenced column name');
      }
      applyReferentialActions(
        operation.definition,
        `Foreign key '${operation.definition.name}'`,
      );
      break;
    case 'dropForeignKey':
      assertIdentifier(operation.table, 'table name');
      assertIdentifier(operation.foreignKey, 'foreign key name');
      break;
    case 'setPrimaryKey':
      assertIdentifier(operation.table, 'table name');
      if (!Array.isArray(operation.columns) || operation.columns.length === 0) {
        throw new Error('setPrimaryKey requires at least one column.');
      }
      for (const column of operation.columns) assertIdentifier(column, 'primary key column');
      break;
    case 'dropPrimaryKey':
      assertIdentifier(operation.table, 'table name');
      break;
    case 'setTableOptions':
      assertIdentifier(operation.table, 'table name');
      if (!operation.engine && !operation.charset && !operation.collation) {
        throw new Error('setTableOptions requires engine, charset, or collation.');
      }
      assertTableOption(operation.engine, 'engine', 'setTableOptions');
      assertTableOption(operation.charset, 'charset', 'setTableOptions');
      assertTableOption(operation.collation, 'collation', 'setTableOptions');
      break;
    case 'releaseTable':
      assertIdentifier(operation.table, 'table name');
      if (operation.allowOwnershipTransfer !== true) {
        throw new Error('releaseTable requires allowOwnershipTransfer=true.');
      }
      break;
    case 'sql':
      if (!operation.sql.trim()) throw new Error('Raw SQL migration cannot be empty.');
      if (operation.allowDataLoss !== true) throw new Error('Raw SQL migration requires allowDataLoss=true.');
      // Raw SQL cannot be ownership-checked, but the connector's own journal
      // and ownership tables are never a legitimate target.
      if (/qbxsql_schema_/i.test(operation.sql)) {
        throw new Error('Raw SQL migrations may not reference qbxsql metadata tables.');
      }
      break;
  }
}

function validateMigrations(migrations: MigrationDefinition[]): void {
  // Spreading a malformed value here would throw a bare TypeError that says
  // nothing about which part of the schema is wrong.
  if (!Array.isArray(migrations)) throw new Error('Schema migrations must be an array.');
  let previousVersion = 0;
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (!migration || typeof migration !== 'object') {
      throw new Error('Each schema migration must be an object.');
    }
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new Error('Migration versions must be positive integers.');
    }
    if (migration.version === previousVersion) throw new Error(`Duplicate migration version ${migration.version}.`);
    if (!migration.name?.trim()) throw new Error(`Migration ${migration.version} requires a name.`);
    if (migration.allowBlocking !== undefined && typeof migration.allowBlocking !== 'boolean') {
      throw new Error(`Migration ${migration.version} allowBlocking must be a boolean.`);
    }
    if (!Array.isArray(migration.operations) || migration.operations.length === 0) {
      throw new Error(`Migration ${migration.version} requires at least one operation.`);
    }
    for (const operation of migration.operations) validateMigrationOperation(operation);
    previousVersion = migration.version;
  }
}

export function validateSchema(schema: ResourceSchema): ResourceSchema {
  if (!schema || typeof schema !== 'object') throw new TypeError('Schema must be an object.');
  if (!Number.isInteger(schema.version) || schema.version < 1) {
    throw new Error('Schema version must be a positive integer.');
  }
  if (!schema.tables || typeof schema.tables !== 'object') throw new Error('Schema requires a tables object.');
  for (const [name, table] of Object.entries(schema.tables)) validateTable(name, table);
  validateMigrations(schema.migrations ?? []);
  if ((schema.migrations ?? []).some((migration) => migration.version > schema.version)) {
    throw new Error('Migration version cannot exceed the schema version.');
  }
  return schema;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function stableChecksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

export function schemaChecksum(schema: ResourceSchema): string {
  return stableChecksum(schema);
}
