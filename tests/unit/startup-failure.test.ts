import { describe, expect, test } from 'bun:test';
import {
  registerMySqlUnavailableExports,
  type ExportFunction,
  type RuntimeBindings,
} from '../../src/api/compatibility.js';
import { registerSchemaUnavailableExports } from '../../src/api/schema.js';
import { registerPostgresUnavailableExports } from '../../src/api/postgres.js';
import { registerPostgresSchemaUnavailableExports } from '../../src/api/postgres-schema.js';

function collect(): { exports: Map<string, ExportFunction>; bindings: RuntimeBindings } {
  const exports = new Map<string, ExportFunction>();
  return {
    exports,
    bindings: {
      addExport: (name, callback) => exports.set(name, callback),
      addProviderExport: (resource, name, callback) =>
        exports.set(`${resource}:${name}`, callback),
      invokingResource: () => 'consumer',
    },
  };
}

const startupReason = {
  code: 'QBXSQL_STARTUP_FAILED',
  message: "qbxsql failed to start: Connection-string option 'port' must be an integer.",
};

describe('startup failure exports', () => {
  test('reports the startup failure through the MySQL query surface', async () => {
    const { exports, bindings } = collect();
    registerMySqlUnavailableExports(bindings, {
      legacyProviders: true,
      unavailableReason: startupReason,
    });

    // The names must exist, or dependent resources fail with "No such export".
    for (const name of ['query', 'single', 'insert', 'update', 'transaction', 'execute']) {
      expect(exports.has(name)).toBe(true);
      expect(exports.has(`${name}_async`)).toBe(true);
    }
    expect(exports.get('isReady')!()).toBe(false);

    const reported = await new Promise<unknown>((resolve) => {
      exports.get('query')!('SELECT 1', [], (_result: unknown, error: unknown) => resolve(error));
    });
    expect(reported).toContain('must be an integer');
    expect(() => exports.get('query')!('SELECT 1')).toThrow('must be an integer');
  });

  test('reports the startup failure through both schema surfaces', async () => {
    const { exports, bindings } = collect();
    registerSchemaUnavailableExports(bindings, startupReason);
    registerPostgresSchemaUnavailableExports(bindings, startupReason);

    for (const name of ['ensureSchema', 'planSchema', 'adoptSchema', 'planSchemaAdoption']) {
      expect(exports.has(name)).toBe(true);
    }
    const failure = await new Promise<any>((resolve) => {
      exports.get('ensureSchema')!({ version: 1, tables: {} }, (_r: unknown, error: unknown) =>
        resolve(error),
      );
    });
    expect(failure).toMatchObject({ code: 'QBXSQL_STARTUP_FAILED' });

    await expect(exports.get('ensureSchema_async')!({ version: 1, tables: {} })).rejects.toThrow(
      'must be an integer',
    );
    expect(exports.has('postgresEnsureSchema')).toBe(true);
  });

  test('falls back to the not-configured message when no reason is given', () => {
    const { exports, bindings } = collect();
    registerPostgresUnavailableExports(bindings);
    expect(exports.get('postgresIsReady')!()).toBe(false);
    expect(() => exports.get('postgresQuery')!('SELECT 1')).toThrow();
  });
});
