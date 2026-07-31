import type { SqlParameter, SqlParameters } from './types.js';

const scanCacheLimit = 4_096;
const maximumPostgresParameters = 65_535;
const placeholderCache = new Map<string, number>();

function cachePlaceholderCount(sql: string, count: number): number {
  if (placeholderCache.size >= scanCacheLimit) {
    const oldest = placeholderCache.keys().next().value;
    if (oldest !== undefined) placeholderCache.delete(oldest);
  }
  placeholderCache.set(sql, count);
  return count;
}

function skipQuoted(sql: string, start: number, quote: "'" | '"'): number {
  for (let index = start + 1; index < sql.length; index += 1) {
    if (sql[index] === '\\' && quote === "'") {
      index += 1;
      continue;
    }
    if (sql[index] !== quote) continue;
    if (sql[index + 1] === quote) {
      index += 1;
      continue;
    }
    return index;
  }
  return sql.length - 1;
}

function dollarQuoteTag(sql: string, start: number): string | null {
  const match = /^(?:\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$)/.exec(sql.slice(start));
  return match?.[0] ?? null;
}

export function countPostgresPlaceholders(sql: string): number {
  const cached = placeholderCache.get(sql);
  if (cached !== undefined) return cached;

  let maximum = 0;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    const next = sql[index + 1];

    if (char === "'" || char === '"') {
      index = skipQuoted(sql, index, char);
      continue;
    }

    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index + 2);
      if (end === -1) break;
      index = end;
      continue;
    }

    if (char === '/' && next === '*') {
      let depth = 1;
      index += 2;
      for (; index < sql.length && depth > 0; index += 1) {
        if (sql[index] === '/' && sql[index + 1] === '*') {
          depth += 1;
          index += 1;
        } else if (sql[index] === '*' && sql[index + 1] === '/') {
          depth -= 1;
          index += 1;
        }
      }
      index -= 1;
      continue;
    }

    if (char !== '$') continue;
    if (next && /[1-9]/.test(next)) {
      let end = index + 2;
      while (end < sql.length && /\d/.test(sql[end]!)) end += 1;
      const parameter = Number.parseInt(sql.slice(index + 1, end), 10);
      if (!Number.isSafeInteger(parameter) || parameter > maximumPostgresParameters) {
        throw new Error(
          `PostgreSQL parameter number exceeds the supported maximum of ${maximumPostgresParameters}.`,
        );
      }
      maximum = Math.max(maximum, parameter);
      index = end - 1;
      continue;
    }

    const tag = dollarQuoteTag(sql, index);
    if (!tag) continue;
    const end = sql.indexOf(tag, index + tag.length);
    if (end === -1) break;
    index = end + tag.length - 1;
  }

  return cachePlaceholderCount(sql, maximum);
}

function numericRecord(
  parameters: Record<string, SqlParameter>,
  expected: number,
): SqlParameter[] | null {
  const entries = Object.entries(parameters);
  if (entries.length === 0) return expected === 0 ? [] : new Array(expected).fill(null);
  if (!entries.every(([key]) => /^\d+$/.test(key))) return null;

  const base = Object.hasOwn(parameters, '0') ? 0 : 1;
  const highest = Math.max(...entries.map(([key]) => Number(key))) - base + 1;
  if (highest > expected) {
    throw new Error(`Expected ${expected} PostgreSQL parameters, but received ${highest}.`);
  }
  const values = Array.from<SqlParameter>({ length: expected });
  for (let index = 0; index < expected; index += 1) {
    values[index] = parameters[String(index + base)] ?? null;
  }
  return values;
}

export function normalizePostgresParameters(
  query: string,
  parameters?: SqlParameters,
): [query: string, parameters: SqlParameter[]] {
  if (typeof query !== 'string') {
    throw new TypeError(`Expected query to be a string but received ${typeof query}.`);
  }

  const expected = countPostgresPlaceholders(query);
  if (parameters === undefined || parameters === null) {
    return [query, new Array<SqlParameter>(expected).fill(null)];
  }

  // Scalars, Buffers, and Dates bind as one value rather than being read as a
  // record of positional keys.
  const isRecord =
    !Array.isArray(parameters) &&
    typeof parameters === 'object' &&
    !Buffer.isBuffer(parameters) &&
    !(parameters instanceof Date);

  if (isRecord) {
    const record = parameters as Record<string, SqlParameter>;
    const numeric = numericRecord(record, expected);
    if (numeric) return [query, numeric];
    if (expected === 1) return [query, [record]];
    throw new Error(
      'PostgreSQL queries use $1, $2 positional parameters; named parameter objects are not supported.',
    );
  }

  const values = (
    Array.isArray(parameters) ? [...parameters] : [parameters]
  ) as SqlParameter[];
  if (values.length > expected) {
    throw new Error(`Expected ${expected} PostgreSQL parameters, but received ${values.length}.`);
  }
  while (values.length < expected) values.push(null);
  return [query, values.map((value) => value ?? null)];
}
