import type {
  ActualColumn,
  ActualIndex,
  ActualTable,
  ColumnDefinition,
  ForeignKeyDefinition,
  IndexDefinition,
  ResourceSchema,
  SchemaAction,
  SchemaPlan,
  TableDefinition,
} from './types.js';
import {
  addForeignKeySql,
  columnSql,
  createTableSql,
  foreignKeySql,
  indexSql,
  quoteIdentifier,
} from './sql.js';

function desiredPrimaryKey(table: TableDefinition): string[] {
  return (
    table.primaryKey ??
    Object.entries(table.columns)
      .filter(([, column]) => column.primary)
      .map(([name]) => name)
  );
}

function expectedType(column: ColumnDefinition): string {
  return column.type === 'boolean' ? 'tinyint' : column.type;
}

function normalizedDefault(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).toLowerCase().replace(/\(\)$/, '');
  return normalized === 'null' ? null : normalized;
}

export function compareColumn(
  name: string,
  desired: ColumnDefinition,
  actual: ActualColumn,
): { changed: boolean; safe: boolean; reasons: string[] } {
  let changed = false;
  let safe = true;
  const reasons: string[] = [];
  const targetType = expectedType(desired);

  if (targetType !== actual.type) {
    changed = true;
    safe = false;
    reasons.push(`type ${actual.type} -> ${targetType}`);
  }

  if (['char', 'varchar', 'binary', 'varbinary'].includes(targetType)) {
    const targetLength = desired.length ?? null;
    if (targetLength !== actual.maximumLength) {
      changed = true;
      if (actual.maximumLength !== null && targetLength !== null && targetLength < actual.maximumLength) {
        safe = false;
      }
      reasons.push(`length ${actual.maximumLength ?? '?'} -> ${targetLength ?? '?'}`);
    }
  }

  if (targetType === 'decimal') {
    if (desired.precision !== actual.numericPrecision || desired.scale !== actual.numericScale) {
      changed = true;
      if (
        (desired.precision ?? 0) < (actual.numericPrecision ?? 0) ||
        (desired.scale ?? 0) < (actual.numericScale ?? 0)
      ) {
        safe = false;
      }
      reasons.push(
        `decimal(${actual.numericPrecision ?? '?'},${actual.numericScale ?? '?'}) -> decimal(${desired.precision},${desired.scale})`,
      );
    }
  }

  const actualUnsigned = actual.columnType.includes('unsigned');
  if (Boolean(desired.unsigned) !== actualUnsigned) {
    changed = true;
    safe = false;
    reasons.push(desired.unsigned ? 'make unsigned' : 'remove unsigned');
  }

  if (Boolean(desired.nullable) !== actual.nullable) {
    changed = true;
    if (!desired.nullable) safe = false;
    reasons.push(desired.nullable ? 'allow NULL' : 'disallow NULL');
  }

  const desiredAutoIncrement = Boolean(desired.autoIncrement);
  const actualAutoIncrement = actual.extra.includes('auto_increment');
  if (desiredAutoIncrement !== actualAutoIncrement) {
    changed = true;
    safe = false;
    reasons.push(desiredAutoIncrement ? 'add auto increment' : 'remove auto increment');
  }

  const expectedDefault =
    desired.defaultExpression !== undefined
      ? normalizedDefault(desired.defaultExpression)
      : desired.default !== undefined
        ? normalizedDefault(typeof desired.default === 'boolean' ? Number(desired.default) : desired.default)
        : null;
  if (expectedDefault !== normalizedDefault(actual.defaultValue)) {
    changed = true;
    reasons.push('change default');
  }

  if ((desired.comment ?? '') !== actual.comment) {
    changed = true;
    reasons.push('change comment');
  }

  return { changed, safe, reasons: reasons.length > 0 ? reasons : [`change ${name}`] };
}

function sameColumns(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((column, index) => column === right[index]);
}

function sameIndex(desired: IndexDefinition, actual: ActualIndex): boolean {
  return (
    sameColumns(desired.columns, actual.columns) &&
    Boolean(desired.unique) === actual.unique &&
    Boolean(desired.fulltext) === (actual.indexType === 'FULLTEXT')
  );
}

function sameForeignKey(desired: ForeignKeyDefinition, actual: ActualTable['foreignKeys'] extends Map<string, infer V> ? V : never): boolean {
  return (
    sameColumns(desired.columns, actual.columns) &&
    desired.references.table === actual.referencedTable &&
    sameColumns(desired.references.columns, actual.referencedColumns) &&
    (desired.onDelete ?? 'RESTRICT') === actual.onDelete &&
    (desired.onUpdate ?? 'RESTRICT') === actual.onUpdate
  );
}

function action(
  actions: SchemaAction[],
  value: Omit<SchemaAction, 'table'> & { table?: string },
): void {
  actions.push(value);
}

export function planSchema(
  resource: string,
  schema: ResourceSchema,
  actualTables: Map<string, ActualTable>,
): SchemaPlan {
  const actions: SchemaAction[] = [];
  const warnings: string[] = [];
  const createdTables = new Set<string>();

  for (const [tableName, table] of Object.entries(schema.tables)) {
    const actual = actualTables.get(tableName);
    if (!actual) {
      createdTables.add(tableName);
      action(actions, {
        kind: 'createTable',
        table: tableName,
        sql: createTableSql(tableName, table),
        safe: true,
        reason: `create missing table '${tableName}'`,
      });
      continue;
    }

    for (const [columnName, column] of Object.entries(table.columns)) {
      const actualColumn = actual.columns.get(columnName);
      if (!actualColumn) {
        const safe = Boolean(column.nullable) || column.default !== undefined || column.defaultExpression !== undefined;
        action(actions, {
          kind: 'addColumn',
          table: tableName,
          sql: `ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${columnSql(columnName, column)}`,
          safe,
          reason: safe
            ? `add compatible column '${tableName}.${columnName}'`
            : `adding required column '${tableName}.${columnName}' needs an explicit backfill migration`,
        });
        continue;
      }

      const change = compareColumn(columnName, column, actualColumn);
      if (change.changed) {
        action(actions, {
          kind: 'alterColumn',
          table: tableName,
          sql: `ALTER TABLE ${quoteIdentifier(tableName)} MODIFY COLUMN ${columnSql(columnName, column)}`,
          safe: change.safe,
          reason: `${tableName}.${columnName}: ${change.reasons.join(', ')}`,
        });
      }
    }

    for (const columnName of actual.columns.keys()) {
      if (!table.columns[columnName]) {
        warnings.push(
          `Table '${tableName}' contains unmanaged column '${columnName}'; qbxsql will not drop it automatically.`,
        );
      }
    }

    const desiredPrimary = desiredPrimaryKey(table);
    const actualPrimary = actual.indexes.get('PRIMARY')?.columns ?? [];
    if (!sameColumns(desiredPrimary, actualPrimary)) {
      const clauses: string[] = [];
      if (actualPrimary.length > 0) clauses.push('DROP PRIMARY KEY');
      if (desiredPrimary.length > 0) {
        clauses.push(`ADD PRIMARY KEY (${desiredPrimary.map(quoteIdentifier).join(', ')})`);
      }
      if (clauses.length > 0) {
        action(actions, {
          kind: 'alterPrimaryKey',
          table: tableName,
          sql: `ALTER TABLE ${quoteIdentifier(tableName)} ${clauses.join(', ')}`,
          safe: false,
          reason: `changing the primary key on '${tableName}' requires an explicit migration`,
        });
      }
    }

    for (const index of table.indexes ?? []) {
      const actualIndex = actual.indexes.get(index.name);
      if (!actualIndex) {
        action(actions, {
          kind: 'addIndex',
          table: tableName,
          sql: `ALTER TABLE ${quoteIdentifier(tableName)} ADD ${indexSql(index)}`,
          safe: !index.unique,
          reason: index.unique
            ? `unique index '${index.name}' requires duplicate validation`
            : `add missing index '${index.name}'`,
        });
      } else if (!sameIndex(index, actualIndex)) {
        action(actions, {
          kind: 'replaceIndex',
          table: tableName,
          sql: `ALTER TABLE ${quoteIdentifier(tableName)} DROP INDEX ${quoteIdentifier(index.name)}, ADD ${indexSql(index)}`,
          safe: false,
          reason: `changing index '${index.name}' requires an explicit migration`,
        });
      }
    }

    for (const foreignKey of table.foreignKeys ?? []) {
      const actualForeignKey = actual.foreignKeys.get(foreignKey.name);
      if (!actualForeignKey) {
        action(actions, {
          kind: 'addForeignKey',
          table: tableName,
          sql: addForeignKeySql(tableName, foreignKey),
          safe: false,
          reason: `foreign key '${foreignKey.name}' requires existing-row validation`,
        });
      } else if (!sameForeignKey(foreignKey, actualForeignKey)) {
        action(actions, {
          kind: 'replaceForeignKey',
          table: tableName,
          sql: `ALTER TABLE ${quoteIdentifier(tableName)} DROP FOREIGN KEY ${quoteIdentifier(foreignKey.name)}, ADD ${foreignKeySql(foreignKey)}`,
          safe: false,
          reason: `changing foreign key '${foreignKey.name}' requires an explicit migration`,
        });
      }
    }
  }

  for (const tableName of createdTables) {
    for (const foreignKey of schema.tables[tableName]?.foreignKeys ?? []) {
      action(actions, {
        kind: 'addForeignKey',
        table: tableName,
        sql: addForeignKeySql(tableName, foreignKey),
        safe: true,
        reason: `add foreign key '${foreignKey.name}' to new table '${tableName}'`,
      });
    }
  }

  return { resource, version: schema.version, actions, warnings };
}
