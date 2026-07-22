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

export interface SchemaCapabilities {
  instantAddColumn: boolean;
  inplaceAlterColumn: boolean;
  inplaceAddIndex: boolean;
}

const currentCapabilities: SchemaCapabilities = {
  instantAddColumn: true,
  inplaceAlterColumn: true,
  inplaceAddIndex: true,
};

export function capabilitiesForVersion(serverVersion: string | null): SchemaCapabilities {
  if (!serverVersion) return { ...currentCapabilities };
  const match = serverVersion.match(/^(\d+)\.(\d+)/);
  const major = Number(match?.[1] ?? 0);
  const minor = Number(match?.[2] ?? 0);
  const mariaDb = /mariadb/i.test(serverVersion);
  return {
    instantAddColumn: mariaDb ? major > 10 || (major === 10 && minor >= 3) : major >= 8,
    inplaceAlterColumn: mariaDb ? major >= 10 : major >= 8,
    inplaceAddIndex: mariaDb ? major >= 10 : major >= 8,
  };
}

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

export function parseEnumValues(columnType: string): string[] {
  if (!columnType.toLowerCase().startsWith('enum(') || !columnType.endsWith(')')) return [];
  const source = columnType.slice(columnType.indexOf('(') + 1, -1);
  const values: string[] = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (!quoted) {
      if (character === "'") quoted = true;
      continue;
    }
    if (character === '\\') {
      index += 1;
      value += source[index] ?? '';
    } else if (character === "'" && source[index + 1] === "'") {
      value += "'";
      index += 1;
    } else if (character === "'") {
      values.push(value);
      value = '';
      quoted = false;
    } else {
      value += character;
    }
  }

  return values;
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

  if (targetType === 'enum') {
    const desiredValues = desired.values ?? [];
    const actualValues = parseEnumValues(actual.columnType);
    if (!sameColumns(desiredValues, actualValues)) {
      changed = true;
      const preservesExistingValues = actualValues.every(
        (value, index) => desiredValues[index] === value,
      );
      if (!preservesExistingValues) safe = false;
      reasons.push(`enum (${actualValues.join(', ')}) -> (${desiredValues.join(', ')})`);
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

  const desiredOnUpdate = Boolean(desired.onUpdateCurrentTimestamp);
  const actualOnUpdate = /on update current_timestamp(?:\([0-6]\))?/i.test(actual.extra);
  if (desiredOnUpdate !== actualOnUpdate) {
    changed = true;
    reasons.push(desiredOnUpdate ? 'add ON UPDATE CURRENT_TIMESTAMP' : 'remove ON UPDATE CURRENT_TIMESTAMP');
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
  const normalizeAction = (value: string): string =>
    value === 'NO ACTION' ? 'RESTRICT' : value;
  return (
    sameColumns(desired.columns, actual.columns) &&
    desired.references.table === actual.referencedTable &&
    sameColumns(desired.references.columns, actual.referencedColumns) &&
    normalizeAction(desired.onDelete ?? 'RESTRICT') === normalizeAction(actual.onDelete) &&
    normalizeAction(desired.onUpdate ?? 'RESTRICT') === normalizeAction(actual.onUpdate)
  );
}

function action(
  actions: SchemaAction[],
  value: Omit<
    SchemaAction,
    'table' | 'dataSafe' | 'onlineSafe' | 'automatic' | 'risk' | 'algorithm'
  > & {
    table?: string;
    onlineSafe?: boolean;
    algorithm?: SchemaAction['algorithm'];
    risk?: SchemaAction['risk'];
  },
): void {
  const dataSafe = value.safe;
  const onlineSafe = value.onlineSafe ?? false;
  actions.push({
    ...value,
    dataSafe,
    onlineSafe,
    automatic: dataSafe && onlineSafe,
    risk: value.risk ?? (dataSafe ? (onlineSafe ? 'low' : 'medium') : 'high'),
    algorithm: value.algorithm ?? 'MANUAL',
  });
}

function onlineAlterSql(
  table: string,
  clause: string,
  algorithm: 'INSTANT' | 'INPLACE',
): string {
  const enforcement = algorithm === 'INSTANT' ? 'ALGORITHM=INSTANT' : 'ALGORITHM=INPLACE, LOCK=NONE';
  return `ALTER TABLE ${quoteIdentifier(table)} ${clause}, ${enforcement}`;
}

function varcharWideningIsOnline(
  desired: ColumnDefinition,
  actual: ActualColumn,
  table: ActualTable,
): boolean {
  if (desired.type !== 'varchar' || actual.type !== 'varchar') return true;
  const from = actual.maximumLength;
  const to = desired.length;
  if (from === null || to === undefined || to <= from) return true;
  const collation = table.collation?.toLowerCase() ?? '';
  const bytesPerCharacter = collation.startsWith('utf8mb4_')
    ? 4
    : collation.startsWith('utf8_') || collation.startsWith('utf8mb3_')
      ? 3
      : collation.startsWith('ucs2_')
        ? 2
        : 1;
  const oneByteLimit = Math.floor(255 / bytesPerCharacter);
  return !(from <= oneByteLimit && to > oneByteLimit);
}

function orderedTables(
  schema: ResourceSchema,
  actualTables: Map<string, ActualTable>,
): { entries: Array<[string, TableDefinition]>; inlineForeignKeys: Set<string> } {
  const entries = Object.entries(schema.tables);
  const pending = new Map(entries.filter(([name]) => !actualTables.has(name)));
  const ordered: Array<[string, TableDefinition]> = entries.filter(([name]) => actualTables.has(name));
  const available = new Set(actualTables.keys());
  const inlineForeignKeys = new Set<string>();

  while (pending.size > 0) {
    let progressed = false;
    for (const [name, table] of pending) {
      const dependencies = (table.foreignKeys ?? [])
        .map((foreignKey) => foreignKey.references.table)
        .filter((dependency) => dependency !== name);
      if (dependencies.every((dependency) => available.has(dependency))) {
        ordered.push([name, table]);
        inlineForeignKeys.add(name);
        available.add(name);
        pending.delete(name);
        progressed = true;
      }
    }
    if (progressed) continue;
    for (const entry of pending) ordered.push(entry);
    break;
  }

  return { entries: ordered, inlineForeignKeys };
}

export function planSchema(
  resource: string,
  schema: ResourceSchema,
  actualTables: Map<string, ActualTable>,
  capabilities: SchemaCapabilities = currentCapabilities,
): SchemaPlan {
  const actions: SchemaAction[] = [];
  const warnings: string[] = [];
  const createdTables = new Set<string>();
  const ordering = orderedTables(schema, actualTables);

  for (const [tableName, table] of ordering.entries) {
    const actual = actualTables.get(tableName);
    if (!actual) {
      createdTables.add(tableName);
      action(actions, {
        kind: 'createTable',
        table: tableName,
        sql: createTableSql(tableName, table, ordering.inlineForeignKeys.has(tableName)),
        safe: true,
        onlineSafe: true,
        algorithm: 'CREATE',
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
          sql: onlineAlterSql(
            tableName,
            `ADD COLUMN ${columnSql(columnName, column)}`,
            capabilities.instantAddColumn ? 'INSTANT' : 'INPLACE',
          ),
          safe,
          onlineSafe: capabilities.instantAddColumn || capabilities.inplaceAlterColumn,
          algorithm: capabilities.instantAddColumn ? 'INSTANT' : 'INPLACE',
          reason: safe
            ? `add compatible column '${tableName}.${columnName}'`
            : `adding required column '${tableName}.${columnName}' needs an explicit backfill migration`,
        });
        continue;
      }

      const change = compareColumn(columnName, column, actualColumn);
      if (change.changed) {
        const onlineSafe =
          capabilities.inplaceAlterColumn && varcharWideningIsOnline(column, actualColumn, actual);
        action(actions, {
          kind: 'alterColumn',
          table: tableName,
          sql: onlineAlterSql(
            tableName,
            `MODIFY COLUMN ${columnSql(columnName, column)}`,
            'INPLACE',
          ),
          safe: change.safe,
          onlineSafe,
          algorithm: 'INPLACE',
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
          onlineSafe: false,
          algorithm: 'MANUAL',
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
          sql: onlineAlterSql(tableName, `ADD ${indexSql(index)}`, 'INPLACE'),
          safe: !index.unique,
          onlineSafe: capabilities.inplaceAddIndex,
          algorithm: 'INPLACE',
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
          onlineSafe: false,
          algorithm: 'MANUAL',
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
          onlineSafe: false,
          algorithm: 'MANUAL',
          reason: `foreign key '${foreignKey.name}' requires existing-row validation`,
        });
      } else if (!sameForeignKey(foreignKey, actualForeignKey)) {
        action(actions, {
          kind: 'replaceForeignKey',
          table: tableName,
          sql: `ALTER TABLE ${quoteIdentifier(tableName)} DROP FOREIGN KEY ${quoteIdentifier(foreignKey.name)}, ADD ${foreignKeySql(foreignKey)}`,
          safe: false,
          onlineSafe: false,
          algorithm: 'MANUAL',
          reason: `changing foreign key '${foreignKey.name}' requires an explicit migration`,
        });
      }
    }

    const desiredIndexNames = new Set((table.indexes ?? []).map((index) => index.name));
    for (const [indexName, index] of actual.indexes) {
      if (!index.primary && !desiredIndexNames.has(indexName)) {
        warnings.push(
          `Table '${tableName}' contains unmanaged index '${indexName}'; qbxsql will not drop it automatically.`,
        );
      }
    }

    const desiredForeignKeyNames = new Set(
      (table.foreignKeys ?? []).map((foreignKey) => foreignKey.name),
    );
    for (const foreignKeyName of actual.foreignKeys.keys()) {
      if (!desiredForeignKeyNames.has(foreignKeyName)) {
        warnings.push(
          `Table '${tableName}' contains unmanaged foreign key '${foreignKeyName}'; qbxsql will not drop it automatically.`,
        );
      }
    }

    const desiredEngine = table.engine ?? 'InnoDB';
    if (actual.engine.toLowerCase() !== desiredEngine.toLowerCase()) {
      action(actions, {
        kind: 'alterTableEngine',
        table: tableName,
        sql: `ALTER TABLE ${quoteIdentifier(tableName)} ENGINE=${desiredEngine}`,
        safe: false,
        onlineSafe: false,
        algorithm: 'MANUAL',
        reason: `table engine ${actual.engine || '?'} -> ${desiredEngine}`,
      });
    }

    const desiredCharset = table.charset ?? 'utf8mb4';
    const charsetChanged = actual.charset?.toLowerCase() !== desiredCharset.toLowerCase();
    const collationChanged =
      table.collation !== undefined && actual.collation?.toLowerCase() !== table.collation.toLowerCase();
    if (charsetChanged || collationChanged) {
      const collation = table.collation ? ` COLLATE ${table.collation}` : '';
      action(actions, {
        kind: 'alterTableCharset',
        table: tableName,
        sql: `ALTER TABLE ${quoteIdentifier(tableName)} CONVERT TO CHARACTER SET ${desiredCharset}${collation}`,
        safe: false,
        onlineSafe: false,
        algorithm: 'MANUAL',
        reason: `table charset/collation ${actual.charset ?? '?'}/${actual.collation ?? '?'} -> ${desiredCharset}/${table.collation ?? 'database default'}`,
      });
    }
  }

  for (const tableName of createdTables) {
    if (ordering.inlineForeignKeys.has(tableName)) continue;
    for (const foreignKey of schema.tables[tableName]?.foreignKeys ?? []) {
      action(actions, {
        kind: 'addForeignKey',
        table: tableName,
        sql: addForeignKeySql(tableName, foreignKey),
        safe: false,
        onlineSafe: false,
        algorithm: 'MANUAL',
        reason: `cyclic foreign key '${foreignKey.name}' requires an explicit migration`,
      });
    }
  }

  return { resource, version: schema.version, actions, warnings };
}
