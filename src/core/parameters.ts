import type { SqlParameter, SqlParameters } from './types.js';

interface ScanResult {
  sql: string;
  names: string[];
  positionalCount: number;
}

const identifierStart = /[A-Za-z0-9_]/;
const identifierPart = /[A-Za-z0-9_]/;
const scanCacheLimit = 4_096;
const positionalScans = new Map<string, ScanResult>();
const namedScans = new Map<string, ScanResult>();

function cacheScan(cache: Map<string, ScanResult>, input: string, result: ScanResult): ScanResult {
  if (cache.size >= scanCacheLimit) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(input, result);
  return result;
}

function parameterRecord(parameters: Record<string, SqlParameter>): Record<string, SqlParameter> {
  const normalized: Record<string, SqlParameter> = {};

  for (const [key, value] of Object.entries(parameters)) {
    const first = key[0];
    normalized[first === '@' || first === ':' ? key.slice(1) : key] = value;
  }

  return normalized;
}

function scanSqlUncached(input: string, replaceNamed: boolean): ScanResult {
  let sql = '';
  let positionalCount = 0;
  const names: string[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    const next = input[index + 1];

    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      sql += char;

      for (index += 1; index < input.length; index += 1) {
        const quoted = input[index]!;
        sql += quoted;

        if (quoted === '\\' && index + 1 < input.length) {
          index += 1;
          sql += input[index]!;
          continue;
        }

        if (quoted === quote) {
          if (input[index + 1] === quote) {
            index += 1;
            sql += quote;
            continue;
          }
          break;
        }
      }
      continue;
    }

    if (char === '/' && next === '*') {
      const end = input.indexOf('*/', index + 2);
      if (end === -1) {
        sql += input.slice(index);
        break;
      }
      sql += input.slice(index, end + 2);
      index = end + 1;
      continue;
    }

    if (
      char === '#' ||
      (char === '-' && next === '-' && /\s/.test(input[index + 2] ?? ''))
    ) {
      const end = input.indexOf('\n', index + 1);
      if (end === -1) {
        sql += input.slice(index);
        break;
      }
      sql += input.slice(index, end + 1);
      index = end;
      continue;
    }

    if (char === '?') {
      positionalCount += 1;
      sql += char;
      if (next === '?') {
        index += 1;
        sql += '?';
      }
      continue;
    }

    if (
      replaceNamed &&
      (char === ':' || char === '@') &&
      next !== char &&
      next !== undefined &&
      identifierStart.test(next)
    ) {
      let end = index + 2;
      while (end < input.length && identifierPart.test(input[end]!)) end += 1;
      names.push(input.slice(index + 1, end));
      positionalCount += 1;
      sql += '?';
      index = end - 1;
      continue;
    }

    sql += char;
  }

  return { sql, names, positionalCount };
}

function scanSql(input: string, replaceNamed: boolean): ScanResult {
  const cache = replaceNamed ? namedScans : positionalScans;
  return cache.get(input) ?? cacheScan(cache, input, scanSqlUncached(input, replaceNamed));
}

export function countPlaceholders(sql: string): number {
  return scanSql(sql, false).positionalCount;
}

export function normalizeParameters(
  query: string,
  parameters?: SqlParameters,
  convertNamedPlaceholders = true,
): [query: string, parameters: SqlParameter[]] {
  if (typeof query !== 'string') {
    throw new TypeError(`Expected query to be a string but received ${typeof query}.`);
  }

  if (parameters === undefined || parameters === null) {
    const count = countPlaceholders(query);
    return [query, new Array<SqlParameter>(count).fill(null)];
  }

  if (!Array.isArray(parameters)) {
    const record = parameterRecord(parameters as Record<string, SqlParameter>);
    const namedScan = scanSql(query, convertNamedPlaceholders);

    if (namedScan.names.length > 0) {
      return [
        namedScan.sql,
        namedScan.names.map((name) => record[name] ?? null),
      ];
    }

    const count = namedScan.positionalCount;
    if (count === 1 && !Object.keys(record).some((key) => /^\d+$/.test(key))) {
      return [query, [record]];
    }

    const base = Object.hasOwn(record, '0') ? 0 : 1;
    const positional = Array.from<SqlParameter>({ length: count });
    for (let index = 0; index < count; index += 1) {
      positional[index] = record[String(index + base)] ?? null;
    }
    return [query, positional];
  }

  const values = [...parameters] as SqlParameter[];
  const expected = countPlaceholders(query);

  if (expected > 0 && values.length > expected) {
    throw new Error(`Expected ${expected} parameters, but received ${values.length}.`);
  }

  while (values.length < expected) values.push(null);
  return [query, values.map((value) => value ?? null)];
}
