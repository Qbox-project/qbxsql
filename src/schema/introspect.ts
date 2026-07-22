import type { DatabaseService } from '../core/database.js';
import type {
  ActualColumn,
  ActualForeignKey,
  ActualIndex,
  ActualTable,
} from './types.js';

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function introspectDatabase(
  database: DatabaseService,
  tableNames?: Iterable<string>,
): Promise<Map<string, ActualTable>> {
  await database.connect();
  const schemaName = database.driver.databaseName;
  if (!schemaName) throw new Error('No database is selected in the connection string.');
  const scope = tableNames ? [...new Set(tableNames)] : null;
  if (scope?.length === 0) return new Map();
  const placeholders = scope ? scope.map(() => '?').join(', ') : '';
  const tableFilter = scope ? ` AND TABLE_NAME IN (${placeholders})` : '';
  const qualifiedTableFilter = scope ? ` AND k.TABLE_NAME IN (${placeholders})` : '';
  const parameters = scope ? [schemaName, ...scope] : [schemaName];

  const [tableRows, columnRows, indexRows, foreignKeyRows] = await Promise.all([
    database.query(
      `SELECT TABLE_NAME AS tableName, ENGINE AS engine, TABLE_COLLATION AS collation
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'${tableFilter}`,
      parameters,
      { invokingResource: 'qbxsql:schema' },
    ),
    database.query(
      `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, DATA_TYPE AS dataType,
              COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable, COLUMN_DEFAULT AS defaultValue,
              EXTRA AS extra, CHARACTER_MAXIMUM_LENGTH AS maximumLength,
              NUMERIC_PRECISION AS numericPrecision, NUMERIC_SCALE AS numericScale,
              COLUMN_COMMENT AS comment
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ?${tableFilter}
       ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      parameters,
      { invokingResource: 'qbxsql:schema' },
    ),
    database.query(
      `SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName, COLUMN_NAME AS columnName,
              NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS sequenceNumber, INDEX_TYPE AS indexType
       FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = ?${tableFilter}
       ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
      parameters,
      { invokingResource: 'qbxsql:schema' },
    ),
    database.query(
      `SELECT k.TABLE_NAME AS tableName, k.CONSTRAINT_NAME AS constraintName,
              k.COLUMN_NAME AS columnName, k.REFERENCED_TABLE_NAME AS referencedTable,
              k.REFERENCED_COLUMN_NAME AS referencedColumn, k.ORDINAL_POSITION AS sequenceNumber,
              r.DELETE_RULE AS deleteRule, r.UPDATE_RULE AS updateRule
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
       JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
        AND r.TABLE_NAME = k.TABLE_NAME
        AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
       WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL${qualifiedTableFilter}
       ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      parameters,
      { invokingResource: 'qbxsql:schema' },
    ),
  ]);

  const tables = new Map<string, ActualTable>();
  for (const row of tableRows as Row[]) {
    const name = text(row.tableName);
    tables.set(name, {
      name,
      engine: text(row.engine),
      charset:
        row.collation === null ? null : text(row.collation).split('_', 1)[0]?.toLowerCase() ?? null,
      collation: row.collation === null ? null : text(row.collation),
      columns: new Map(),
      indexes: new Map(),
      foreignKeys: new Map(),
    });
  }

  for (const row of columnRows as Row[]) {
    const table = tables.get(text(row.tableName));
    if (!table) continue;
    const column: ActualColumn = {
      name: text(row.columnName),
      type: text(row.dataType).toLowerCase(),
      columnType: text(row.columnType).toLowerCase(),
      nullable: text(row.isNullable) === 'YES',
      defaultValue: row.defaultValue as string | number | null,
      extra: text(row.extra).toLowerCase(),
      maximumLength: numberOrNull(row.maximumLength),
      numericPrecision: numberOrNull(row.numericPrecision),
      numericScale: numberOrNull(row.numericScale),
      comment: text(row.comment),
    };
    table.columns.set(column.name, column);
  }

  for (const row of indexRows as Row[]) {
    const table = tables.get(text(row.tableName));
    if (!table) continue;
    const name = text(row.indexName);
    let index = table.indexes.get(name);
    if (!index) {
      index = {
        name,
        columns: [],
        unique: Number(row.nonUnique) === 0,
        primary: name === 'PRIMARY',
        indexType: text(row.indexType).toUpperCase(),
      };
      table.indexes.set(name, index);
    }
    index.columns.push(text(row.columnName));
  }

  for (const row of foreignKeyRows as Row[]) {
    const table = tables.get(text(row.tableName));
    if (!table) continue;
    const name = text(row.constraintName);
    let foreignKey = table.foreignKeys.get(name);
    if (!foreignKey) {
      foreignKey = {
        name,
        columns: [],
        referencedTable: text(row.referencedTable),
        referencedColumns: [],
        onDelete: text(row.deleteRule),
        onUpdate: text(row.updateRule),
      };
      table.foreignKeys.set(name, foreignKey);
    }
    foreignKey.columns.push(text(row.columnName));
    foreignKey.referencedColumns.push(text(row.referencedColumn));
  }

  return tables;
}
