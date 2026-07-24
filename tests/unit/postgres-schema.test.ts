import { describe, expect, test } from 'bun:test';
import { planPostgresSchema } from '../../src/postgres-schema/planner.js';
import {
  createPostgresIndexSql,
  createPostgresTableSql,
  postgresExclusionSql,
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
    const input = schema();
    input.extensions = [{ name: 'uuid-ossp' }];
    const value = validatePostgresSchema(input);
    expect(value.tables.properties?.columns.metadata?.type).toBe('jsonb');
    expect(value.extensions).toEqual([{ name: 'uuid-ossp' }]);
    expect(postgresSchemaChecksum(value)).toBe(
      postgresSchemaChecksum(validatePostgresSchema(input)),
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

  test('validates extension-backed vector columns and renders ANN index options', () => {
    const vectorSchema = validatePostgresSchema({
      version: 1,
      extensions: [{ name: 'vector', minimumVersion: '0.8.5' }],
      tables: {
        embeddings: {
          columns: {
            id: { type: 'integer', primary: true },
            embedding: { type: 'vector', dimensions: 1536 },
          },
          indexes: [{
            name: 'embeddings_hnsw_idx',
            method: 'hnsw',
            columns: [{
              name: 'embedding',
              operatorClass: 'vector_cosine_ops',
            }],
            options: { m: 16, ef_construction: 64 },
          }],
        },
      },
    });
    const table = vectorSchema.tables.embeddings!;
    expect(createPostgresTableSql('embeddings', table)).toContain('"embedding" VECTOR(1536)');
    expect(createPostgresIndexSql('embeddings', table.indexes![0]!, true)).toBe(
      'CREATE INDEX CONCURRENTLY "embeddings_hnsw_idx" ON "public"."embeddings" USING HNSW ("embedding" "vector_cosine_ops") WITH ("m" = 16, "ef_construction" = 64)',
    );

    const undeclared = structuredClone(vectorSchema);
    undeclared.extensions = [];
    expect(() => validatePostgresSchema(undeclared)).toThrow('must declare extensions');
  });

  test('renders extension-ready exclusion constraints without accepting arbitrary operators', () => {
    expect(postgresExclusionSql({
      name: 'bookings_no_overlap',
      method: 'gist',
      elements: [
        { column: 'room_id', operator: '=', operatorClass: 'gist_int4_ops' },
        { column: 'during', operator: '&&' },
      ],
      where: 'cancelled = false',
    })).toBe(
      'CONSTRAINT "bookings_no_overlap" EXCLUDE USING GIST ("room_id" "gist_int4_ops" WITH =, "during" WITH &&) WHERE (cancelled = false)',
    );

    const invalid: any = {
      version: 1,
      tables: {
        bookings: {
          columns: {
            room_id: { type: 'integer' },
            during: { type: 'text' },
          },
          exclusions: [{
            name: 'bookings_bad',
            elements: [{ column: 'during', operator: '; DROP TABLE bookings' }],
          }],
        },
      },
    };
    expect(() => validatePostgresSchema(invalid)).toThrow('unsupported operator');
  });

  test('renders PostGIS typmods and generic operator-class indexes', () => {
    const spatial = validatePostgresSchema({
      version: 1,
      extensions: [{ name: 'postgis', minimumVersion: '3.4.0' }],
      tables: {
        map_markers: {
          columns: {
            id: { type: 'integer', primary: true },
            position: {
              type: 'geometry',
              spatialType: 'point',
              srid: 4326,
            },
          },
          indexes: [{
            name: 'map_markers_position_gist_idx',
            method: 'gist',
            columns: [{
              name: 'position',
              operatorClass: 'gist_geometry_ops_2d',
            }],
          }],
        },
      },
    });
    const table = spatial.tables.map_markers!;
    expect(createPostgresTableSql('map_markers', table)).toContain(
      '"position" GEOMETRY(POINT,4326)',
    );
    expect(createPostgresIndexSql('map_markers', table.indexes![0]!, false)).toContain(
      'USING GIST ("position" "gist_geometry_ops_2d")',
    );

    const missing = structuredClone(spatial);
    missing.extensions = [];
    expect(() => validatePostgresSchema(missing)).toThrow('must declare extensions');
  });
});
