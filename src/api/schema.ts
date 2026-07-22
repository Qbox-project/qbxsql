import type { SchemaManager } from '../schema/manager.js';
import type { ResourceSchema } from '../schema/types.js';
import {
  createRuntimeBindings,
  type CfxCallback,
  type ExportFunction,
  type RuntimeBindings,
} from './compatibility.js';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  function resourceName(explicit?: string): string {
    return explicit && explicit.length > 0 ? explicit : runtime.invokingResource();
  }

  function operation(
    schema: ResourceSchema,
    dryRun: boolean,
    callback?: CfxCallback,
    explicitResource?: string,
  ): void {
    const resource = resourceName(explicitResource);
    void (dryRun ? manager.plan(resource, schema) : manager.ensure(resource, schema))
      .then((result) => callback?.(result))
      .catch((error: unknown) => {
        const errorMessage = message(error);
        console.error(`[qbxsql] schema operation failed [${resource}]: ${errorMessage}`);
        callback?.(null, errorMessage);
      });
  }

  function adoptionOperation(
    schema: ResourceSchema,
    baselineVersion: number,
    dryRun: boolean,
    callback?: CfxCallback,
    explicitResource?: string,
  ): void {
    const resource = resourceName(explicitResource);
    void (dryRun
      ? manager.planAdoption(resource, schema, baselineVersion)
      : manager.adopt(resource, schema, baselineVersion)
    )
      .then((result) => callback?.(result))
      .catch((error: unknown) => {
        const errorMessage = message(error);
        console.error(`[qbxsql] schema adoption failed [${resource}]: ${errorMessage}`);
        callback?.(null, errorMessage);
      });
  }

  const api: Record<string, ExportFunction> = {
    ensureSchema(
      schema: ResourceSchema,
      callback?: CfxCallback,
      explicitResource?: string,
    ): void {
      operation(schema, false, callback, explicitResource);
    },
    planSchema(
      schema: ResourceSchema,
      callback?: CfxCallback,
      explicitResource?: string,
    ): void {
      operation(schema, true, callback, explicitResource);
    },
    adoptSchema(
      schema: ResourceSchema,
      baselineVersion: number,
      callback?: CfxCallback,
      explicitResource?: string,
    ): void {
      adoptionOperation(schema, baselineVersion, false, callback, explicitResource);
    },
    planSchemaAdoption(
      schema: ResourceSchema,
      baselineVersion: number,
      callback?: CfxCallback,
      explicitResource?: string,
    ): void {
      adoptionOperation(schema, baselineVersion, true, callback, explicitResource);
    },
  };

  for (const [name, callback] of Object.entries(api)) {
    runtime.addExport(name, callback);
    if (name === 'adoptSchema' || name === 'planSchemaAdoption') {
      runtime.addExport(
        `${name}_async`,
        (schema: ResourceSchema, baselineVersion: number, explicitResource?: string) =>
          new Promise((resolve, reject) => {
            callback(
              schema,
              baselineVersion,
              (result: unknown, error?: string) => {
                if (error) reject(new Error(error));
                else resolve(result);
              },
              explicitResource,
            );
          }),
      );
    } else {
      runtime.addExport(`${name}_async`, (schema: ResourceSchema, explicitResource?: string) =>
        new Promise((resolve, reject) => {
          callback(
            schema,
            (result: unknown, error?: string) => {
              if (error) reject(new Error(error));
              else resolve(result);
            },
            explicitResource,
          );
        }),
      );
    }
  }

  return api;
}
