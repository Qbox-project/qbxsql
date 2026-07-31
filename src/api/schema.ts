import {
  SchemaDisabledError,
  SchemaMigrationRequiredError,
  SchemaPendingChangesError,
  type SchemaManager,
} from '../schema/manager.js';
import type { ResourceSchema } from '../schema/types.js';
import {
  createRuntimeBindings,
  schemaResource,
  SchemaResourceMismatchError,
  type ExportFunction,
  type RuntimeBindings,
} from './compatibility.js';

interface SchemaApiError {
  code: string;
  message: string;
  result?: unknown;
  plan?: unknown;
}

type SchemaCallback = (result: unknown, error?: SchemaApiError) => void;

function errorPayload(error: unknown): SchemaApiError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SchemaPendingChangesError) {
    return { code: 'QBXSQL_SCHEMA_PENDING_CHANGES', message, result: error.result };
  }
  if (error instanceof SchemaMigrationRequiredError) {
    return { code: 'QBXSQL_SCHEMA_MIGRATION_REQUIRED', message, plan: error.plan };
  }
  if (error instanceof SchemaDisabledError) {
    return { code: 'QBXSQL_SCHEMA_DISABLED', message };
  }
  if (error instanceof SchemaResourceMismatchError) {
    return { code: error.code, message };
  }
  return { code: 'QBXSQL_SCHEMA_ERROR', message };
}

export function registerSchemaUnavailableExports(
  bindings: RuntimeBindings | null = createRuntimeBindings(),
  reason?: SchemaApiError,
): void {
  if (!bindings) return;
  const failure = reason ?? {
    code: 'QBXSQL_MYSQL_NOT_CONFIGURED',
    message: 'MySQL is not configured. Set mysql_connection_string or qbxsql_mysql_connection_string.',
  };
  const unavailable = (...args: unknown[]) => {
    const callback = [...args].reverse().find((entry) => typeof entry === 'function') as
      | SchemaCallback
      | undefined;
    if (callback) {
      callback(null, failure);
      return;
    }
    throw Object.assign(new Error(failure.message), { code: failure.code });
  };
  const promiseUnavailable = async () => {
    throw Object.assign(new Error(failure.message), { code: failure.code });
  };
  for (const name of ['ensureSchema', 'planSchema', 'adoptSchema', 'planSchemaAdoption']) {
    bindings.addExport(name, unavailable);
    bindings.addExport(`${name}_async`, promiseUnavailable);
  }
}

export function registerSchemaExports(
  manager: SchemaManager,
  bindings: RuntimeBindings | null = createRuntimeBindings(),
): Record<string, ExportFunction> {
  const runtime: RuntimeBindings = bindings ?? {
    addExport() {},
    addProviderExport() {},
    invokingResource: () => 'unknown',
  };

  function refuse(callback: SchemaCallback | undefined, error: unknown): void {
    const failure = errorPayload(error);
    console.error(`[qbxsql] schema operation refused: ${failure.message}`);
    callback?.(null, failure);
  }

  function operation(
    schema: ResourceSchema,
    dryRun: boolean,
    callback?: SchemaCallback,
    explicitResource?: string,
  ): void {
    let resource: string;
    try {
      resource = schemaResource(explicitResource, runtime);
    } catch (error) {
      refuse(callback, error);
      return;
    }
    void (dryRun ? manager.plan(resource, schema) : manager.ensure(resource, schema))
      .then((result) => callback?.(result))
      .catch((error: unknown) => {
        const failure = errorPayload(error);
        console.error(`[qbxsql] schema operation failed [${resource}]: ${failure.message}`);
        callback?.(null, failure);
      });
  }

  function adoptionOperation(
    schema: ResourceSchema,
    baselineVersion: number,
    dryRun: boolean,
    callback?: SchemaCallback,
    explicitResource?: string,
  ): void {
    let resource: string;
    try {
      resource = schemaResource(explicitResource, runtime);
    } catch (error) {
      refuse(callback, error);
      return;
    }
    void (dryRun
      ? manager.planAdoption(resource, schema, baselineVersion)
      : manager.adopt(resource, schema, baselineVersion)
    )
      .then((result) => callback?.(result))
      .catch((error: unknown) => {
        const failure = errorPayload(error);
        console.error(`[qbxsql] schema adoption failed [${resource}]: ${failure.message}`);
        callback?.(null, failure);
      });
  }

  const api: Record<string, ExportFunction> = {
    ensureSchema(
      schema: ResourceSchema,
      callback?: SchemaCallback,
      explicitResource?: string,
    ): void {
      operation(schema, false, callback, explicitResource);
    },
    planSchema(
      schema: ResourceSchema,
      callback?: SchemaCallback,
      explicitResource?: string,
    ): void {
      operation(schema, true, callback, explicitResource);
    },
    adoptSchema(
      schema: ResourceSchema,
      baselineVersion: number,
      callback?: SchemaCallback,
      explicitResource?: string,
    ): void {
      adoptionOperation(schema, baselineVersion, false, callback, explicitResource);
    },
    planSchemaAdoption(
      schema: ResourceSchema,
      baselineVersion: number,
      callback?: SchemaCallback,
      explicitResource?: string,
    ): void {
      adoptionOperation(schema, baselineVersion, true, callback, explicitResource);
    },
  };

  for (const [name, callback] of Object.entries(api)) {
    runtime.addExport(name, callback);
    if (name === 'adoptSchema' || name === 'planSchemaAdoption') {
      const asyncCallback = (
        schema: ResourceSchema,
        baselineVersion: number,
        explicitResource?: string,
      ) =>
          new Promise((resolve, reject) => {
            callback(
              schema,
              baselineVersion,
              (result: unknown, error?: SchemaApiError) => {
                if (error) reject(error);
                else resolve(result);
              },
              explicitResource,
            );
          });
      runtime.addExport(`${name}_async`, asyncCallback);
    } else {
      const asyncCallback = (schema: ResourceSchema, explicitResource?: string) =>
        new Promise((resolve, reject) => {
          callback(
            schema,
            (result: unknown, error?: SchemaApiError) => {
              if (error) reject(error);
              else resolve(result);
            },
            explicitResource,
          );
        });
      runtime.addExport(`${name}_async`, asyncCallback);
    }
  }

  return api;
}
