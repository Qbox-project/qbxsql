import type {
  PostgresCheckDefinition,
  PostgresColumnDefinition,
  PostgresForeignKeyDefinition,
  PostgresExclusionDefinition,
  PostgresIndexColumn,
  PostgresIndexDefinition,
  PostgresMigrationOperation,
  PostgresTableDefinition,
} from './types.js';
import { assertPostgresIdentifier } from './validate.js';

export function quotePostgresIdentifier(identifier: string): string {
  assertPostgresIdentifier(identifier);
  return `"${identifier}"`;
}

export function qualifiedTable(table: string): string {
  return `"public".${quotePostgresIdentifier(table)}`;
}

export function postgresLiteral(value: unknown, type?: string): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('PostgreSQL numeric defaults must be finite.');
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === 'object' && (type === 'json' || type === 'jsonb')) {
    return `'${JSON.stringify(value).replaceAll("'", "''")}'::${type}`;
  }
  throw new Error(`Unsupported PostgreSQL literal of type ${typeof value}.`);
}

export function postgresType(column: PostgresColumnDefinition): string {
  if (
    column.type === 'vector' ||
    column.type === 'halfvec' ||
    column.type === 'sparsevec'
  ) {
    return `${column.type.toUpperCase()}(${column.dimensions})`;
  }
  if (
    (column.type === 'geometry' || column.type === 'geography') &&
    column.spatialType &&
    column.srid !== undefined
  ) {
    return `${column.type.toUpperCase()}(${column.spatialType.toUpperCase()},${column.srid})`;
  }
  switch (column.type) {
    case 'int':
      return 'INTEGER';
    case 'decimal':
    case 'numeric':
      return `NUMERIC(${column.precision},${column.scale})`;
    case 'double':
      return 'DOUBLE PRECISION';
    case 'char':
      return `CHARACTER(${column.length})`;
    case 'varchar':
      return `CHARACTER VARYING(${column.length})`;
    case 'timestamptz':
      return 'TIMESTAMP WITH TIME ZONE';
    // format_type() spells these out, and the planner compares against it, so
    // the short forms would read as permanent drift.
    case 'timestamp':
      return 'TIMESTAMP WITHOUT TIME ZONE';
    case 'time':
      return 'TIME WITHOUT TIME ZONE';
    default:
      return column.type.toUpperCase();
  }
}

function postgresIndexColumnSql(column: PostgresIndexColumn): string {
  if (typeof column === 'string') return quotePostgresIdentifier(column);
  const parts = [quotePostgresIdentifier(column.name)];
  if (column.operatorClass) parts.push(quotePostgresIdentifier(column.operatorClass));
  if (column.order) parts.push(column.order);
  if (column.nulls) parts.push(`NULLS ${column.nulls}`);
  return parts.join(' ');
}

function postgresIndexOptionSql(value: string | number | boolean): string {
  return typeof value === 'string' ? postgresLiteral(value) : postgresLiteral(value);
}

export function postgresDefault(column: PostgresColumnDefinition): string | null {
  if (column.defaultExpression !== undefined) return column.defaultExpression;
  if (column.default !== undefined) return postgresLiteral(column.default, column.type);
  return null;
}

export function postgresColumnSql(
  name: string,
  column: PostgresColumnDefinition,
): string {
  const parts = [quotePostgresIdentifier(name), postgresType(column)];
  if (column.identity) {
    parts.push(
      `GENERATED ${column.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`,
    );
  }
  const defaultValue = postgresDefault(column);
  if (defaultValue !== null) parts.push(`DEFAULT ${defaultValue}`);
  parts.push(column.nullable ? 'NULL' : 'NOT NULL');
  return parts.join(' ');
}

export function postgresCheckSql(
  check: PostgresCheckDefinition,
  notValid = false,
): string {
  return `CONSTRAINT ${quotePostgresIdentifier(check.name)} CHECK (${check.expression})${notValid ? ' NOT VALID' : ''}`;
}

export function postgresForeignKeySql(
  foreignKey: PostgresForeignKeyDefinition,
  notValid = false,
): string {
  const parts = [
    `CONSTRAINT ${quotePostgresIdentifier(foreignKey.name)}`,
    `FOREIGN KEY (${foreignKey.columns.map(quotePostgresIdentifier).join(', ')})`,
    `REFERENCES ${qualifiedTable(foreignKey.references.table)} (${foreignKey.references.columns.map(quotePostgresIdentifier).join(', ')})`,
  ];
  if (foreignKey.onDelete) parts.push(`ON DELETE ${foreignKey.onDelete}`);
  if (foreignKey.onUpdate) parts.push(`ON UPDATE ${foreignKey.onUpdate}`);
  if (foreignKey.deferrable) {
    parts.push('DEFERRABLE');
    if (foreignKey.initiallyDeferred) parts.push('INITIALLY DEFERRED');
  }
  if (notValid) parts.push('NOT VALID');
  return parts.join(' ');
}

export function postgresExclusionSql(
  exclusion: PostgresExclusionDefinition,
): string {
  const method = (exclusion.method ?? 'gist').toUpperCase();
  const elements = exclusion.elements.map((element) => {
    const operatorClass = element.operatorClass
      ? ` ${quotePostgresIdentifier(element.operatorClass)}`
      : '';
    return `${quotePostgresIdentifier(element.column)}${operatorClass} WITH ${element.operator}`;
  });
  const parts = [
    `CONSTRAINT ${quotePostgresIdentifier(exclusion.name)}`,
    `EXCLUDE USING ${method} (${elements.join(', ')})`,
  ];
  if (exclusion.where) parts.push(`WHERE (${exclusion.where})`);
  if (exclusion.deferrable) {
    parts.push('DEFERRABLE');
    if (exclusion.initiallyDeferred) parts.push('INITIALLY DEFERRED');
  }
  return parts.join(' ');
}

export function createPostgresTableSql(
  name: string,
  table: PostgresTableDefinition,
): string {
  const definitions = Object.entries(table.columns).map(([column, definition]) =>
    postgresColumnSql(column, definition),
  );
  const primary =
    table.primaryKey ??
    Object.entries(table.columns)
      .filter(([, column]) => column.primary)
      .map(([column]) => column);
  if (primary.length > 0) {
    definitions.push(`PRIMARY KEY (${primary.map(quotePostgresIdentifier).join(', ')})`);
  }
  for (const check of table.checks ?? []) definitions.push(postgresCheckSql(check));
  for (const exclusion of table.exclusions ?? []) {
    definitions.push(postgresExclusionSql(exclusion));
  }
  return `CREATE TABLE ${qualifiedTable(name)} (\n  ${definitions.join(',\n  ')}\n)`;
}

export function createPostgresIndexSql(
  table: string,
  index: PostgresIndexDefinition,
  concurrently: boolean,
): string {
  const method = (index.method ?? 'btree').toUpperCase();
  const include =
    index.include && index.include.length > 0
      ? ` INCLUDE (${index.include.map(quotePostgresIdentifier).join(', ')})`
      : '';
  const predicate = index.where ? ` WHERE (${index.where})` : '';
  const options = index.options && Object.keys(index.options).length > 0
    ? ` WITH (${Object.entries(index.options)
      .map(([key, value]) => `${quotePostgresIdentifier(key)} = ${postgresIndexOptionSql(value)}`)
      .join(', ')})`
    : '';
  return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX${concurrently ? ' CONCURRENTLY' : ''} ${quotePostgresIdentifier(index.name)} ON ${qualifiedTable(table)} USING ${method} (${index.columns.map(postgresIndexColumnSql).join(', ')})${include}${options}${predicate}`;
}

export interface PostgresMigrationStatement {
  sql: string;
  concurrent?: boolean;
  releaseOwnership?: string;
  renameOwnership?: { from: string; to: string };
  dropOwnership?: string;
}

export function postgresMigrationStatements(
  operation: PostgresMigrationOperation,
): PostgresMigrationStatement[] {
  switch (operation.type) {
    case 'renameTable':
      return [{
        sql: `ALTER TABLE ${qualifiedTable(operation.from)} RENAME TO ${quotePostgresIdentifier(operation.to)}`,
        renameOwnership: { from: operation.from, to: operation.to },
      }];
    case 'renameColumn':
      return [{
        sql: `ALTER TABLE ${qualifiedTable(operation.table)} RENAME COLUMN ${quotePostgresIdentifier(operation.from)} TO ${quotePostgresIdentifier(operation.to)}`,
      }];
    case 'dropTable':
      return [{
        sql: `DROP TABLE IF EXISTS ${qualifiedTable(operation.table)}`,
        dropOwnership: operation.table,
      }];
    case 'dropColumn':
      return [{
        sql: `ALTER TABLE ${qualifiedTable(operation.table)} DROP COLUMN IF EXISTS ${quotePostgresIdentifier(operation.column)}`,
      }];
    case 'addColumn':
      return [{
        sql: `ALTER TABLE ${qualifiedTable(operation.table)} ADD COLUMN ${postgresColumnSql(operation.column, operation.definition)}`,
      }];
    case 'alterColumn': {
      const table = qualifiedTable(operation.table);
      const column = quotePostgresIdentifier(operation.column);
      const statements: PostgresMigrationStatement[] = [{
        sql: `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${postgresType(operation.definition)}${operation.using ? ` USING ${operation.using}` : ''}`,
      }];
      const defaultValue = postgresDefault(operation.definition);
      statements.push({
        sql: `ALTER TABLE ${table} ALTER COLUMN ${column} ${defaultValue === null ? 'DROP DEFAULT' : `SET DEFAULT ${defaultValue}`}`,
      });
      statements.push({
        sql: `ALTER TABLE ${table} ALTER COLUMN ${column} ${operation.definition.nullable ? 'DROP' : 'SET'} NOT NULL`,
      });
      return statements;
    }
    case 'addIndex':
      return [{
        sql: createPostgresIndexSql(operation.table, operation.definition, true),
        concurrent: true,
      }];
    case 'dropIndex':
      return [{
        sql: `DROP INDEX CONCURRENTLY IF EXISTS "public".${quotePostgresIdentifier(operation.index)}`,
        concurrent: true,
      }];
    case 'addForeignKey':
      return [
        {
          sql: `ALTER TABLE ${qualifiedTable(operation.table)} ADD ${postgresForeignKeySql(operation.definition, true)}`,
        },
        {
          sql: `ALTER TABLE ${qualifiedTable(operation.table)} VALIDATE CONSTRAINT ${quotePostgresIdentifier(operation.definition.name)}`,
        },
      ];
    case 'addExclusion':
      return [{
        sql: `ALTER TABLE ${qualifiedTable(operation.table)} ADD ${postgresExclusionSql(operation.definition)}`,
      }];
    case 'addCheck':
      return [
        {
          sql: `ALTER TABLE ${qualifiedTable(operation.table)} ADD ${postgresCheckSql(operation.definition, true)}`,
        },
        {
          sql: `ALTER TABLE ${qualifiedTable(operation.table)} VALIDATE CONSTRAINT ${quotePostgresIdentifier(operation.definition.name)}`,
        },
      ];
    case 'dropConstraint':
      return [{
        sql: `ALTER TABLE ${qualifiedTable(operation.table)} DROP CONSTRAINT IF EXISTS ${quotePostgresIdentifier(operation.constraint)}`,
      }];
    case 'validateConstraint':
      return [{
        sql: `ALTER TABLE ${qualifiedTable(operation.table)} VALIDATE CONSTRAINT ${quotePostgresIdentifier(operation.constraint)}`,
      }];
    case 'setPrimaryKey':
      return [{
        sql: `ALTER TABLE ${qualifiedTable(operation.table)} ADD PRIMARY KEY (${operation.columns.map(quotePostgresIdentifier).join(', ')})`,
      }];
    case 'dropPrimaryKey':
      return [{
        sql: `ALTER TABLE ${qualifiedTable(operation.table)} DROP CONSTRAINT IF EXISTS ${quotePostgresIdentifier(operation.constraint ?? `${operation.table}_pkey`)}`,
      }];
    case 'releaseTable':
      return [{
        sql: `-- release qbxsql ownership of ${qualifiedTable(operation.table)}`,
        releaseOwnership: operation.table,
      }];
    case 'sql':
      return [{ sql: operation.sql }];
  }
}

export function commentOnTableSql(table: string, comment: string): string {
  return `COMMENT ON TABLE ${qualifiedTable(table)} IS ${postgresLiteral(comment)}`;
}

export function commentOnColumnSql(table: string, column: string, comment: string): string {
  return `COMMENT ON COLUMN ${qualifiedTable(table)}.${quotePostgresIdentifier(column)} IS ${postgresLiteral(comment)}`;
}
