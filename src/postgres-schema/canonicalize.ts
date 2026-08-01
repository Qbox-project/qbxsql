import type { DatabaseService } from '../core/database.js';
import type { DatabaseConnection } from '../core/types.js';
import { checkExpression } from './introspect.js';
import {
  postgresCheckSql,
  postgresDefault,
  postgresExclusionSql,
  postgresType,
  quotePostgresIdentifier,
} from './sql.js';
import type {
  PostgresResourceSchema,
  PostgresTableDefinition,
} from './types.js';

type Row = Record<string, unknown>;

/**
 * The planner compares author-written SQL text (defaults, check expressions,
 * index predicates, exclusion definitions) against the server's deparsed
 * catalog text, which PostgreSQL rewrites freely: casts are added, literals
 * re-quoted, jsonb re-serialized, expressions re-parenthesized. No string
 * normalizer can reconcile the two, and a residual mismatch makes ensure()
 * fail its convergence re-check forever.
 *
 * Instead, each schema's expressions are round-tripped through the server
 * itself: a session-local scratch table is created with the same columns,
 * defaults, and constraints, and the deparsed text PostgreSQL stores for it is
 * recorded on the schema as canonical comparison values. Both sides of every
 * later comparison then come from the same deparser on the same server.
 */
const scratchTable = 'qbxsql_canonicalize_scratch';
const probeColumn = 'qbxsql_canonicalize_probe';
const scratchRegclass = `'pg_temp.${scratchTable}'::regclass`;

function resultRows(result: { rows: unknown }): Row[] {
  return Array.isArray(result.rows) ? (result.rows as Row[]) : [];
}

function needsCanonicalization(table: PostgresTableDefinition): boolean {
  return (
    Object.values(table.columns).some(
      (column) => column.default !== undefined || column.defaultExpression !== undefined,
    ) ||
    (table.checks ?? []).length > 0 ||
    (table.exclusions ?? []).length > 0 ||
    (table.indexes ?? []).some((index) => index.where !== undefined)
  );
}

async function canonicalizeTable(
  connection: DatabaseConnection,
  table: PostgresTableDefinition,
): Promise<void> {
  if (table.columns[probeColumn]) {
    throw new Error(`column name '${probeColumn}' is reserved for canonicalization`);
  }
  const definitions = [`${quotePostgresIdentifier(probeColumn)} integer`];
  for (const [column, definition] of Object.entries(table.columns)) {
    const parts = [quotePostgresIdentifier(column), postgresType(definition)];
    const defaultValue = postgresDefault(definition);
    if (defaultValue !== null) parts.push(`DEFAULT ${defaultValue}`);
    definitions.push(parts.join(' '));
  }
  await connection.query(
    `CREATE TEMPORARY TABLE ${quotePostgresIdentifier(scratchTable)} (${definitions.join(', ')})`,
  );

  const hasDefaults = Object.values(table.columns).some(
    (column) => column.default !== undefined || column.defaultExpression !== undefined,
  );
  if (hasDefaults) {
    const defaults = new Map(
      resultRows(await connection.query(
        `SELECT a.attname AS name, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS expression
           FROM pg_catalog.pg_attrdef d
           JOIN pg_catalog.pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
          WHERE d.adrelid = ${scratchRegclass}`,
      )).map((row) => [String(row.name), String(row.expression)]),
    );
    for (const [column, definition] of Object.entries(table.columns)) {
      if (definition.default === undefined && definition.defaultExpression === undefined) continue;
      const expression = defaults.get(column);
      if (expression !== undefined) definition.canonicalDefault = expression;
    }
  }

  // Constraints and probe indexes are added one at a time so a single failing
  // entry (for example an exclusion needing btree_gist) degrades only itself.
  for (const check of table.checks ?? []) {
    try {
      await connection.query(
        `ALTER TABLE pg_temp.${quotePostgresIdentifier(scratchTable)} ADD ${postgresCheckSql(check)}`,
      );
      const row = resultRows(await connection.query(
        `SELECT pg_catalog.pg_get_constraintdef(con.oid, TRUE) AS definition
           FROM pg_catalog.pg_constraint con
          WHERE con.conrelid = ${scratchRegclass} AND con.conname = $1`,
        [check.name],
      ))[0];
      if (row?.definition) check.canonicalExpression = checkExpression(String(row.definition));
    } catch {
      // Fall back to text comparison for this check only.
    }
  }

  const predicated = (table.indexes ?? []).filter((index) => index.where !== undefined);
  for (let position = 0; position < predicated.length; position += 1) {
    const index = predicated[position]!;
    const probeName = `${scratchTable}_p${position}`;
    try {
      await connection.query(
        `CREATE INDEX ${quotePostgresIdentifier(probeName)} ON pg_temp.${quotePostgresIdentifier(scratchTable)} (${quotePostgresIdentifier(probeColumn)}) WHERE (${index.where})`,
      );
      const row = resultRows(await connection.query(
        `SELECT pg_catalog.pg_get_expr(idx.indpred, idx.indrelid) AS predicate
           FROM pg_catalog.pg_index idx
           JOIN pg_catalog.pg_class index_class ON index_class.oid = idx.indexrelid
          WHERE idx.indrelid = ${scratchRegclass} AND index_class.relname = $1`,
        [probeName],
      ))[0];
      if (row?.predicate) index.canonicalPredicate = String(row.predicate);
    } catch {
      // Fall back to text comparison for this predicate only.
    }
  }

  for (const exclusion of table.exclusions ?? []) {
    try {
      await connection.query(
        `ALTER TABLE pg_temp.${quotePostgresIdentifier(scratchTable)} ADD ${postgresExclusionSql(exclusion)}`,
      );
      const row = resultRows(await connection.query(
        `SELECT pg_catalog.pg_get_constraintdef(con.oid, TRUE) AS definition
           FROM pg_catalog.pg_constraint con
          WHERE con.conrelid = ${scratchRegclass} AND con.conname = $1`,
        [exclusion.name],
      ))[0];
      if (row?.definition) exclusion.canonicalDefinition = String(row.definition);
    } catch {
      // Fall back to text comparison for this exclusion only.
    }
  }
}

/**
 * Returns a copy of the validated schema with canonical comparison text
 * attached. Failures degrade to the original author text per table, so a
 * missing extension or unsupported construct never blocks planning; the
 * planner then compares author text the way it always has.
 */
export async function canonicalizePostgresSchema(
  database: DatabaseService,
  schema: PostgresResourceSchema,
): Promise<PostgresResourceSchema> {
  const targets = Object.keys(schema.tables).filter((name) =>
    needsCanonicalization(schema.tables[name]!),
  );
  if (targets.length === 0) return schema;

  const canonical = structuredClone(schema);
  const connection = await database.driver.acquire();
  try {
    for (const name of targets) {
      try {
        await canonicalizeTable(connection, canonical.tables[name]!);
      } catch (error) {
        console.warn(
          `[qbxsql] Falling back to text comparison for PostgreSQL table '${name}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        await connection
          .query(`DROP TABLE IF EXISTS pg_temp.${quotePostgresIdentifier(scratchTable)}`)
          .catch(() => {});
      }
    }
  } finally {
    connection.release();
  }
  return canonical;
}
