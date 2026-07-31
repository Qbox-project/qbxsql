import {
  PostgresSchemaDisabledError,
  PostgresSchemaMigrationRequiredError,
  PostgresSchemaPendingChangesError,
  type PostgresSchemaManager,
} from '../postgres-schema/manager.js';
import type { PostgresResourceSchema } from '../postgres-schema/types.js';
import { PostgresExtensionRequirementError } from '../postgres-extensions.js';
import {
  createRuntimeBindings,
  schemaResource,
  SchemaResourceMismatchError,
  type ExportFunction,
  type RuntimeBindings,
} from './compatibility.js';
import type { PostgresApiError } from './postgres.js';

type SchemaCallback = (result: unknown, error?: PostgresApiError & {
  result?: unknown;
  plan?: unknown;
  extensions?: unknown;
}) => void;

function invokeCallback(
  callback: SchemaCallback | undefined,
  result: unknown,
  error?: PostgresApiError & { result?: unknown; plan?: unknown },
): void {
  if (!callback) return;
  try {
    callback(result, error);
  } catch (callbackError) {
    console.error('[qbxsql] PostgreSQL schema callback failed', callbackError);
  }
}

function errorPayload(error: unknown): PostgresApiError & {
  result?: unknown;
  plan?: unknown;
  extensions?: unknown;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof PostgresSchemaPendingChangesError) {
    return {
      code: 'QBXSQL_POSTGRES_SCHEMA_PENDING_CHANGES',
      message,
      result: error.result,
    };
  }
  if (error instanceof PostgresExtensionRequirementError) {
    return {
      code: error.code,
      message,
      extensions: error.report,
    };
  }
  if (error instanceof PostgresSchemaMigrationRequiredError) {
    return {
      code: 'QBXSQL_POSTGRES_SCHEMA_MIGRATION_REQUIRED',
      message,
      plan: error.plan,
    };
  }
  if (error instanceof PostgresSchemaDisabledError) {
    return { code: 'QBXSQL_POSTGRES_SCHEMA_DISABLED', message };
  }
  if (error instanceof SchemaResourceMismatchError) {
    return { code: error.code, message };
  }
  return { code: 'QBXSQL_POSTGRES_SCHEMA_ERROR', message };
}

export function registerPostgresSchemaExports(
  manager: PostgresSchemaManager,
  bindings: RuntimeBindings | null = createRuntimeBindings(),
): Record<string, ExportFunction> {
  const runtime: RuntimeBindings = bindings ?? {
    addExport() {},
    addProviderExport() {},
    invokingResource: () => 'unknown',
  };
  /** Returns null when the caller tried to act as another resource. */
  const resourceName = (
    explicit: string | undefined,
    callback: SchemaCallback | undefined,
  ): string | null => {
    try {
      return schemaResource(explicit, runtime);
    } catch (error) {
      const failure = errorPayload(error);
      console.error(`[qbxsql] PostgreSQL schema operation refused: ${failure.message}`);
      invokeCallback(callback, null, failure);
      return null;
    }
  };

  const api: Record<string, ExportFunction> = {
    postgresEnsureSchema(
      schema: PostgresResourceSchema,
      callback?: SchemaCallback,
      explicitResource?: string,
    ) {
      const resource = resourceName(explicitResource, callback);
      if (resource === null) return;
      void manager.ensure(resource, schema).then(
        (result) => invokeCallback(callback, result),
        (error: unknown) => {
          const failure = errorPayload(error);
          console.error(
            `[qbxsql] PostgreSQL schema operation failed [${resource}]: ${failure.message}`,
          );
          invokeCallback(callback, null, failure);
        },
      );
    },
    postgresPlanSchema(
      schema: PostgresResourceSchema,
      callback?: SchemaCallback,
      explicitResource?: string,
    ) {
      const resource = resourceName(explicitResource, callback);
      if (resource === null) return;
      void manager.plan(resource, schema).then(
        (result) => invokeCallback(callback, result),
        (error: unknown) => {
          const failure = errorPayload(error);
          console.error(
            `[qbxsql] PostgreSQL schema planning failed [${resource}]: ${failure.message}`,
          );
          invokeCallback(callback, null, failure);
        },
      );
    },
    postgresAdoptSchema(
      schema: PostgresResourceSchema,
      baselineVersion: number,
      callback?: SchemaCallback,
      explicitResource?: string,
    ) {
      const resource = resourceName(explicitResource, callback);
      if (resource === null) return;
      void manager.adopt(resource, schema, baselineVersion).then(
        (result) => invokeCallback(callback, result),
        (error: unknown) => {
          const failure = errorPayload(error);
          console.error(
            `[qbxsql] PostgreSQL schema adoption failed [${resource}]: ${failure.message}`,
          );
          invokeCallback(callback, null, failure);
        },
      );
    },
    postgresPlanSchemaAdoption(
      schema: PostgresResourceSchema,
      baselineVersion: number,
      callback?: SchemaCallback,
      explicitResource?: string,
    ) {
      const resource = resourceName(explicitResource, callback);
      if (resource === null) return;
      void manager.planAdoption(resource, schema, baselineVersion).then(
        (result) => invokeCallback(callback, result),
        (error: unknown) => {
          const failure = errorPayload(error);
          console.error(
            `[qbxsql] PostgreSQL schema adoption planning failed [${resource}]: ${failure.message}`,
          );
          invokeCallback(callback, null, failure);
        },
      );
    },
    postgresGetExtensions(callback?: SchemaCallback) {
      void manager.extensions.diagnostics().then(
        (result) => invokeCallback(callback, result),
        (error: unknown) => {
          const failure = errorPayload(error);
          console.error(`[qbxsql] PostgreSQL extension diagnostics failed: ${failure.message}`);
          invokeCallback(callback, null, failure);
        },
      );
    },
  };

  for (const [name, callback] of Object.entries(api)) runtime.addExport(name, callback);
  return api;
}

export function registerPostgresSchemaUnavailableExports(
  bindings: RuntimeBindings | null = createRuntimeBindings(),
  reason?: { code: string; message: string },
): void {
  if (!bindings) return;
  const unavailable = (...args: unknown[]) => {
    const callback = [...args].reverse().find((entry) => typeof entry === 'function') as
      | SchemaCallback
      | undefined;
    const error = reason ?? {
      code: 'QBXSQL_POSTGRES_NOT_CONFIGURED',
      message: 'PostgreSQL is not configured. Set qbxsql_postgres_connection_string.',
    };
    if (callback) callback(null, error);
    else throw Object.assign(new Error(error.message), { code: error.code });
  };
  for (const name of [
    'postgresEnsureSchema',
    'postgresPlanSchema',
    'postgresAdoptSchema',
    'postgresPlanSchemaAdoption',
    'postgresGetExtensions',
  ]) {
    bindings.addExport(name, unavailable);
  }
}
