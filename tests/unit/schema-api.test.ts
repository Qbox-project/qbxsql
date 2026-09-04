import { describe, expect, test } from 'bun:test';
import { registerSchemaExports } from '../../src/api/schema.js';
import type { ExportFunction, RuntimeBindings } from '../../src/api/compatibility.js';
import { SchemaPendingChangesError } from '../../src/schema/manager.js';
import type { SchemaEnsureResult } from '../../src/schema/types.js';

describe('schema exports', () => {
  test('binds schema ownership to the invoking resource', async () => {
    const calls: Array<{ resource: string; dryRun: boolean }> = [];
    const result: SchemaEnsureResult = {
      resource: 'housing',
      version: 1,
      actions: [],
      warnings: [],
      checksum: 'test',
      dryRun: false,
      appliedActions: [],
      appliedMigrations: [],
    };
    const manager = {
      ensure: async (resource: string) => {
        calls.push({ resource, dryRun: false });
        return result;
      },
      plan: async (resource: string) => {
        calls.push({ resource, dryRun: true });
        return { ...result, dryRun: true };
      },
      adopt: async (resource: string, _schema: unknown, baselineVersion: number) => ({
        ...result,
        resource,
        adoption: true,
        baselineVersion,
      }),
      planAdoption: async (resource: string, _schema: unknown, baselineVersion: number) => ({
        ...result,
        resource,
        dryRun: true,
        adoption: true,
        baselineVersion,
      }),
    };
    const exports = new Map<string, ExportFunction>();
    const bindings: RuntimeBindings = {
      addExport: (name, callback) => exports.set(name, callback),
      addProviderExport() {},
      invokingResource: () => 'housing',
    };

    registerSchemaExports(manager as never, bindings);
    const plan = exports.get('planSchema_async')!;
    expect(await plan({ version: 1, tables: {} })).toMatchObject({ dryRun: true });
    expect(calls).toEqual([{ resource: 'housing', dryRun: true }]);

    const adoption = exports.get('planSchemaAdoption_async')!;
    expect(await adoption({ version: 2, tables: {} }, 1)).toMatchObject({
      adoption: true,
      baselineVersion: 1,
      resource: 'housing',
    });
  });

  test('refuses to manage schemas on behalf of another resource', async () => {
    const calls: string[] = [];
    const manager = {
      ensure: async (resource: string) => {
        calls.push(resource);
        return { resource };
      },
      adopt: async (resource: string) => {
        calls.push(resource);
        return { resource };
      },
    };
    const exports = new Map<string, ExportFunction>();
    registerSchemaExports(manager as never, {
      addExport: (name, callback) => exports.set(name, callback),
      addProviderExport() {},
      invokingResource: () => 'evil_resource',
    });

    await expect(
      exports.get('ensureSchema_async')!({ version: 1, tables: {} }, 'qbx_core'),
    ).rejects.toMatchObject({ code: 'QBXSQL_SCHEMA_RESOURCE_MISMATCH' });
    await expect(
      exports.get('adoptSchema_async')!({ version: 1, tables: {} }, 1, 'qbx_core'),
    ).rejects.toMatchObject({ code: 'QBXSQL_SCHEMA_RESOURCE_MISMATCH' });
    expect(calls).toEqual([]);

    // The shim's own name is still accepted, and so is omitting it.
    await exports.get('ensureSchema_async')!({ version: 1, tables: {} }, 'evil_resource');
    await exports.get('ensureSchema_async')!({ version: 1, tables: {} });
    expect(calls).toEqual(['evil_resource', 'evil_resource']);
  });

  test('accepts the shim name when the runtime attributes the call to the connector itself', async () => {
    const calls: string[] = [];
    const manager = {
      ensure: async (resource: string) => {
        calls.push(resource);
        return { resource };
      },
    };
    const exports = new Map<string, ExportFunction>();
    registerSchemaExports(manager as never, {
      addExport: (name, callback) => exports.set(name, callback),
      addProviderExport() {},
      // Some server builds report the connector as the invoker of its own
      // cross-runtime exports; the claimed name must stand in, as for 'unknown'.
      invokingResource: () => 'qbxsql',
    });

    await exports.get('ensureSchema_async')!({ version: 1, tables: {} }, 'qbx_core');
    expect(calls).toEqual(['qbx_core']);
  });

  test('preserves the structured pending plan across callback and promise exports', async () => {
    const pending: SchemaEnsureResult = {
      resource: 'housing',
      version: 2,
      actions: [
        {
          kind: 'alterColumn',
          sql: 'ALTER TABLE `properties` MODIFY `label` VARCHAR(100)',
          safe: true,
          dataSafe: true,
          onlineSafe: true,
          automatic: true,
          risk: 'low',
          algorithm: 'INPLACE',
          reason: 'widen label',
          table: 'properties',
        },
      ],
      warnings: [],
      checksum: 'pending',
      dryRun: true,
      appliedActions: [],
      appliedMigrations: [],
    };
    const manager = {
      ensure: async () => {
        throw new SchemaPendingChangesError(pending);
      },
    };
    const exports = new Map<string, ExportFunction>();
    registerSchemaExports(manager as never, {
      addExport: (name, callback) => exports.set(name, callback),
      addProviderExport() {},
      invokingResource: () => 'housing',
    });

    const callbackError = await new Promise<unknown>((resolve) => {
      exports.get('ensureSchema')!({ version: 2, tables: {} }, (_result: unknown, error: unknown) =>
        resolve(error),
      );
    });
    expect(callbackError).toMatchObject({
      code: 'QBXSQL_SCHEMA_PENDING_CHANGES',
      result: pending,
    });

    await expect(exports.get('ensureSchema_async')!({ version: 2, tables: {} })).rejects.toMatchObject({
      code: 'QBXSQL_SCHEMA_PENDING_CHANGES',
      result: pending,
    });
  });

  test('delivers refusals without unhandled rejections when the callback returns a rejecting promise', async () => {
    const manager = {
      ensure: async () => {
        throw new Error('dropColumn requires allowDataLoss=true.');
      },
    };
    const exports = new Map<string, ExportFunction>();
    registerSchemaExports(manager as never, {
      addExport: (name, callback) => exports.set(name, callback),
      addProviderExport() {},
      invokingResource: () => 'housing',
    });

    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    const originalError = console.error;
    console.error = () => {};
    try {
      const delivered = await new Promise<unknown>((resolve) => {
        exports.get('ensureSchema')!({ version: 1, tables: {} }, (_result: unknown, error: unknown) => {
          resolve(error);
          // CFX function references return a promise for the invoking
          // runtime's completion; simulate that continuation failing after
          // the refusal was already delivered and handled.
          return Promise.reject(new Error('mirrored continuation failure'));
        });
      });
      expect(delivered).toMatchObject({ code: 'QBXSQL_SCHEMA_ERROR' });
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      console.error = originalError;
      process.off('unhandledRejection', listener);
    }
    expect(unhandled).toEqual([]);
  });
});
