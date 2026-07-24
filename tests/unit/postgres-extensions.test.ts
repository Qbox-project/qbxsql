import { describe, expect, test } from 'bun:test';
import { parsePostgresVector } from '../../src/drivers/postgres.js';
import {
  comparePostgresExtensionVersions,
  PostgresExtensionRegistry,
  PostgresExtensionRequirementError,
} from '../../src/postgres-extensions.js';
import type { DatabaseService } from '../../src/core/database.js';

function registry() {
  let refreshes = 0;
  const database = {
    driver: {
      databaseName: 'fivem',
      refreshExtensionTypes: async () => {
        refreshes += 1;
      },
    },
    query: async (sql: string) => {
      if (sql.includes('pg_available_extensions')) {
        return [
          {
            name: 'vector',
            availableVersion: '0.8.5',
            installedVersion: '0.8.5',
            schema: 'public',
          },
          {
            name: 'pg_trgm',
            availableVersion: '1.6',
            installedVersion: null,
            schema: null,
          },
          {
            name: 'postgis',
            availableVersion: '3.6.1',
            installedVersion: '3.4.0',
            schema: 'public',
          },
        ];
      }
      if (sql.includes('FROM pg_catalog.pg_extension extension')) {
        return [{
          name: 'vector',
          version: '0.8.5',
          schema: 'public',
        }];
      }
      return [];
    },
  } as unknown as DatabaseService;
  return {
    value: new PostgresExtensionRegistry(database),
    refreshes: () => refreshes,
  };
}

describe('PostgreSQL extension capabilities', () => {
  test('compares common extension version formats naturally', () => {
    expect(comparePostgresExtensionVersions('0.8.5', '0.8.4')).toBeGreaterThan(0);
    expect(comparePostgresExtensionVersions('1.10', '1.9')).toBeGreaterThan(0);
    expect(comparePostgresExtensionVersions('3.4.0', '3.4.0')).toBe(0);
  });

  test('distinguishes unavailable, disabled, outdated, and ready extensions', async () => {
    const { value } = registry();
    const report = await value.check('housing', [
      { name: 'vector', minimumVersion: '0.8.0' },
      { name: 'pg_trgm' },
      { name: 'postgis', minimumVersion: '3.5.0' },
      { name: 'missing_extension' },
    ]);
    expect(report.satisfied).toBe(false);
    expect(report.extensions.map((extension) => extension.state)).toEqual([
      'ready',
      'not-installed',
      'version-too-old',
      'unavailable',
    ]);
    expect(report.extensions[1]?.message).toContain('CREATE EXTENSION');
    expect(report.extensions[3]?.message).toContain('server package');
  });

  test('rejects unsatisfied requirements and refreshes parsers when ready', async () => {
    const { value, refreshes } = registry();
    await expect(value.require('housing', [{ name: 'missing_extension' }]))
      .rejects.toBeInstanceOf(PostgresExtensionRequirementError);
    await value.require('embeddings', [{ name: 'vector', minimumVersion: '0.8.5' }]);
    expect(refreshes()).toBe(1);
    const diagnostic = await value.diagnostics();
    expect(diagnostic.installed).toEqual([
      { name: 'vector', version: '0.8.5', schema: 'public' },
    ]);
  });

  test('parses finite pgvector dense values without corrupting special values', () => {
    expect(parsePostgresVector('[0.1,-2,3]')).toEqual([0.1, -2, 3]);
    expect(parsePostgresVector('[NaN,1]')).toBe('[NaN,1]');
    expect(parsePostgresVector('not-a-vector')).toBe('not-a-vector');
  });
});
