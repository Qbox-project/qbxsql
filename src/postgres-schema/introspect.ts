import type { DatabaseService } from '../core/database.js';
import type {
  ActualPostgresCheck,
  ActualPostgresColumn,
  ActualPostgresForeignKey,
  ActualPostgresExclusion,
  ActualPostgresIndex,
  ActualPostgresTable,
} from './types.js';

type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value as Row[] : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map((entry) => Number(entry)) : [];
}

function indexOptions(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const option of stringArray(value)) {
    const separator = option.indexOf('=');
    if (separator < 1) continue;
    result[option.slice(0, separator)] = option.slice(separator + 1);
  }
  return result;
}

function actionName(value: unknown): string {
  const actions: Record<string, string> = {
    a: 'NO ACTION',
    r: 'RESTRICT',
    c: 'CASCADE',
    n: 'SET NULL',
    d: 'SET DEFAULT',
  };
  return actions[String(value)] ?? String(value);
}

export function checkExpression(definition: string): string {
  const match = /^CHECK\s*\((.*)\)$/is.exec(definition.trim());
  return (match?.[1] ?? definition).trim();
}

export async function introspectPostgresDatabase(
  database: DatabaseService,
  tableNames: readonly string[],
): Promise<Map<string, ActualPostgresTable>> {
  const names = [...new Set(tableNames)];
  if (names.length === 0) return new Map();

  const [tableRows, columnRows, indexRows, constraintRows] = await Promise.all([
    database.query(
      `SELECT c.relname AS "tableName",
              COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND c.relname = ANY($1::text[])`,
      [names],
    ),
    database.query(
      `SELECT c.relname AS "tableName",
              a.attname AS "columnName",
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS "formattedType",
              NOT a.attnotnull AS nullable,
              pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS "defaultExpression",
              a.attidentity AS identity,
              COALESCE(pg_catalog.col_description(c.oid, a.attnum), '') AS comment
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
         LEFT JOIN pg_catalog.pg_attrdef d
           ON d.adrelid = c.oid AND d.adnum = a.attnum
        WHERE n.nspname = 'public'
          AND c.relname = ANY($1::text[])
          AND a.attnum > 0
          AND NOT a.attisdropped`,
      [names],
    ),
    database.query(
      `SELECT table_class.relname AS "tableName",
              index_class.relname AS "indexName",
              idx.indisunique AS unique,
              idx.indisprimary AS "primary",
              idx.indisvalid AS valid,
              access_method.amname AS method,
              ARRAY(
                SELECT operator_class.opcname
                  FROM unnest(idx.indclass::oid[]) WITH ORDINALITY AS class(oid, position)
                  JOIN pg_catalog.pg_opclass operator_class
                    ON operator_class.oid = class.oid
                 WHERE class.position <= idx.indnkeyatts
                 ORDER BY class.position
              )::text[] AS "operatorClasses",
              index_class.reloptions AS options,
              pg_catalog.pg_get_expr(idx.indpred, idx.indrelid) AS predicate,
              ARRAY(
                SELECT option
                  FROM unnest(idx.indoption::int2[]) WITH ORDINALITY AS opt(option, position)
                 WHERE opt.position <= idx.indnkeyatts
                 ORDER BY opt.position
              )::int[] AS "columnOptions",
              ARRAY(
                SELECT pg_catalog.pg_get_indexdef(idx.indexrelid, position, TRUE)
                  FROM generate_series(1, idx.indnkeyatts) position
                 ORDER BY position
              ) AS columns,
              ARRAY(
                SELECT pg_catalog.pg_get_indexdef(idx.indexrelid, position, TRUE)
                  FROM generate_series(idx.indnkeyatts + 1, idx.indnatts) position
                 ORDER BY position
              ) AS include
         FROM pg_catalog.pg_index idx
         JOIN pg_catalog.pg_class table_class ON table_class.oid = idx.indrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = table_class.relnamespace
         JOIN pg_catalog.pg_class index_class ON index_class.oid = idx.indexrelid
         JOIN pg_catalog.pg_am access_method ON access_method.oid = index_class.relam
        WHERE n.nspname = 'public'
          AND table_class.relname = ANY($1::text[])`,
      [names],
    ),
    database.query(
      `SELECT table_class.relname AS "tableName",
              con.conname AS name,
              con.contype AS type,
              con.convalidated AS validated,
              con.condeferrable AS deferrable,
              con.condeferred AS "initiallyDeferred",
              referenced_class.relname AS "referencedTable",
              con.confdeltype AS "onDelete",
              con.confupdtype AS "onUpdate",
              pg_catalog.pg_get_constraintdef(con.oid, TRUE) AS definition,
              ARRAY(
                SELECT attribute.attname
                  FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, position)
                  JOIN pg_catalog.pg_attribute attribute
                    ON attribute.attrelid = con.conrelid
                   AND attribute.attnum = key.attnum
                 ORDER BY key.position
              )::text[] AS columns,
              ARRAY(
                SELECT attribute.attname
                  FROM unnest(con.confkey) WITH ORDINALITY AS key(attnum, position)
                  JOIN pg_catalog.pg_attribute attribute
                    ON attribute.attrelid = con.confrelid
                   AND attribute.attnum = key.attnum
                 ORDER BY key.position
              )::text[] AS "referencedColumns"
         FROM pg_catalog.pg_constraint con
         JOIN pg_catalog.pg_class table_class ON table_class.oid = con.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = table_class.relnamespace
         LEFT JOIN pg_catalog.pg_class referenced_class ON referenced_class.oid = con.confrelid
        WHERE n.nspname = 'public'
          AND table_class.relname = ANY($1::text[])
          AND con.contype IN ('p', 'f', 'c', 'x')`,
      [names],
    ),
  ]);

  const result = new Map<string, ActualPostgresTable>();
  for (const row of rows(tableRows)) {
    const name = String(row.tableName);
    result.set(name, {
      name,
      comment: String(row.comment ?? ''),
      columns: new Map(),
      indexes: new Map(),
      checks: new Map(),
      foreignKeys: new Map(),
      exclusions: new Map(),
      primaryKey: [],
      primaryKeyName: null,
    });
  }

  for (const row of rows(columnRows)) {
    const table = result.get(String(row.tableName));
    if (!table) continue;
    const column: ActualPostgresColumn = {
      name: String(row.columnName),
      formattedType: String(row.formattedType).toLowerCase(),
      nullable: Boolean(row.nullable),
      defaultExpression:
        row.defaultExpression === null || row.defaultExpression === undefined
          ? null
          : String(row.defaultExpression),
      identity: (row.identity === 'a' || row.identity === 'd' ? row.identity : '') as '' | 'a' | 'd',
      comment: String(row.comment ?? ''),
    };
    table.columns.set(column.name, column);
  }

  for (const row of rows(indexRows)) {
    const table = result.get(String(row.tableName));
    if (!table) continue;
    const index: ActualPostgresIndex = {
      name: String(row.indexName),
      columns: stringArray(row.columns),
      include: stringArray(row.include),
      unique: Boolean(row.unique),
      primary: Boolean(row.primary),
      valid: Boolean(row.valid),
      method: String(row.method),
      operatorClasses: stringArray(row.operatorClasses),
      columnOptions: numberArray(row.columnOptions),
      options: indexOptions(row.options),
      predicate: row.predicate === null || row.predicate === undefined ? null : String(row.predicate),
    };
    table.indexes.set(index.name, index);
  }

  for (const row of rows(constraintRows)) {
    const table = result.get(String(row.tableName));
    if (!table) continue;
    if (row.type === 'p') {
      table.primaryKey = stringArray(row.columns);
      table.primaryKeyName = String(row.name);
    } else if (row.type === 'c') {
      const check: ActualPostgresCheck = {
        name: String(row.name),
        expression: checkExpression(String(row.definition)),
        validated: Boolean(row.validated),
      };
      table.checks.set(check.name, check);
    } else if (row.type === 'f') {
      const foreignKey: ActualPostgresForeignKey = {
        name: String(row.name),
        columns: stringArray(row.columns),
        referencedTable: String(row.referencedTable),
        referencedColumns: stringArray(row.referencedColumns),
        onDelete: actionName(row.onDelete),
        onUpdate: actionName(row.onUpdate),
        deferrable: Boolean(row.deferrable),
        initiallyDeferred: Boolean(row.initiallyDeferred),
        validated: Boolean(row.validated),
      };
      table.foreignKeys.set(foreignKey.name, foreignKey);
    } else if (row.type === 'x') {
      const exclusion: ActualPostgresExclusion = {
        name: String(row.name),
        definition: String(row.definition),
        deferrable: Boolean(row.deferrable),
        initiallyDeferred: Boolean(row.initiallyDeferred),
      };
      table.exclusions!.set(exclusion.name, exclusion);
    }
  }

  for (const table of result.values()) {
    if (table.primaryKey.length > 0) continue;
    const primary = [...table.indexes.values()].find((index) => index.primary);
    if (primary) table.primaryKey = [...primary.columns];
  }

  return result;
}
