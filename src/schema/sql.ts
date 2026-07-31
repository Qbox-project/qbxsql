import { escape } from 'mysql2';
import type {
  ColumnDefinition,
  ForeignKeyDefinition,
  IndexDefinition,
  MigrationOperation,
  SchemaCapabilities,
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
    case 'addForeignKey':
      return addForeignKeySql(operation.table, operation.definition);
    case 'dropForeignKey':
      return `ALTER TABLE ${quoteIdentifier(operation.table)} DROP FOREIGN KEY ${quoteIdentifier(operation.foreignKey)}`;
    case 'setPrimaryKey':
      return `ALTER TABLE ${quoteIdentifier(operation.table)} DROP PRIMARY KEY, ADD PRIMARY KEY (${operation.columns.map(quoteIdentifier).join(', ')})`;
    case 'dropPrimaryKey':
      return `ALTER TABLE ${quoteIdentifier(operation.table)} DROP PRIMARY KEY`;
    case 'setTableOptions': {
      const options: string[] = [];
      if (operation.engine) options.push(`ENGINE=${operation.engine}`);
      if (operation.charset) options.push(`DEFAULT CHARACTER SET=${operation.charset}`);
      if (operation.collation) options.push(`COLLATE=${operation.collation}`);
      return `ALTER TABLE ${quoteIdentifier(operation.table)} ${options.join(' ')}`;
    }
    case 'releaseTable':
      return `-- release qbxsql ownership of ${quoteIdentifier(operation.table)}`;
    case 'sql':
      return operation.sql;
  }
}

const allOnlineCapabilities: SchemaCapabilities = {
  instantAddColumn: true,
  inplaceAlterColumn: true,
  inplaceAddIndex: true,
};

/**
 * Adds the strongest online-DDL hint InnoDB will actually accept.
 *
 * DROP COLUMN is only instant on MySQL 8.0.29+/MariaDB 10.4+, so it uses the
 * INPLACE rebuild that every supported server allows. Dropping a primary key on
 * its own is COPY-only in InnoDB and gets no hint at all: it cannot run online,
 * and requiresBlockingAuthorization already makes the operator approve it.
 */
export function onlineMigrationOperationSql(
  operation: MigrationOperation,
  capabilities: SchemaCapabilities = allOnlineCapabilities,
): string {
  const sql = migrationOperationSql(operation);
  switch (operation.type) {
    case 'addColumn':
      return capabilities.instantAddColumn ? `${sql}, ALGORITHM=INSTANT` : sql;
    case 'dropColumn':
      return capabilities.inplaceAlterColumn ? `${sql}, ALGORITHM=INPLACE, LOCK=NONE` : sql;
    case 'renameColumn':
    case 'alterColumn':
    case 'addForeignKey':
    case 'dropForeignKey':
    case 'setPrimaryKey':
      return capabilities.inplaceAlterColumn ? `${sql}, ALGORITHM=INPLACE, LOCK=NONE` : sql;
    case 'addIndex':
    case 'dropIndex':
      return capabilities.inplaceAddIndex ? `${sql}, ALGORITHM=INPLACE, LOCK=NONE` : sql;
    default:
      return sql;
  }
}
