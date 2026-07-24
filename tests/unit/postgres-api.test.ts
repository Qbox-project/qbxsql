import { describe, expect, test } from 'bun:test';
import {
  registerPostgresExports,
  type PostgresApiError,
} from '../../src/api/postgres.js';
import type { ExportFunction, RuntimeBindings } from '../../src/api/compatibility.js';
import type { DatabaseService } from '../../src/core/database.js';

describe('PostgreSQL native exports', () => {
  test('registers callbacks with native result and structured error semantics', async () => {
    const exports = new Map<string, ExportFunction>();
    const bindings: RuntimeBindings = {
      addExport: (name, callback) => exports.set(name, callback),
      addProviderExport: () => {},
      invokingResource: () => 'housing',
    };
    const database = {
      state: 'ready',
      awaitConnection: async () => {},
      query: async () => [{ id: '1' }],
      single: async () => ({ id: '1' }),
      scalar: async () => '1',
      executeResult: async () => ({
        command: 'UPDATE',
        affectedRows: 1,
        rows: [{ id: '1' }],
        fields: [],
      }),
      transactionResults: async () => [{
        command: 'INSERT',
        affectedRows: 1,
        rows: [{ id: '2' }],
        fields: [],
      }],
      withTransaction: async () => true,
    } as unknown as DatabaseService;
    registerPostgresExports(database, bindings);

    expect(exports.has('postgresQuery')).toBe(true);
    const executeResult = await new Promise((resolve, reject) => {
      exports.get('postgresExecute')!(
        'UPDATE properties SET owner = $1 RETURNING id',
        ['abc'],
        (result: unknown, error?: PostgresApiError) => error ? reject(error) : resolve(result),
      );
    });
    expect(executeResult).toEqual({
      command: 'UPDATE',
      rowCount: 1,
      rows: [{ id: '1' }],
      fields: [],
    });

    const transactionResult = await new Promise((resolve, reject) => {
      exports.get('postgresTransaction')!(
        [{ query: 'INSERT INTO properties DEFAULT VALUES RETURNING id' }],
        (result: unknown, error?: PostgresApiError) => error ? reject(error) : resolve(result),
      );
    });
    expect(transactionResult).toEqual([{
      command: 'INSERT',
      rowCount: 1,
      rows: [{ id: '2' }],
      fields: [],
    }]);
  });

  test('returns PostgreSQL error fields without query parameters or credentials', async () => {
    const exports = new Map<string, ExportFunction>();
    const database = {
      state: 'ready',
      query: async () => {
        throw Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'properties_owner_key',
        });
      },
    } as unknown as DatabaseService;
    registerPostgresExports(database, {
      addExport: (name, callback) => exports.set(name, callback),
      addProviderExport: () => {},
      invokingResource: () => 'housing',
    });

    const error = await new Promise<PostgresApiError>((resolve) => {
      exports.get('postgresQuery')!(
        'SELECT $1',
        ['secret'],
        (_result: unknown, failure?: PostgresApiError) => resolve(failure!),
      );
    });
    expect(error).toMatchObject({
      code: '23505',
      message: 'duplicate key',
      constraint: 'properties_owner_key',
    });
    expect(JSON.stringify(error)).not.toContain('secret');
  });
});
