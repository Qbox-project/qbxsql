import {
  commentOnColumnSql,
  commentOnTableSql,
  createPostgresIndexSql,
  createPostgresTableSql,
  postgresCheckSql,
  postgresColumnSql,
  postgresDefault,
  postgresForeignKeySql,
  postgresType,
  qualifiedTable,
  quotePostgresIdentifier,
} from './sql.js';
import type {
  ActualPostgresForeignKey,
  ActualPostgresIndex,
  ActualPostgresTable,
  PostgresColumnDefinition,
  PostgresForeignKeyDefinition,
  PostgresIndexDefinition,
  PostgresResourceSchema,
  PostgresSchemaAction,
  PostgresSchemaPlan,
} from './types.js';

function normalizeSql(value: string | null | undefined): string {
  if (!value) return '';
  let normalized = value.trim().replace(/\s+/g, ' ').replaceAll('"', '').toLowerCase();
  while (normalized.startsWith('(') && normalized.endsWith(')')) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

function normalizeDefault(value: string | null): string {
  return normalizeSql(value)
    .replace(/::(?:character varying|character|text|jsonb?|uuid|timestamp(?: with(?:out)? time zone)?)/g, '')
    .trim();
}

function normalizeExpression(value: string | null | undefined): string {
  return normalizeSql(value)
    .replace(/::(?:smallint|integer|bigint|numeric|real|double precision|text|boolean|uuid)\b/g, '')
    .trim();
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) =>
    normalizeSql(value) === normalizeSql(right[index]));
}

function desiredPrimary(table: PostgresResourceSchema['tables'][string]): string[] {
  return table.primaryKey ??
    Object.entries(table.columns)
      .filter(([, column]) => column.primary)
      .map(([column]) => column);
}

function automaticAction(
  input: Omit<PostgresSchemaAction, 'safe' | 'dataSafe' | 'onlineSafe' | 'automatic' | 'risk'> &
    Partial<Pick<PostgresSchemaAction, 'safe' | 'dataSafe' | 'onlineSafe' | 'automatic' | 'risk'>>,
): PostgresSchemaAction {
  return {
    safe: true,
    dataSafe: true,
    onlineSafe: true,
    automatic: true,
    risk: 'low',
    ...input,
  };
}

function manualAction(
  input: Omit<PostgresSchemaAction, 'safe' | 'dataSafe' | 'onlineSafe' | 'automatic' | 'risk'> &
    Partial<Pick<PostgresSchemaAction, 'safe' | 'dataSafe' | 'onlineSafe' | 'risk'>>,
): PostgresSchemaAction {
  return {
    safe: true,
    dataSafe: true,
    onlineSafe: false,
    automatic: false,
    risk: 'medium',
    ...input,
  };
}

function safeWidening(actual: string, desired: PostgresColumnDefinition): boolean {
  const source = normalizeSql(actual);
  if (desired.type === 'text' && /^character varying(?:\(\d+\))?$/.test(source)) return true;
  if (desired.type !== 'varchar') return false;
  const match = /^character varying\((\d+)\)$/.exec(source);
  return Boolean(match && Number(match[1]) <= (desired.length ?? 0));
}

function indexMatches(
  actual: ActualPostgresIndex,
  desired: PostgresIndexDefinition,
): boolean {
  return (
    actual.valid &&
    actual.unique === (desired.unique ?? false) &&
    actual.method === (desired.method ?? 'btree') &&
    sameArray(actual.columns, desired.columns) &&
    sameArray(actual.include, desired.include ?? []) &&
    normalizeSql(actual.predicate) === normalizeSql(desired.where)
  );
}

function foreignKeyMatches(
  actual: ActualPostgresForeignKey,
  desired: PostgresForeignKeyDefinition,
): boolean {
  return (
    sameArray(actual.columns, desired.columns) &&
    actual.referencedTable === desired.references.table &&
    sameArray(actual.referencedColumns, desired.references.columns) &&
    actual.onDelete === (desired.onDelete ?? 'NO ACTION') &&
    actual.onUpdate === (desired.onUpdate ?? 'NO ACTION') &&
    actual.deferrable === (desired.deferrable ?? false) &&
    actual.initiallyDeferred === (desired.initiallyDeferred ?? false)
  );
}

function planExistingTable(
  name: string,
  desired: PostgresResourceSchema['tables'][string],
  actual: ActualPostgresTable,
  actions: PostgresSchemaAction[],
  warnings: string[],
): void {
  if (actual.comment !== (desired.comment ?? '')) {
    actions.push(automaticAction({
      kind: 'setTableComment',
      sql: commentOnTableSql(name, desired.comment ?? ''),
      algorithm: 'TRANSACTIONAL',
      reason: `update comment on public.${name}`,
      table: name,
    }));
  }

  for (const [columnName, column] of Object.entries(desired.columns)) {
    const current = actual.columns.get(columnName);
    if (!current) {
      const metadataSafe =
        column.nullable === true ||
        column.default !== undefined ||
        (column.defaultExpression !== undefined &&
          column.defaultExpression !== 'gen_random_uuid()');
      const action = {
        kind: 'addColumn',
        sql: `ALTER TABLE ${qualifiedTable(name)} ADD COLUMN ${postgresColumnSql(columnName, column)}`,
        algorithm: 'TRANSACTIONAL' as const,
        reason: metadataSafe
          ? `add metadata-safe column public.${name}.${columnName}`
          : `column public.${name}.${columnName} requires a backfill or volatile default`,
        table: name,
      };
      actions.push(metadataSafe ? automaticAction(action) : manualAction({
        ...action,
        risk: 'high',
      }));
      continue;
    }

    const desiredType = normalizeSql(postgresType(column));
    if (normalizeSql(current.formattedType) !== desiredType) {
      const widening = safeWidening(current.formattedType, column);
      const action = {
        kind: 'alterColumnType',
        sql: `ALTER TABLE ${qualifiedTable(name)} ALTER COLUMN ${quotePostgresIdentifier(columnName)} TYPE ${postgresType(column)}`,
        algorithm: 'TRANSACTIONAL' as const,
        reason: widening
          ? `widen public.${name}.${columnName} without a table rewrite`
          : `type conversion for public.${name}.${columnName} requires an explicit migration and USING expression when needed`,
        table: name,
      };
      actions.push(widening ? automaticAction(action) : manualAction({
        ...action,
        dataSafe: false,
        risk: 'high',
      }));
    }

    const desiredNullable = column.nullable === true;
    if (current.nullable !== desiredNullable) {
      const relaxing = desiredNullable;
      const action = {
        kind: relaxing ? 'dropNotNull' : 'setNotNull',
        sql: `ALTER TABLE ${qualifiedTable(name)} ALTER COLUMN ${quotePostgresIdentifier(columnName)} ${relaxing ? 'DROP' : 'SET'} NOT NULL`,
        algorithm: 'TRANSACTIONAL' as const,
        reason: relaxing
          ? `allow NULL in public.${name}.${columnName}`
          : `NOT NULL for public.${name}.${columnName} requires validation/backfill`,
        table: name,
      };
      actions.push(relaxing ? automaticAction(action) : manualAction({
        ...action,
        risk: 'high',
      }));
    }

    const desiredDefault = postgresDefault(column);
    if (normalizeDefault(current.defaultExpression) !== normalizeDefault(desiredDefault)) {
      actions.push(automaticAction({
        kind: desiredDefault === null ? 'dropDefault' : 'setDefault',
        sql: `ALTER TABLE ${qualifiedTable(name)} ALTER COLUMN ${quotePostgresIdentifier(columnName)} ${desiredDefault === null ? 'DROP DEFAULT' : `SET DEFAULT ${desiredDefault}`}`,
        algorithm: 'TRANSACTIONAL',
        reason: `update default for public.${name}.${columnName}`,
        table: name,
      }));
    }

    const desiredIdentity =
      column.identity === 'always' ? 'a' : column.identity === 'byDefault' ? 'd' : '';
    if (current.identity !== desiredIdentity) {
      actions.push(manualAction({
        kind: 'alterIdentity',
        sql: `-- alter identity for ${qualifiedTable(name)}.${quotePostgresIdentifier(columnName)}`,
        algorithm: 'MANUAL',
        reason: `identity changes for public.${name}.${columnName} require an explicit migration`,
        table: name,
        risk: 'high',
      }));
    }

    if (current.comment !== (column.comment ?? '')) {
      actions.push(automaticAction({
        kind: 'setColumnComment',
        sql: commentOnColumnSql(name, columnName, column.comment ?? ''),
        algorithm: 'TRANSACTIONAL',
        reason: `update comment on public.${name}.${columnName}`,
        table: name,
      }));
    }
  }

  for (const column of actual.columns.keys()) {
    if (!desired.columns[column]) {
      warnings.push(`public.${name}.${column} exists but is not declared; it will not be dropped automatically`);
    }
  }

  const primary = desiredPrimary(desired);
  if (!sameArray(primary, actual.primaryKey)) {
    actions.push(manualAction({
      kind: 'setPrimaryKey',
      sql:
        primary.length > 0
          ? `ALTER TABLE ${qualifiedTable(name)} ADD PRIMARY KEY (${primary.map(quotePostgresIdentifier).join(', ')})`
          : `ALTER TABLE ${qualifiedTable(name)} DROP CONSTRAINT ${quotePostgresIdentifier(actual.primaryKeyName ?? `${name}_pkey`)}`,
      algorithm: 'MANUAL',
      reason: `primary-key changes for public.${name} require an explicit migration`,
      table: name,
      risk: 'high',
    }));
  }

  const desiredIndexes = new Map((desired.indexes ?? []).map((index) => [index.name, index]));
  for (const index of desired.indexes ?? []) {
    const current = actual.indexes.get(index.name);
    if (!current) {
      actions.push(automaticAction({
        kind: 'addIndex',
        sql: createPostgresIndexSql(name, index, true),
        algorithm: 'CONCURRENT',
        reason: `build index ${index.name} without blocking writes`,
        table: name,
      }));
    } else if (!current.valid) {
      actions.push(automaticAction({
        kind: 'dropInvalidIndex',
        sql: `DROP INDEX CONCURRENTLY IF EXISTS "public".${quotePostgresIdentifier(index.name)}`,
        algorithm: 'CONCURRENT',
        reason: `remove invalid interrupted index ${index.name}`,
        table: name,
      }));
      actions.push(automaticAction({
        kind: 'addIndex',
        sql: createPostgresIndexSql(name, index, true),
        algorithm: 'CONCURRENT',
        reason: `rebuild invalid index ${index.name}`,
        table: name,
      }));
    } else if (!indexMatches(current, index)) {
      actions.push(manualAction({
        kind: 'replaceIndex',
        sql: createPostgresIndexSql(name, index, true),
        algorithm: 'CONCURRENT',
        reason: `index ${index.name} differs and requires an explicit drop/replacement migration`,
        table: name,
      }));
    }
  }
  for (const index of actual.indexes.values()) {
    if (!index.primary && !desiredIndexes.has(index.name)) {
      warnings.push(`index public.${index.name} is not declared; it will not be dropped automatically`);
    }
  }

  const desiredChecks = new Map((desired.checks ?? []).map((check) => [check.name, check]));
  for (const check of desired.checks ?? []) {
    const current = actual.checks.get(check.name);
    if (!current) {
      actions.push(automaticAction({
        kind: 'addCheck',
        sql: `ALTER TABLE ${qualifiedTable(name)} ADD ${postgresCheckSql(check, true)}`,
        algorithm: 'NOT VALID',
        reason: `enforce ${check.name} for new writes before validating existing rows`,
        table: name,
      }));
      actions.push(automaticAction({
        kind: 'validateCheck',
        sql: `ALTER TABLE ${qualifiedTable(name)} VALIDATE CONSTRAINT ${quotePostgresIdentifier(check.name)}`,
        algorithm: 'VALIDATE',
        reason: `validate existing rows for ${check.name}`,
        table: name,
      }));
    } else if (normalizeExpression(current.expression) !== normalizeExpression(check.expression)) {
      actions.push(manualAction({
        kind: 'replaceCheck',
        sql: `ALTER TABLE ${qualifiedTable(name)} ADD ${postgresCheckSql(check, true)}`,
        algorithm: 'MANUAL',
        reason: `check ${check.name} differs and requires an explicit replacement migration`,
        table: name,
      }));
    } else if (!current.validated) {
      actions.push(automaticAction({
        kind: 'validateCheck',
        sql: `ALTER TABLE ${qualifiedTable(name)} VALIDATE CONSTRAINT ${quotePostgresIdentifier(check.name)}`,
        algorithm: 'VALIDATE',
        reason: `complete validation for ${check.name}`,
        table: name,
      }));
    }
  }
  for (const check of actual.checks.values()) {
    if (!desiredChecks.has(check.name)) {
      warnings.push(`check constraint public.${name}.${check.name} is not declared`);
    }
  }

  const desiredForeignKeys = new Map(
    (desired.foreignKeys ?? []).map((foreignKey) => [foreignKey.name, foreignKey]),
  );
  for (const foreignKey of desired.foreignKeys ?? []) {
    const current = actual.foreignKeys.get(foreignKey.name);
    if (!current) {
      actions.push(automaticAction({
        kind: 'addForeignKey',
        sql: `ALTER TABLE ${qualifiedTable(name)} ADD ${postgresForeignKeySql(foreignKey, true)}`,
        algorithm: 'NOT VALID',
        reason: `enforce ${foreignKey.name} for new writes before validating existing rows`,
        table: name,
      }));
      actions.push(automaticAction({
        kind: 'validateForeignKey',
        sql: `ALTER TABLE ${qualifiedTable(name)} VALIDATE CONSTRAINT ${quotePostgresIdentifier(foreignKey.name)}`,
        algorithm: 'VALIDATE',
        reason: `validate existing rows for ${foreignKey.name}`,
        table: name,
      }));
    } else if (!foreignKeyMatches(current, foreignKey)) {
      actions.push(manualAction({
        kind: 'replaceForeignKey',
        sql: `ALTER TABLE ${qualifiedTable(name)} ADD ${postgresForeignKeySql(foreignKey, true)}`,
        algorithm: 'MANUAL',
        reason: `foreign key ${foreignKey.name} differs and requires an explicit replacement migration`,
        table: name,
      }));
    } else if (!current.validated) {
      actions.push(automaticAction({
        kind: 'validateForeignKey',
        sql: `ALTER TABLE ${qualifiedTable(name)} VALIDATE CONSTRAINT ${quotePostgresIdentifier(foreignKey.name)}`,
        algorithm: 'VALIDATE',
        reason: `complete validation for ${foreignKey.name}`,
        table: name,
      }));
    }
  }
  for (const foreignKey of actual.foreignKeys.values()) {
    if (!desiredForeignKeys.has(foreignKey.name)) {
      warnings.push(`foreign key public.${name}.${foreignKey.name} is not declared`);
    }
  }
}

export function planPostgresSchema(
  resource: string,
  schema: PostgresResourceSchema,
  actual: Map<string, ActualPostgresTable>,
): PostgresSchemaPlan {
  const actions: PostgresSchemaAction[] = [];
  const warnings: string[] = [];
  const deferred: PostgresSchemaAction[] = [];

  for (const [name, table] of Object.entries(schema.tables)) {
    const current = actual.get(name);
    if (current) {
      planExistingTable(name, table, current, actions, warnings);
      continue;
    }

    actions.push(automaticAction({
      kind: 'createTable',
      sql: createPostgresTableSql(name, table),
      algorithm: 'CREATE',
      reason: `create missing table public.${name}`,
      table: name,
    }));
    if (table.comment) {
      actions.push(automaticAction({
        kind: 'setTableComment',
        sql: commentOnTableSql(name, table.comment),
        algorithm: 'TRANSACTIONAL',
        reason: `set comment on public.${name}`,
        table: name,
      }));
    }
    for (const [column, definition] of Object.entries(table.columns)) {
      if (!definition.comment) continue;
      actions.push(automaticAction({
        kind: 'setColumnComment',
        sql: commentOnColumnSql(name, column, definition.comment),
        algorithm: 'TRANSACTIONAL',
        reason: `set comment on public.${name}.${column}`,
        table: name,
      }));
    }
    for (const index of table.indexes ?? []) {
      actions.push(automaticAction({
        kind: 'addIndex',
        sql: createPostgresIndexSql(name, index, false),
        algorithm: 'CREATE',
        reason: `create ${index.name} on new table public.${name}`,
        table: name,
      }));
    }
    for (const foreignKey of table.foreignKeys ?? []) {
      deferred.push(automaticAction({
        kind: 'addForeignKey',
        sql: `ALTER TABLE ${qualifiedTable(name)} ADD ${postgresForeignKeySql(foreignKey)}`,
        algorithm: 'CREATE',
        reason: `create ${foreignKey.name} after all new tables exist`,
        table: name,
      }));
    }
  }

  actions.push(...deferred);
  return { resource, version: schema.version, actions, warnings };
}
