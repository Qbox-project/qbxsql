import { detachCallbackResult } from './callback.js';
import type { DatabaseService } from '../core/database.js';
import type { DriverResult, SqlParameters } from '../core/types.js';
import {
  createRuntimeBindings,
  normalizeTransactionStatements,
  type ExportFunction,
  type RuntimeBindings,
} from './compatibility.js';

export interface PostgresApiError {
  code: string;
  message: string;
  severity?: string;
  detail?: string;
  hint?: string;
  schema?: string;
  table?: string;
  column?: string;
  constraint?: string;
}

type PostgresCallback = (result: unknown, error?: PostgresApiError) => void;

function errorPayload(error: unknown): PostgresApiError {
  const source = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : {};
  const payload: PostgresApiError = {
    code: typeof source.code === 'string' ? source.code : 'QBXSQL_POSTGRES_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
  for (const key of ['severity', 'detail', 'hint', 'schema', 'table', 'column', 'constraint'] as const) {
    if (typeof source[key] === 'string') payload[key] = source[key];
  }
  return payload;
}

function resourceName(explicit: unknown, runtime: RuntimeBindings): string {
  return typeof explicit === 'string' && explicit.length > 0
    ? explicit
    : runtime.invokingResource();
}

function extractCallback(
  parameters: SqlParameters | PostgresCallback | undefined,
  callback?: PostgresCallback,
): [SqlParameters | undefined, PostgresCallback | undefined] {
  if (typeof parameters === 'function') return [undefined, parameters];
  return [parameters, callback];
}

function invokeCallback(
  callback: PostgresCallback | undefined,
  result: unknown,
  error?: PostgresApiError,
): void {
  if (!callback) return;
  try {
    detachCallbackResult(callback(result, error));
  } catch (callbackError) {
    console.error('[qbxsql] PostgreSQL callback failed', callbackError);
  }
}

function publicResult(result: DriverResult): Record<string, unknown> {
  return {
    command: result.command ?? '',
    rowCount: result.affectedRows ?? 0,
    rows: result.rows,
    fields: result.fields,
  };
}

export function registerPostgresExports(
  database: DatabaseService,
  bindings: RuntimeBindings | null = createRuntimeBindings(),
): Record<string, ExportFunction> {
  const runtime: RuntimeBindings = bindings ?? {
    addExport() {},
    addProviderExport() {},
    invokingResource: () => 'unknown',
  };

  function queryMethod(
    operation: 'query' | 'single' | 'scalar',
  ): ExportFunction {
    return (
      query: string,
      parameters: SqlParameters | PostgresCallback = [],
      callback?: PostgresCallback,
      explicitResource?: string,
    ) => {
      const [values, resolvedCallback] = extractCallback(parameters, callback);
      const resource = resourceName(explicitResource, runtime);
      void database[operation](query, values, { invokingResource: resource }).then(
        (result) => invokeCallback(resolvedCallback, result),
        (error: unknown) => invokeCallback(resolvedCallback, null, errorPayload(error)),
      );
    };
  }

  const api: Record<string, ExportFunction> = {
    postgresIsReady: () => database.state === 'ready',
    postgresAwaitConnection: async () => {
      await database.awaitConnection();
      return true;
    },
    postgresQuery: queryMethod('query'),
    postgresSingle: queryMethod('single'),
    postgresScalar: queryMethod('scalar'),
    postgresExecute(
      query: string,
      parameters: SqlParameters | PostgresCallback = [],
      callback?: PostgresCallback,
      explicitResource?: string,
    ) {
      const [values, resolvedCallback] = extractCallback(parameters, callback);
      const resource = resourceName(explicitResource, runtime);
      void database.executeResult(query, values, { invokingResource: resource }).then(
        (result) => invokeCallback(resolvedCallback, publicResult(result)),
        (error: unknown) => invokeCallback(resolvedCallback, null, errorPayload(error)),
      );
    },
    postgresTransaction(
      queries: unknown,
      callback?: PostgresCallback,
      explicitResource?: string,
    ) {
      const resource = resourceName(explicitResource, runtime);
      let statements;
      try {
        statements = normalizeTransactionStatements(queries);
      } catch (error) {
        invokeCallback(callback, null, errorPayload(error));
        return;
      }
      void database.transactionResults(statements, resource).then(
        (results) => invokeCallback(callback, results.map(publicResult)),
        (error: unknown) => invokeCallback(callback, null, errorPayload(error)),
      );
    },
    postgresStartTransaction(
      work: (query: (sql: string, parameters?: SqlParameters) => Promise<unknown>) => Promise<unknown>,
      explicitResource?: string,
    ) {
      return database.withTransaction(work, resourceName(explicitResource, runtime));
    },
  };

  for (const [name, method] of Object.entries(api)) runtime.addExport(name, method);
  return api;
}

export function registerPostgresUnavailableExports(
  bindings: RuntimeBindings | null = createRuntimeBindings(),
  reason?: { code: string; message: string },
): void {
  const runtime = bindings;
  if (!runtime) return;
  const failure = reason ?? {
    code: 'QBXSQL_POSTGRES_NOT_CONFIGURED',
    message: 'PostgreSQL is not configured. Set qbxsql_postgres_connection_string.',
  };
  const unavailable = () => {
    throw { ...failure };
  };
  for (const name of [
    'postgresAwaitConnection',
    'postgresQuery',
    'postgresSingle',
    'postgresScalar',
    'postgresExecute',
    'postgresTransaction',
    'postgresStartTransaction',
  ]) {
    runtime.addExport(name, unavailable);
  }
  runtime.addExport('postgresIsReady', () => false);
}
