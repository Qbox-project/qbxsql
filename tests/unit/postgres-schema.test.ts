import { describe, expect, test } from 'bun:test';
import { planPostgresSchema } from '../../src/postgres-schema/planner.js';
import {
  createPostgresIndexSql,
  createPostgresTableSql,
  postgresMigrationStatements,
} from '../../src/postgres-schema/sql.js';
import type {
  ActualPostgresTable,
  PostgresResourceSchema,
} from '../../src/postgres-schema/types.js';
import {
  postgresSchemaChecksum,
  validatePostgresSchema,
} from '../../src/postgres-schema/validate.js';

function schema(): PostgresResourceSchema {
  return {
    version: 1,
    tables: {
      properties: {
        columns: {
          id: { type: 'bigint', identity: 'byDefault', primary: true },
          owner: { type: 'varchar', length: 64 },
          metadata: { type: 'jsonb', default: {} },
          created_at: {
            type: 'timestamptz',
            defaultExpression: 'CURRENT_TIMESTAMP',
          },
        },
        checks: [{ name: 'properties_owner_check', expression: `owner <> ''` }],
        indexes: [{
          name: 'properties_owner_idx',
          columns: ['owner'],
          where: 'owner IS NOT NULL',
        }],
      },
    },
  };
}

describe('PostgreSQL declarative schemas', () => {
  test('validates and normalizes PostgreSQL-native definitions', () => {
    const value = validatePostgresSchema(schema());
    expect(value.tables.properties?.columns.metadata?.type).toBe('jsonb');
    expect(postgresSchemaChecksum(value)).toBe(
      postgresSchemaChecksum(validatePostgresSchema(schema())),
    );
  });

  test('rejects MySQL-only and unsafe fields', () => {
    const input = schema() as any;
    input.tables.properties.columns.id.type = 'mediumint';
    expect(() => validatePostgresSchema(input)).toThrow('unsupported PostgreSQL type');

    const unsigned = schema() as any;
    unsigned.tables.properties.columns.id.unsigned = true;
    expect(() => validatePostgresSchema(unsigned)).toThrow("MySQL-only field 'unsigned'");

    const engine = schema() as any;
    engine.tables.properties.engine = 'InnoDB';
    expect(() => validatePostgresSchema(engine)).toThrow("MySQL-only field 'engine'");

    const unsafe = schema();
    unsafe.tables.properties!.indexes![0]!.where = 'true; DROP TABLE properties';
    expect(() => validatePostgresSchema(unsafe)).toThrow('without a semicolon');
  });

  test('renders tables, JSON defaults, partial indexes, and concurrent migrations', () => {
    const table = validatePostgresSchema(schema()).tables.properties!;
    expect(createPostgresTableSql('properties', table)).toContain(
      `"metadata" JSONB DEFAULT '{}'::jsonb NOT NULL`,
    );
    expect(createPostgresIndexSql('properties', table.indexes![0]!, true)).toBe(
      'CREATE INDEX CONCURRENTLY "properties_owner_idx" ON "public"."properties" USING BTREE ("owner") WHERE owner IS NOT NULL',
    );
    expect(
      postgresMigrationStatements({
        type: 'addIndex',
        table: 'properties',
        definition: table.indexes![0]!,
      })[0],
    ).toMatchObject({ concurrent: true });
  });

  test('plans new tables and uses concurrent indexes for existing tables', () => {
    const value = validatePostgresSchema(schema());
    const fresh = planPostgresSchema('housing', value, new Map());
    expect(fresh.actions.map((action) => action.algorithm)).toContain('CREATE');

    const actual: ActualPostgresTable = {
      name: 'properties',
      comment: '',
      columns: new Map([
        ['id', {
          name: 'id',
          formattedType: 'bigint',
          nullable: false,
          defaultExpression: null,
          identity: 'd',
          comment: '',
        }],
        ['owner', {
          name: 'owner',
          formattedType: 'character varying(64)',
          nullable: false,
          defaultExpression: null,
          identity: '',
          comment: '',
        }],
        ['metadata', {
          name: 'metadata',
          formattedType: 'jsonb',
          nullable: false,
          defaultExpression: `'{}'::jsonb`,
          identity: '',
          comment: '',
        }],
        ['created_at', {
          name: 'created_at',
          formattedType: 'timestamp with time zone',
          nullable: false,
          defaultExpression: 'CURRENT_TIMESTAMP',
          identity: '',
          comment: '',
        }],
      ]),
      indexes: new Map(),
      checks: new Map([
        ['properties_owner_check', {
          name: 'properties_owner_check',
          expression: `owner <> ''`,
          validated: true,
        }],
      ]),
      foreignKeys: new Map(),
      primaryKey: ['id'],
      primaryKeyName: 'properties_pkey',
    };
    const drift = planPostgresSchema('housing', value, new Map([['properties', actual]]));
    expect(drift.actions).toContainEqual(
      expect.objectContaining({
        kind: 'addIndex',
        algorithm: 'CONCURRENT',
        automatic: true,
      }),
    );
  });
});
