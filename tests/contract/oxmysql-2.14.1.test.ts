import { describe, expect, test } from 'bun:test';
import contract from '../fixtures/oxmysql-2.14.1-contract.json' with { type: 'json' };
import {
  registerCompatibilityExports,
  type ExportFunction,
  type RuntimeBindings,
} from '../../src/api/compatibility.js';
import { serializeForRuntime } from '../../src/core/serialize.js';
import type { DatabaseService } from '../../src/core/database.js';

interface Harness {
  direct: Map<string, ExportFunction>;
  providers: Map<string, Map<string, ExportFunction>>;
}

function createHarness(database: Partial<DatabaseService>): Harness {
  const direct = new Map<string, ExportFunction>();
  const providers = new Map<string, Map<string, ExportFunction>>();
  const bindings: RuntimeBindings = {
    addExport(name, callback) {
      direct.set(name, callback);
    },
    addProviderExport(resource, name, callback) {
      let exports = providers.get(resource);
      if (!exports) {
        exports = new Map();
        providers.set(resource, exports);
      }
      exports.set(name, callback);
    },
    emitEvent() {},
    invokingResource: () => 'contract-fixture',
  };
  registerCompatibilityExports(database as DatabaseService, bindings, { legacyProviders: true });
  return { direct, providers };
}

function callbackResult(method: ExportFunction, ...args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    method(...args, (result: unknown, error?: string) => {
      if (error) reject(new Error(error));
      else resolve(result);
    });
  });
}

describe(`${contract.target} compatibility contract`, () => {
  test('registers the tagged query surface and promise aliases', () => {
    const { direct, providers } = createHarness({});
    const oxmysql = providers.get('oxmysql')!;

    for (const method of [...contract.queryMethods, ...contract.deprecatedMethods]) {
      expect(direct.has(method)).toBe(true);
      expect(direct.has(`${method}_async`)).toBe(true);
      expect(direct.has(`${method}Sync`)).toBe(true);
      expect(oxmysql.has(method)).toBe(true);
      expect(oxmysql.has(`${method}_async`)).toBe(true);
      expect(oxmysql.has(`${method}Sync`)).toBe(true);
    }
    expect(direct.has('store')).toBe(true);
    expect(direct.has('startTransaction')).toBe(true);
    expect(direct.has('awaitConnection')).toBe(true);
  });

  test('registers mysql-async and ghmattimysql aliases from the tag', () => {
    const { providers } = createHarness({});
    const mysqlAsync = providers.get('mysql-async')!;
    const ghmatti = providers.get('ghmattimysql')!;

    for (const alias of Object.keys(contract.mysqlAsyncAliases)) {
      expect(mysqlAsync.has(alias)).toBe(true);
    }
    for (const alias of Object.keys(contract.ghmattimysqlAliases)) {
      expect(ghmatti.has(alias)).toBe(true);
      expect(ghmatti.has(`${alias}Sync`)).toBe(true);
    }
  });

  test('preserves result shapes across callback, promise, and legacy aliases', async () => {
    const database: Partial<DatabaseService> = {
      query: async () => [{ id: 1, name: 'row' }],
      single: async () => ({ id: 1, name: 'row' }),
      scalar: async () => 42,
      insert: async () => 17,
      update: async () => 3,
      prepare: async () => ['first', 'second'],
      rawExecute: async () => [{ value: 4 }],
      transaction: async () => true,
    };
    const { direct, providers } = createHarness(database);

    await expect(callbackResult(direct.get('query')!, 'SELECT 1', [])).resolves.toEqual([
      { id: 1, name: 'row' },
    ]);
    await expect(direct.get('single_async')!('SELECT 1')).resolves.toEqual({ id: 1, name: 'row' });
    await expect(direct.get('scalarSync')!('SELECT 42')).resolves.toBe(42);
    await expect(direct.get('insert_async')!('INSERT')).resolves.toBe(17);
    await expect(direct.get('update_async')!('UPDATE')).resolves.toBe(3);
    await expect(direct.get('prepare_async')!('SELECT ?', [[1], [2]])).resolves.toEqual([
      'first',
      'second',
    ]);
    await expect(direct.get('rawExecute_async')!('SELECT 4')).resolves.toEqual([{ value: 4 }]);
    await expect(direct.get('transaction_async')!(['UPDATE table_name SET value = 1'])).resolves.toBe(
      true,
    );
    await expect(
      callbackResult(providers.get('mysql-async')!.get('mysql_fetch_scalar')!, 'SELECT 42', []),
    ).resolves.toBe(42);
    await expect(
      providers.get('ghmattimysql')!.get('executeSync')!('SELECT 1', []),
    ).resolves.toEqual([{ id: 1, name: 'row' }]);
  });

  test('supports stored queries and ghmattimysql storeSync', async () => {
    const { direct, providers } = createHarness({});
    await expect(callbackResult(direct.get('store')!, 'SELECT 1')).resolves.toBe('SELECT 1');
    expect(providers.get('ghmattimysql')!.get('storeSync')!('SELECT 2')).toBe('SELECT 2');
  });

  test('serializes values into CFX-safe representations', () => {
    expect(
      serializeForRuntime({
        bytes: Buffer.from([0, 127, 255]),
        timestamp: new Date(1_234),
        bigint: 9_007_199_254_740_993n,
        missing: undefined,
      }),
    ).toEqual({
      bytes: [0, 127, 255],
      timestamp: 1_234,
      bigint: '9007199254740993',
      missing: null,
    });
  });
});
