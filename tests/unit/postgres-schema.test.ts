import { describe, expect, test } from 'bun:test';
import { normalizeSql, planPostgresSchema } from '../../src/postgres-schema/planner.js';
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

  test('rejects ALTER subcommand smuggling through expression fragments', () => {
    const smuggled = schema();
    smuggled.tables.properties!.checks = [{
      name: 'properties_price_check',
      expression: 'x > 0) NOT VALID, DROP COLUMN owner --',
    }];
    // The unbalanced ')' is caught before the comment token is even reached.
    expect(() => validatePostgresSchema(smuggled)).toThrow('balanced parentheses');

    const unbalanced = schema();
    unbalanced.tables.properties!.checks = [{
      name: 'properties_price_check',
      expression: 'x > 0) NOT VALID, DROP COLUMN owner',
    }];
    expect(() => validatePostgresSchema(unbalanced)).toThrow('balanced parentheses');

    const commented = schema();
    commented.tables.properties!.indexes![0]!.where = 'owner IS NOT NULL /* hide */';
    expect(() => validatePostgresSchema(commented)).toThrow('SQL comments');

    const dollarQuoted = schema();
    dollarQuoted.tables.properties!.checks = [{
      name: 'properties_price_check',
      expression: 'owner <> $$) DROP COLUMN owner$$',
    }];
    expect(() => validatePostgresSchema(dollarQuoted)).toThrow('dollar quoting');

    // Legitimate expressions keep working, including literals that contain
    // comment-looking or paren-looking text inside quotes.
    const legitimate = schema();
    legitimate.tables.properties!.checks = [{
      name: 'properties_owner_check',
      expression: "(owner <> 'a--b') AND (owner <> '(')",
    }];
    expect(() => validatePostgresSchema(legitimate)).not.toThrow();
  });

  test('requires allowDataLoss for destructive migrations', () => {
    const drop = schema();
    drop.migrations = [
      {
        version: 1,
        name: 'drop legacy table',
        operations: [{ type: 'dropTable', table: 'legacy' } as never],
      },
    ];
    expect(() => validatePostgresSchema(drop)).toThrow('dropTable requires allowDataLoss=true');

    const accepted = schema();
    accepted.migrations = [
      {
        version: 1,
        name: 'drop legacy table',
        operations: [{ type: 'dropTable', table: 'legacy', allowDataLoss: true }],
      },
    ];
    expect(() => validatePostgresSchema(accepted)).not.toThrow();
  });

  test('rejects DDL injection through referential actions', () => {
    const input = schema();
    input.tables.properties!.foreignKeys = [
      {
        name: 'properties_owner_fk',
        columns: ['owner'],
        references: { table: 'users', columns: ['identifier'] },
        onDelete: 'CASCADE, ADD COLUMN backdoor TEXT' as 'CASCADE',
      },
    ];
    expect(() => validatePostgresSchema(input)).toThrow('onDelete must be one of');

    const canonical = schema();
    canonical.tables.properties!.foreignKeys = [
      {
        name: 'properties_owner_fk',
        columns: ['owner'],
        references: { table: 'users', columns: ['identifier'] },
        onDelete: 'cascade' as 'CASCADE',
      },
    ];
    expect(
      validatePostgresSchema(canonical).tables.properties!.foreignKeys![0]!.onDelete,
    ).toBe('CASCADE');
  });

  test('renders tables, JSON defaults, partial indexes, and concurrent migrations', () => {
    const table = validatePostgresSchema(schema()).tables.properties!;
    expect(createPostgresTableSql('properties', table)).toContain(
      `"metadata" JSONB DEFAULT '{}'::jsonb NOT NULL`,
    );
    expect(createPostgresIndexSql('properties', table.indexes![0]!, true)).toBe(
      'CREATE INDEX CONCURRENTLY "properties_owner_idx" ON "public"."properties" USING BTREE ("owner") WHERE (owner IS NOT NULL)',
    );
    expect(
      postgresMigrationStatements({
        type: 'addIndex',
        table: 'properties',
        definition: table.indexes![0]!,
      })[0],
    ).toMatchObject({ concurrent: true });
  });

  test('converges on timestamp and time columns', () => {
    const input = schema();
    input.tables.properties!.columns.starts_at = { type: 'timestamp', nullable: true };
    input.tables.properties!.columns.opens_at = { type: 'time', nullable: true };
    const value = validatePostgresSchema(input);
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
        // What format_type() actually reports for these declarations.
        ['starts_at', {
          name: 'starts_at',
          formattedType: 'timestamp without time zone',
          nullable: true,
          defaultExpression: null,
          identity: '',
          comment: '',
        }],
        ['opens_at', {
          name: 'opens_at',
          formattedType: 'time without time zone',
          nullable: true,
          defaultExpression: null,
          identity: '',
          comment: '',
        }],
      ]),
      indexes: new Map([
        ['properties_owner_idx', {
          name: 'properties_owner_idx',
          columns: ['owner'],
          include: [],
          unique: false,
          primary: false,
          valid: true,
          method: 'btree',
          columnOptions: [0],
          predicate: 'owner IS NOT NULL',
        }],
      ]),
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

    const plan = planPostgresSchema('housing', value, new Map([['properties', actual]]));
    expect(plan.actions).toHaveLength(0);
  });

  test('strips only balanced outer parens when normalizing SQL text', () => {
    expect(normalizeSql('((a > 0) AND (b > 0))')).toBe('(a > 0) and (b > 0)');
    expect(normalizeSql('(a > 0) AND (b > 0)')).toBe('(a > 0) and (b > 0)');
    expect(normalizeSql('((x))')).toBe('x');
    expect(normalizeSql('(a) , (b')).toBe('(a) , (b');
  });

  test('prefers server-canonical text over author text when comparing', () => {
    const input = schema();
    input.tables.properties!.columns.status = {
      type: 'varchar',
      length: 20,
      default: 'active',
    };
    input.tables.properties!.checks = [
      { name: 'properties_status_check', expression: "status = 'active'" },
    ];
    input.tables.properties!.indexes = [{
      name: 'properties_active_idx',
      columns: ['owner'],
      where: "status = 'active'",
    }];
    const value = validatePostgresSchema(input);
    // What canonicalizePostgresSchema records from the server's deparser.
    value.tables.properties!.columns.status!.canonicalDefault = `'active'::character varying`;
    value.tables.properties!.checks![0]!.canonicalExpression =
      `((status)::text = 'active'::text)`;
    value.tables.properties!.indexes![0]!.canonicalPredicate =
      `((status)::text = 'active'::text)`;

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
        // The deparsed forms PostgreSQL actually reports for a varchar column,
        // which never match the author text without canonicalization.
        ['status', {
          name: 'status',
          formattedType: 'character varying(20)',
          nullable: false,
          defaultExpression: `'active'::character varying`,
          identity: '',
          comment: '',
        }],
      ]),
      indexes: new Map([
        ['properties_active_idx', {
          name: 'properties_active_idx',
          columns: ['owner'],
          include: [],
          unique: false,
          primary: false,
          valid: true,
          method: 'btree',
          columnOptions: [0],
          predicate: `((status)::text = 'active'::text)`,
        }],
      ]),
      checks: new Map([
        ['properties_status_check', {
          name: 'properties_status_check',
          expression: `((status)::text = 'active'::text)`,
          validated: true,
        }],
      ]),
      foreignKeys: new Map(),
      primaryKey: ['id'],
      primaryKeyName: 'properties_pkey',
    };

    const plan = planPostgresSchema('housing', value, new Map([['properties', actual]]));
    expect(plan.actions).toHaveLength(0);
  });

  test('compares declared index ordering against indoption bits', () => {
    const input = schema();
    input.tables.properties!.indexes = [{
      name: 'properties_owner_idx',
      columns: [{ name: 'owner', order: 'ASC' }],
    }];
    const value = validatePostgresSchema(input);
    const table = (columnOptions: number[]): ActualPostgresTable => ({
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
      indexes: new Map([
        ['properties_owner_idx', {
          name: 'properties_owner_idx',
          // pg_get_indexdef(..., attrsOnly) reports the bare column only.
          columns: ['owner'],
          include: [],
          unique: false,
          primary: false,
          valid: true,
          method: 'btree',
          columnOptions,
          predicate: null,
        }],
      ]),
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
    });

    // ASC NULLS LAST is the default, so a declared ASC is not drift.
    expect(
      planPostgresSchema('housing', value, new Map([['properties', table([0])]])).actions,
    ).toHaveLength(0);
    // 0x1 marks the stored index DESC, which no longer matches.
    expect(
      planPostgresSchema('housing', value, new Map([['properties', table([1])]])).actions.length,
    ).toBeGreaterThan(0);
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
