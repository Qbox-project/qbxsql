import { describe, expect, test } from 'bun:test';
import {
  normalizeTransactionStatements,
  registerCompatibilityExports,
  type ExportFunction,
  type RuntimeBindings,
} from '../../src/api/compatibility.js';
import type { DatabaseService } from '../../src/core/database.js';

function deferred(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function compatibilityHarness(database: Partial<DatabaseService>) {
  const direct = new Map<string, ExportFunction>();
  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const bindings: RuntimeBindings = {
    addExport: (name, callback) => direct.set(name, callback),
    addProviderExport: () => {},
    emitEvent: (name, payload) => events.push({ name, payload }),
    invokingResource: () => 'test-resource',
  };

  registerCompatibilityExports(database as DatabaseService, bindings);
  return { direct, events };
}

describe('legacy transaction normalization', () => {
  test('applies shared parameters to string statements', () => {
    expect(normalizeTransactionStatements(['UPDATE a SET value = @value'], { value: 2 })).toEqual([
      { query: 'UPDATE a SET value = @value', parameters: { value: 2 } },
    ]);
  });

  test('accepts query objects with values or parameters', () => {
    expect(
      normalizeTransactionStatements([
        { query: 'SELECT ?', values: [1] },
        { query: 'SELECT ?', parameters: [2] },
      ]),
    ).toEqual([
      { query: 'SELECT ?', parameters: [1] },
      { query: 'SELECT ?', parameters: [2] },
    ]);
  });

  test('accepts tuple statements and CFX numeric-key tuple tables', () => {
    expect(
      normalizeTransactionStatements([
        ['SELECT ?', [1]],
        { 1: 'SELECT ?', 2: { 1: 2 } },
      ]),
    ).toEqual([
      { query: 'SELECT ?', parameters: [1] },
      { query: 'SELECT ?', parameters: { 1: 2 } },
    ]);
  });

  test('rejects malformed transaction entries', () => {
    expect(() => normalizeTransactionStatements([{}])).toThrow('missing a query string');
  });
});

describe('compatibility provider registration', () => {
  test('keeps legacy provider listeners disabled in the core by default', () => {
    const providers: string[] = [];
    registerCompatibilityExports({} as DatabaseService, {
      addExport() {},
      addProviderExport: (resource, name) => providers.push(`${resource}:${name}`),
      invokingResource: () => 'test-resource',
    });

    expect(providers).toEqual([]);
  });

  test('lets a physical bridge own only the oxmysql provider exports', () => {
    const providers: string[] = [];
    registerCompatibilityExports(
      {} as DatabaseService,
      {
        addExport() {},
        addProviderExport: (resource, name) => providers.push(`${resource}:${name}`),
        invokingResource: () => 'test-resource',
      },
      { legacyProviders: true, oxmysqlProvider: false },
    );

    expect(providers.some((entry) => entry.startsWith('oxmysql:'))).toBe(false);
    expect(providers).toContain('mysql-async:mysql_fetch_all');
    expect(providers).toContain('ghmattimysql:execute');
  });
});

describe('oxmysql error semantics', () => {
  test('logs ordinary callback failures without invoking the callback', async () => {
    const { direct, events } = compatibilityHarness({
      query: async () => {
        throw new Error('database exploded');
      },
    });
    let callbackInvoked = false;
    const originalError = console.error;
    console.error = () => {};

    try {
      direct.get('query')!('SELECT broken', [], () => {
        callbackInvoked = true;
      });
      await deferred();
    } finally {
      console.error = originalError;
    }

    expect(callbackInvoked).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('oxmysql:error');
    expect(events[0]?.payload).toMatchObject({
      query: 'SELECT broken',
      message: 'database exploded',
      resource: 'test-resource',
    });
  });

  test('returns callback errors only when explicitly requested', async () => {
    const { direct } = compatibilityHarness({
      query: async () => {
        throw new Error('requested error');
      },
    });

    const result = await new Promise<[unknown, string | undefined]>((resolve) => {
      direct.get('query')!(
        'SELECT broken',
        ['private-probe-value'],
        (value: unknown, error?: string) => resolve([value, error]),
        'opt-in-resource',
        true,
      );
    });

    expect(result[0]).toBeNull();
    expect(result[1]).toContain('requested error');
    expect(result[1]).toContain('["private-probe-value"]');
  });

  test('emits normalized query parameters on database errors', async () => {
    const { direct, events } = compatibilityHarness({
      normalize: () => ['SELECT ?, ?', ['first', null]],
      query: async () => {
        throw new Error('normalized failure');
      },
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      direct.get('query')!('SELECT ?, ?', { 1: 'first' });
      await deferred();
    } finally {
      console.error = originalError;
    }

    expect(events[0]?.payload).toMatchObject({
      query: 'SELECT ?, ?',
      parameters: ['first', null],
      message: 'normalized failure',
    });
  });

  test('omits parameters from prepared execution callback errors like oxmysql', async () => {
    const { direct } = compatibilityHarness({
      prepare: async () => {
        throw new Error('prepared failure');
      },
    });

    const result = await new Promise<[unknown, string | undefined]>((resolve) => {
      direct.get('prepare')!(
        'SELECT ?',
        ['private-probe-value'],
        (value: unknown, error?: string) => resolve([value, error]),
        'opt-in-resource',
        true,
      );
    });

    expect(result[0]).toBeNull();
    expect(result[1]).toContain('prepared failure');
    expect(result[1]).not.toContain('private-probe-value');
  });

  test('rejects promise exports with the database error', async () => {
    const { direct } = compatibilityHarness({
      query: async () => {
        throw new Error('promise failure');
      },
    });

    await expect(direct.get('query_async')!('SELECT broken')).rejects.toThrow('promise failure');
  });

  test('isolates thrown callbacks without a second invocation or database error event', async () => {
    const { direct, events } = compatibilityHarness({
      query: async () => [{ value: 1 }],
    });
    let calls = 0;
    const originalError = console.error;
    console.error = () => {};
    try {
      direct.get('query')!('SELECT 1', [], () => {
        calls += 1;
        throw new Error('consumer callback failed');
      });
      await deferred();
    } finally {
      console.error = originalError;
    }

    expect(calls).toBe(1);
    expect(events).toEqual([]);
  });

  test('emits oxmysql:error when a callback transaction fails and still resolves false', async () => {
    const { direct, events } = compatibilityHarness({
      startTransaction: async (_work, _resource, onError) => {
        onError?.(new Error('callback transaction deadlock'));
        return false;
      },
    });

    await expect(direct.get('startTransaction')!(async () => true)).resolves.toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: 'oxmysql:error',
      payload: {
        message: 'callback transaction deadlock',
        resource: 'test-resource',
      },
    });
  });

  test('registers functional lifecycle, store, and callback-transaction aliases', () => {
    const { direct } = compatibilityHarness({});
    for (const name of [
      'isReady_async',
      'isReadySync',
      'awaitConnection_async',
      'awaitConnectionSync',
      'store_async',
      'storeSync',
      'startTransaction_async',
      'startTransactionSync',
    ]) {
      expect(direct.has(name)).toBe(true);
    }
  });

  test('resolves failed statement-list transactions as false and emits the compatibility event', async () => {
    const { direct, events } = compatibilityHarness({
      transaction: async () => {
        throw new Error('deadlock');
      },
    });
    const originalError = console.error;
    console.error = () => {};

    try {
      await expect(
        direct.get('transaction_async')!(['UPDATE account SET balance = balance - 1']),
      ).resolves.toBe(false);
      await deferred();
    } finally {
      console.error = originalError;
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('oxmysql:transaction-error');
    expect(events[0]?.payload).toMatchObject({ message: 'deadlock', resource: 'test-resource' });
  });
});
