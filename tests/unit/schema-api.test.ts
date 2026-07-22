import { describe, expect, test } from 'bun:test';
import { registerSchemaExports } from '../../src/api/schema.js';
import type { ExportFunction, RuntimeBindings } from '../../src/api/compatibility.js';
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
      ensure: async (resource: string, _schema: unknown, dryRun: boolean) => {
        calls.push({ resource, dryRun });
        return { ...result, dryRun };
      },
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
  });
});

