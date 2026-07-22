import type { DatabaseService } from '../core/database.js';
import type { SqlParameters, TransactionStatement } from '../core/types.js';

export type CfxCallback = (result: unknown, error?: string) => void;
export type ExportFunction = (...args: any[]) => unknown;

interface LegacyTransactionStatement {
  query?: string;
  parameters?: SqlParameters;
  values?: SqlParameters;
}

export interface RuntimeBindings {
  addExport(name: string, callback: ExportFunction): void;
  addProviderExport(resource: string, name: string, callback: ExportFunction): void;
  emitEvent?(name: string, payload: Record<string, unknown>): void;
  invokingResource(): string;
}

export interface CompatibilityRegistrationOptions {
  legacyProviders?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractCallback(
  parameters: SqlParameters | CfxCallback,
  callback?: CfxCallback,
): [SqlParameters | undefined, CfxCallback | undefined] {
  if (typeof parameters === 'function') return [undefined, parameters];
  return [parameters, callback];
}

function queryResource(explicit: unknown, bindings: RuntimeBindings): string {
  return typeof explicit === 'string' && explicit.length > 0 ? explicit : bindings.invokingResource();
}

export function normalizeTransactionStatements(
  input: unknown,
  sharedParameters?: SqlParameters,
): TransactionStatement[] {
  if (!Array.isArray(input)) throw new TypeError('Transaction queries must be an array.');

  return input.map((entry, index) => {
    if (typeof entry === 'string') {
      const statement: TransactionStatement = { query: entry };
      if (sharedParameters !== undefined) statement.parameters = sharedParameters;
      return statement;
    }

    if (!entry || typeof entry !== 'object') {
      throw new TypeError(`Transaction query at index ${index} is invalid.`);
    }

    const legacy = entry as LegacyTransactionStatement;
    if (typeof legacy.query !== 'string') {
      throw new TypeError(`Transaction query at index ${index} is missing a query string.`);
    }

    const statement: TransactionStatement = { query: legacy.query };
    const parameters = legacy.parameters ?? legacy.values ?? sharedParameters;
    if (parameters !== undefined) statement.parameters = parameters;
    return statement;
  });
}

export function createRuntimeBindings(): RuntimeBindings | null {
  const runtimeExports = (globalThis as unknown as { exports?: ExportFunction }).exports;
  if (typeof runtimeExports !== 'function' || typeof on !== 'function') return null;

  return {
    addExport(name, callback) {
      runtimeExports(name, callback);
    },
    addProviderExport(resource, name, callback) {
      on(`__cfx_export_${resource}_${name}`, (setCallback: (value: ExportFunction) => void) => {
        setCallback(callback);
      });
    },
    emitEvent(name, payload) {
      if (typeof emit === 'function') emit(name, payload);
    },
    invokingResource() {
      if (typeof GetInvokingResource !== 'function') return 'unknown';
      return GetInvokingResource() ?? 'unknown';
    },
  };
}

export function registerCompatibilityExports(
  database: DatabaseService,
  bindings = createRuntimeBindings(),
  options: CompatibilityRegistrationOptions = {},
): Record<string, ExportFunction> {
  const fallbackBindings: RuntimeBindings = {
    addExport() {},
    addProviderExport() {},
    emitEvent() {},
    invokingResource: () => 'unknown',
  };
  const runtime = bindings ?? fallbackBindings;
  const legacyProviders = options.legacyProviders === true;

  function operationError(
    error: unknown,
    callback: CfxCallback | undefined,
    returnCallbackErrors: boolean,
    resource: string,
    query?: string,
    parameters?: SqlParameters,
  ): void {
    const message = errorMessage(error);
    const output = `${resource} was unable to execute a query!${query ? `\nQuery: ${query}` : ''}\n${message}`;

    runtime.emitEvent?.('oxmysql:error', {
      query,
      parameters,
      message,
      err: error,
      resource,
    });

    if (callback && returnCallbackErrors) {
      callback(null, output);
      return;
    }

    console.error(output);
  }

  function callbackOperation(
    operation: Promise<unknown>,
    callback: CfxCallback | undefined,
    resource: string,
    returnCallbackErrors: boolean,
    query?: string,
    parameters?: SqlParameters,
  ): void {
    void operation
      .then((result) => callback?.(result))
      .catch((error: unknown) =>
        operationError(error, callback, returnCallbackErrors, resource, query, parameters),
      );
  }

  function queryMethod(method: 'query' | 'single' | 'scalar' | 'insert' | 'update') {
    return (
      query: string,
      parameters: SqlParameters | CfxCallback = [],
      callback?: CfxCallback,
      explicitResource?: string,
      returnCallbackErrors = false,
    ): void => {
      const [values, resolvedCallback] = extractCallback(parameters, callback);
      const resource = queryResource(explicitResource, runtime);
      callbackOperation(
        database[method](query, values, { invokingResource: resource }),
        resolvedCallback,
        resource,
        returnCallbackErrors,
        query,
        values,
      );
    };
  }

  const api: Record<string, ExportFunction> = {
    isReady: () => database.state === 'ready',
    awaitConnection: async () => {
      await database.awaitConnection();
      return true;
    },
    getStatus: () => database.getStatus(),
    query: queryMethod('query'),
    single: queryMethod('single'),
    scalar: queryMethod('scalar'),
    insert: queryMethod('insert'),
    update: queryMethod('update'),
    prepare(
      query: string,
      parameters: SqlParameters | CfxCallback = [],
      callback?: CfxCallback,
      explicitResource?: string,
      returnCallbackErrors = false,
    ) {
      const [values, resolvedCallback] = extractCallback(parameters, callback);
      const resource = queryResource(explicitResource, runtime);
      callbackOperation(
        database.prepare(query, values, { invokingResource: resource }),
        resolvedCallback,
        resource,
        returnCallbackErrors,
        query,
        values,
      );
    },
    rawExecute(
      query: string,
      parameters: SqlParameters | CfxCallback = [],
      callback?: CfxCallback,
      explicitResource?: string,
      returnCallbackErrors = false,
    ) {
      const [values, resolvedCallback] = extractCallback(parameters, callback);
      const resource = queryResource(explicitResource, runtime);
      callbackOperation(
        database.rawExecute(query, values, { invokingResource: resource }),
        resolvedCallback,
        resource,
        returnCallbackErrors,
        query,
        values,
      );
    },
    transaction(
      queries: unknown,
      parameters: SqlParameters | CfxCallback = [],
      callback?: CfxCallback,
      explicitResource?: string,
      returnCallbackErrors = false,
    ) {
      const [sharedParameters, resolvedCallback] = extractCallback(parameters, callback);
      const resource = queryResource(explicitResource, runtime);
      let statements: TransactionStatement[];
      try {
        statements = normalizeTransactionStatements(queries, sharedParameters);
      } catch (error) {
        operationError(
          error,
          resolvedCallback,
          returnCallbackErrors,
          resource,
          undefined,
          sharedParameters,
        );
        return;
      }
      void database
        .transaction(statements, resource)
        .then((result) => resolvedCallback?.(result))
        .catch((error: unknown) => {
          const message = errorMessage(error);
          const failedQuery =
            typeof error === 'object' && error && 'sql' in error
              ? String((error as { sql?: unknown }).sql ?? '')
              : statements.map((statement) => statement.query).join('; ');

          runtime.emitEvent?.('oxmysql:transaction-error', {
            query: failedQuery,
            parameters: sharedParameters,
            message,
            err: error,
            resource,
          });
          console.error(
            `${resource} was unable to complete a transaction!\n${failedQuery}\n${message}`,
          );
          resolvedCallback?.(false);
        });
    },
    store(query: string, callback?: CfxCallback) {
      callback?.(query);
      return query;
    },
    startTransaction(
      work: (query: (sql: string, parameters?: SqlParameters) => Promise<unknown>) => Promise<unknown>,
      explicitResource?: string,
    ) {
      return database.startTransaction(work, queryResource(explicitResource, runtime));
    },
  };

  api.execute = api.query!;
  api.fetch = api.query!;

  const asyncExport = (method: ExportFunction): ExportFunction => {
    return (query: unknown, parameters: unknown = [], explicitResource?: string) =>
      new Promise((resolve, reject) => {
        method(
          query,
          parameters,
          (result: unknown, error?: string) => {
            if (error) reject(new Error(error));
            else resolve(result);
          },
          explicitResource,
          true,
        );
      });
  };

  for (const [name, method] of Object.entries(api)) {
    runtime.addExport(name, method);
    if (legacyProviders) runtime.addProviderExport('oxmysql', name, method);

    if (!['isReady', 'awaitConnection', 'getStatus', 'store', 'startTransaction'].includes(name)) {
      const promiseMethod = asyncExport(method);
      runtime.addExport(`${name}_async`, promiseMethod);
      runtime.addExport(`${name}Sync`, promiseMethod);
      if (legacyProviders) {
        runtime.addProviderExport('oxmysql', `${name}_async`, promiseMethod);
        runtime.addProviderExport('oxmysql', `${name}Sync`, promiseMethod);
      }
    }
  }

  const mysqlAsyncAliases: Record<string, ExportFunction> = {
    mysql_fetch_all: api.query!,
    mysql_fetch_scalar: api.scalar!,
    mysql_execute: api.update!,
    mysql_insert: api.insert!,
    mysql_transaction: api.transaction!,
    mysql_store: api.store!,
  };
  if (legacyProviders) {
    for (const [name, method] of Object.entries(mysqlAsyncAliases)) {
      runtime.addProviderExport('mysql-async', name, method);
    }
  }

  const ghmattiAliases: Record<string, ExportFunction> = {
    execute: api.query!,
    scalar: api.scalar!,
    transaction: api.transaction!,
    store: api.store!,
  };
  if (legacyProviders) {
    for (const [name, method] of Object.entries(ghmattiAliases)) {
      runtime.addProviderExport('ghmattimysql', name, method);
      runtime.addProviderExport(
        'ghmattimysql',
        `${name}Sync`,
        name === 'store'
          ? (query: string) => api.store!(query)
          : asyncExport(method),
      );
    }
  }

  return api;
}
