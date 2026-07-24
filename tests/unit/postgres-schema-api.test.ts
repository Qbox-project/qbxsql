import { describe, expect, test } from 'bun:test';
import {
  registerPostgresSchemaExports,
} from '../../src/api/postgres-schema.js';
import type {
  ExportFunction,
  RuntimeBindings,
} from '../../src/api/compatibility.js';
import {
  PostgresSchemaPendingChangesError,
  type PostgresSchemaManager,
} from '../../src/postgres-schema/manager.js';
import { PostgresExtensionRequirementError } from '../../src/postgres-extensions.js';
import type {
  PostgresResourceSchema,
  PostgresSchemaEnsureResult,
} from '../../src/postgres-schema/types.js';

const schema: PostgresResourceSchema = {
  version: 1,
  tables: {
    properties: {
      columns: { id: { type: 'integer', primary: true } },
    },
  },
};

const result: PostgresSchemaEnsureResult = {
  resource: 'housing',
  version: 1,
  actions: [],
  warnings: [],
  checksum: 'checksum',
  dryRun: false,
  appliedActions: [],
  appliedMigrations: [],
};

describe('PostgreSQL schema exports', () => {
  test('binds ownership to the invoking resource and returns callback results', async () => {
    const exports = new Map<string, ExportFunction>();
    let owner = '';
    const manager = {
      ensure: async (resource: string) => {
        owner = resource;
        return result;
      },
    } as unknown as PostgresSchemaManager;
    const bindings: RuntimeBindings = {
      addExport: (name, callback) => exports.set(name, callback),
      addProviderExport: () => {},
      invokingResource: () => 'housing',
    };
    registerPostgresSchemaExports(manager, bindings);

    const callbackResult = await new Promise((resolve, reject) => {
      exports.get('postgresEnsureSchema')!(
        schema,
        (value: unknown, error?: unknown) => error ? reject(error) : resolve(value),
      );
    });
    expect(owner).toBe('housing');
    expect(callbackResult).toEqual(result);
  });

  test('preserves a structured pending plan for callback callers', async () => {
    const exports = new Map<string, ExportFunction>();
    const pending = { ...result, dryRun: true };
    const manager = {
      ensure: async () => {
        throw new PostgresSchemaPendingChangesError(pending);
      },
    } as unknown as PostgresSchemaManager;
    registerPostgresSchemaExports(manager, {
      addExport: (name, callback) => exports.set(name, callback),
      addProviderExport: () => {},
      invokingResource: () => 'housing',
    });

    const error = await new Promise<Record<string, unknown>>((resolve) => {
      exports.get('postgresEnsureSchema')!(
        schema,
        (_value: unknown, failure?: Record<string, unknown>) => resolve(failure!),
      );
    });
    expect(error).toMatchObject({
      code: 'QBXSQL_POSTGRES_SCHEMA_PENDING_CHANGES',
      result: pending,
    });
  });

  test('returns actionable extension requirement errors and diagnostics', async () => {
    const exports = new Map<string, ExportFunction>();
    const report = {
      resource: 'housing',
      satisfied: false,
      checkedAt: 1,
      extensions: [{
        name: 'vector',
        state: 'not-installed' as const,
        availableVersion: '0.8.5',
        installedVersion: null,
        schema: null,
        message: 'enable vector',
      }],
    };
    const diagnostic = {
      checkedAt: 1,
      requirements: [report],
      installed: [],
    };
    const manager = {
      ensure: async () => {
        throw new PostgresExtensionRequirementError(report);
      },
      extensions: {
        diagnostics: async () => diagnostic,
      },
    } as unknown as PostgresSchemaManager;
    registerPostgresSchemaExports(manager, {
      addExport: (name, callback) => exports.set(name, callback),
      addProviderExport: () => {},
      invokingResource: () => 'housing',
    });

    const error = await new Promise<Record<string, unknown>>((resolve) => {
      exports.get('postgresEnsureSchema')!(
        schema,
        (_value: unknown, failure?: Record<string, unknown>) => resolve(failure!),
      );
    });
    expect(error).toMatchObject({
      code: 'QBXSQL_POSTGRES_EXTENSION_REQUIRED',
      extensions: report,
    });
    const returned = await new Promise((resolve, reject) => {
      exports.get('postgresGetExtensions')!(
        (value: unknown, failure?: unknown) => failure ? reject(failure) : resolve(value),
      );
    });
    expect(returned).toEqual(diagnostic);
  });
});
