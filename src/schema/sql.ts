import { escape } from 'mysql2';
import type {
  ColumnDefinition,
  ForeignKeyDefinition,
  IndexDefinition,
  MigrationOperation,
  TableDefinition,
} from './types.js';
import { assertIdentifier } from './validate.js';

export function quoteIdentifier(identifier: string): string {
  assertIdentifier(identifier);
  return `\`${identifier}\``;
}

function sqlType(column: ColumnDefinition): string {
  switch (column.type) {
    case 'boolean':
      return 'TINYINT(1)';
    case 'char':
    case 'varchar':
    case 'binary':
    case 'varbinary':
      return `${column.type.toUpperCase()}(${column.length})`;
    case 'decimal':
      return `DECIMAL(${column.precision},${column.scale})`;
    case 'enum':
      return `ENUM(${column.values!.map((value) => escape(value)).join(', ')})`;
    default:
      return column.type.toUpperCase();
  }
}

export function columnSql(name: string, column: ColumnDefinition): string {
  const parts = [quoteIdentifier(name), sqlType(column)];
  if (column.unsigned) parts.push('UNSIGNED');
  parts.push(column.nullable ? 'NULL' : 'NOT NULL');

  if (column.defaultExpression !== undefined) parts.push(`DEFAULT ${column.defaultExpression}`);
  else if (column.default !== undefined) {
    if (column.default === null) parts.push('DEFAULT NULL');
    else if (typeof column.default === 'boolean') parts.push(`DEFAULT ${column.default ? 1 : 0}`);
    else parts.push(`DEFAULT ${escape(column.default)}`);
  }

  if (column.autoIncrement) parts.push('AUTO_INCREMENT');
  if (column.onUpdateCurrentTimestamp) parts.push('ON UPDATE CURRENT_TIMESTAMP');
  if (column.comment) parts.push(`COMMENT ${escape(column.comment)}`);
  return parts.join(' ');
}

function primaryColumns(table: TableDefinition): string[] {
  const inline = Object.entries(table.columns)
    .filter(([, column]) => column.primary)
    .map(([name]) => name);
  return table.primaryKey ?? inline;
}

export function indexSql(index: IndexDefinition): string {
  const prefix = index.fulltext ? 'FULLTEXT KEY' : index.unique ? 'UNIQUE KEY' : 'KEY';
  return `${prefix} ${quoteIdentifier(index.name)} (${index.columns.map(quoteIdentifier).join(', ')})`;
}

export function foreignKeySql(foreignKey: ForeignKeyDefinition): string {
  const parts = [
    `CONSTRAINT ${quoteIdentifier(foreignKey.name)}`,
    `FOREIGN KEY (${foreignKey.columns.map(quoteIdentifier).join(', ')})`,
    `REFERENCES ${quoteIdentifier(foreignKey.references.table)} (${foreignKey.references.columns.map(quoteIdentifier).join(', ')})`,
  ];
  if (foreignKey.onDelete) parts.push(`ON DELETE ${foreignKey.onDelete}`);
  if (foreignKey.onUpdate) parts.push(`ON UPDATE ${foreignKey.onUpdate}`);
  return parts.join(' ');
}

export function createTableSql(
  name: string,
  table: TableDefinition,
  includeForeignKeys = false,
): string {
  const definitions = Object.entries(table.columns).map(([columnName, column]) =>
    columnSql(columnName, column),
  );
  const primary = primaryColumns(table);
  if (primary.length > 0) definitions.push(`PRIMARY KEY (${primary.map(quoteIdentifier).join(', ')})`);
  for (const index of table.indexes ?? []) definitions.push(indexSql(index));
  if (includeForeignKeys) {
    for (const foreignKey of table.foreignKeys ?? []) definitions.push(foreignKeySql(foreignKey));
  }

  return `CREATE TABLE ${quoteIdentifier(name)} (\n  ${definitions.join(',\n  ')}\n) ENGINE=${table.engine ?? 'InnoDB'} DEFAULT CHARSET=${table.charset ?? 'utf8mb4'}${table.collation ? ` COLLATE=${table.collation}` : ''}`;
}

export function addForeignKeySql(table: string, foreignKey: ForeignKeyDefinition): string {
  return `ALTER TABLE ${quoteIdentifier(table)} ADD ${foreignKeySql(foreignKey)}`;
}

export function migrationOperationSql(operation: MigrationOperation): string {
  switch (operation.type) {
    case 'renameTable':
      return `RENAME TABLE ${quoteIdentifier(operation.from)} TO ${quoteIdentifier(operation.to)}`;
    case 'renameColumn':
      return `ALTER TABLE ${quoteIdentifier(operation.table)} RENAME COLUMN ${quoteIdentifier(operation.from)} TO ${quoteIdentifier(operation.to)}`;
    case 'dropTable':
      return `DROP TABLE IF EXISTS ${quoteIdentifier(operation.table)}`;
    case 'dropColumn':
      return `ALTER TABLE ${quoteIdentifier(operation.table)} DROP COLUMN ${quoteIdentifier(operation.column)}`;
    case 'addColumn':
      return `ALTER TABLE ${quoteIdentifier(operation.table)} ADD COLUMN ${columnSql(operation.column, operation.definition)}`;
    case 'alterColumn':
      return `ALTER TABLE ${quoteIdentifier(operation.table)} MODIFY COLUMN ${columnSql(operation.column, operation.definition)}`;
    case 'addIndex':
      return `ALTER TABLE ${quoteIdentifier(operation.table)} ADD ${indexSql(operation.definition)}`;
    case 'dropIndex':
      return `ALTER TABLE ${quoteIdentifier(operation.table)} DROP INDEX ${quoteIdentifier(operation.index)}`;
    case 'sql':
      return operation.sql;
  }
}
