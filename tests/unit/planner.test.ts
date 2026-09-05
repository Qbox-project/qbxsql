import { describe, expect, test } from 'bun:test';
import { capabilitiesForVersion, planSchema } from '../../src/schema/planner.js';
import type { ActualTable, ResourceSchema } from '../../src/schema/types.js';

function schema(length: number, nullable = false): ResourceSchema {
  return {
    version: 1,
    tables: {
      properties: {
        columns: {
          id: { type: 'bigint', unsigned: true, autoIncrement: true, primary: true },
          label: { type: 'varchar', length, nullable },
        },
      },
    },
  };
}

function actual(length: number): ActualTable {
  return {
    name: 'properties',
    engine: 'InnoDB',
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
    columns: new Map([
      [
        'id',
        {
          name: 'id',
          type: 'bigint',
          columnType: 'bigint(20) unsigned',
          columnTypeRaw: 'bigint(20) unsigned',
          nullable: false,
          defaultValue: null,
          extra: 'auto_increment',
          maximumLength: null,
          numericPrecision: 20,
          numericScale: 0,
          comment: '',
        },
      ],
      [
        'label',
        {
          name: 'label',
          type: 'varchar',
          columnType: `varchar(${length})`,
          columnTypeRaw: `varchar(${length})`,
          nullable: false,
          defaultValue: null,
          extra: '',
          maximumLength: length,
          numericPrecision: null,
          numericScale: null,
          comment: '',
        },
      ],
    ]),
    indexes: new Map([
      [
        'PRIMARY',
        { name: 'PRIMARY', columns: ['id'], unique: true, primary: true, indexType: 'BTREE' },
      ],
    ]),
    foreignKeys: new Map(),
  };
}

describe('declarative schema planner', () => {
  test('detects case-only changes to literal defaults', () => {
    for (const stored of ["'ACTIVE'", 'ACTIVE']) {
      const desired = schema(100);
      desired.tables.properties!.columns.label!.default = 'active';
      const existing = actual(100);
      existing.columns.get('label')!.defaultValue = stored;
      const plan = planSchema('housing', desired, new Map([['properties', existing]]));
      expect(plan.actions.some((action) => action.reason.includes('change default'))).toBe(true);
    }
  });

  test('does not assume online DDL support for an unknown server version', () => {
    expect(capabilitiesForVersion(null)).toEqual({
      instantAddColumn: false,
      inplaceAlterColumn: false,
      inplaceAddIndex: false,
    });
  });

  test('creates missing tables', () => {
    const plan = planSchema('housing', schema(100), new Map());
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.kind).toBe('createTable');
    expect(plan.actions[0]?.safe).toBe(true);
    expect(plan.actions[0]).toMatchObject({
      dataSafe: true,
      onlineSafe: true,
      automatic: true,
      risk: 'low',
      algorithm: 'CREATE',
    });
  });

  test('automatically widens varchar columns', () => {
    const plan = planSchema('housing', schema(100), new Map([['properties', actual(50)]]));
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ kind: 'alterColumn', safe: true });
    expect(plan.actions[0]?.sql).toContain('VARCHAR(100)');
    expect(plan.actions[0]?.sql).toContain('ALGORITHM=INPLACE, LOCK=NONE');
  });

  test('refuses automatic narrowing', () => {
    const plan = planSchema('housing', schema(50), new Map([['properties', actual(100)]]));
    expect(plan.actions[0]).toMatchObject({ kind: 'alterColumn', safe: false });
  });

  test('refuses an online varchar widening that crosses the length-prefix boundary', () => {
    const plan = planSchema('housing', schema(100), new Map([['properties', actual(50)]]));

    expect(plan.actions[0]).toMatchObject({
      kind: 'alterColumn',
      dataSafe: true,
      onlineSafe: false,
      automatic: false,
      algorithm: 'INPLACE',
    });
  });

  test('allows nullable additions but requires migrations for required columns', () => {
    const current = actual(100);
    current.columns.delete('label');
    expect(
      planSchema('housing', schema(100, true), new Map([['properties', current]])).actions[0],
    ).toMatchObject({ kind: 'addColumn', safe: true });
    expect(
      planSchema('housing', schema(100, false), new Map([['properties', current]])).actions[0],
    ).toMatchObject({ kind: 'addColumn', safe: false });
  });

  test('does not automatically delete unmanaged columns', () => {
    const current = actual(100);
    current.columns.set('legacy', {
      name: 'legacy',
      type: 'text',
      columnType: 'text',
      columnTypeRaw: 'text',
      nullable: true,
      defaultValue: null,
      extra: '',
      maximumLength: 65535,
      numericPrecision: null,
      numericScale: null,
      comment: '',
    });
    const plan = planSchema('housing', schema(100), new Map([['properties', current]]));
    expect(plan.actions).toHaveLength(0);
    expect(plan.warnings[0]).toContain('will not drop it automatically');
  });

  test('detects enum and ON UPDATE drift', () => {
    const current = actual(50);
    current.columns.set('status', {
      name: 'status',
      type: 'enum',
      columnType: "enum('draft','published')",
      columnTypeRaw: "enum('draft','published')",
      nullable: false,
      defaultValue: 'draft',
      extra: '',
      maximumLength: 9,
      numericPrecision: null,
      numericScale: null,
      comment: '',
    });
    current.columns.set('updated_at', {
      name: 'updated_at',
      type: 'timestamp',
      columnType: 'timestamp',
      columnTypeRaw: 'timestamp',
      nullable: false,
      defaultValue: 'current_timestamp()',
      extra: '',
      maximumLength: null,
      numericPrecision: null,
      numericScale: null,
      comment: '',
    });
    const desired = schema(50);
    desired.tables.properties!.columns.status = {
      type: 'enum',
      values: ['draft', 'published', 'archived'],
      default: 'draft',
    };
    desired.tables.properties!.columns.updated_at = {
      type: 'timestamp',
      defaultExpression: 'CURRENT_TIMESTAMP',
      onUpdateCurrentTimestamp: true,
    };

    const plan = planSchema('housing', desired, new Map([['properties', current]]));
    expect(plan.actions).toHaveLength(2);
    expect(plan.actions.map((entry) => entry.reason).join(' ')).toContain('enum');
    expect(plan.actions.map((entry) => entry.reason).join(' ')).toContain(
      'ON UPDATE CURRENT_TIMESTAMP',
    );
  });

  test('converges on enum values that are not all lowercase', () => {
    const current = actual(50);
    current.columns.set('status', {
      name: 'status',
      type: 'enum',
      columnType: "enum('pending','active')",
      columnTypeRaw: "enum('Pending','Active')",
      nullable: false,
      defaultValue: 'Pending',
      extra: '',
      maximumLength: 7,
      numericPrecision: null,
      numericScale: null,
      comment: '',
    });
    const desired = schema(50);
    desired.tables.properties!.columns.status = {
      type: 'enum',
      values: ['Pending', 'Active'],
      default: 'Pending',
    };

    const plan = planSchema('housing', desired, new Map([['properties', current]]));
    expect(plan.actions).toHaveLength(0);
  });

  test('converges on MariaDB JSON columns introspected as longtext', () => {
    const current = actual(50);
    current.columns.set('metadata', {
      name: 'metadata',
      type: 'longtext',
      columnType: 'longtext',
      columnTypeRaw: 'longtext',
      nullable: true,
      defaultValue: null,
      extra: '',
      maximumLength: 4294967295,
      numericPrecision: null,
      numericScale: null,
      comment: '',
    });
    const desired = schema(50);
    desired.tables.properties!.columns.metadata = { type: 'json', nullable: true };

    const mariadb = planSchema(
      'housing',
      desired,
      new Map([['properties', current]]),
      capabilitiesForVersion('11.4.2-MariaDB'),
    );
    expect(mariadb.actions).toHaveLength(0);

    const mysql = planSchema(
      'housing',
      desired,
      new Map([['properties', current]]),
      capabilitiesForVersion('8.4.0'),
    );
    expect(mysql.actions).toHaveLength(1);
    expect(mysql.actions[0]).toMatchObject({ kind: 'alterColumn', safe: false });
    expect(mysql.actions[0]?.reason).toContain('longtext -> json');
  });

  test('converges on MariaDB-quoted string defaults', () => {
    const current = actual(50);
    current.columns.set('status', {
      name: 'status',
      type: 'varchar',
      columnType: 'varchar(20)',
      columnTypeRaw: 'varchar(20)',
      nullable: false,
      defaultValue: "'active'",
      extra: '',
      maximumLength: 20,
      numericPrecision: null,
      numericScale: null,
      comment: '',
    });
    current.columns.set('note', {
      name: 'note',
      type: 'varchar',
      columnType: 'varchar(40)',
      columnTypeRaw: 'varchar(40)',
      nullable: false,
      defaultValue: "'o''brien'",
      extra: '',
      maximumLength: 40,
      numericPrecision: null,
      numericScale: null,
      comment: '',
    });
    const desired = schema(50);
    desired.tables.properties!.columns.status = { type: 'varchar', length: 20, default: 'active' };
    desired.tables.properties!.columns.note = { type: 'varchar', length: 40, default: "o'brien" };

    const plan = planSchema('housing', desired, new Map([['properties', current]]));
    expect(plan.actions).toHaveLength(0);
  });

  test('reads a quoted null default as the string literal, not as no default', () => {
    const current = actual(50);
    current.columns.set('status', {
      name: 'status',
      type: 'varchar',
      columnType: 'varchar(20)',
      columnTypeRaw: 'varchar(20)',
      nullable: false,
      defaultValue: "'null'",
      extra: '',
      maximumLength: 20,
      numericPrecision: null,
      numericScale: null,
      comment: '',
    });
    const matching = schema(50);
    matching.tables.properties!.columns.status = { type: 'varchar', length: 20, default: 'null' };
    expect(
      planSchema('housing', matching, new Map([['properties', current]])).actions,
    ).toHaveLength(0);

    const withoutDefault = schema(50);
    withoutDefault.tables.properties!.columns.status = { type: 'varchar', length: 20 };
    expect(
      planSchema('housing', withoutDefault, new Map([['properties', current]])).actions[0]?.reason,
    ).toContain('change default');
  });

  test('detects engine, charset, and collation drift', () => {
    const current = actual(50);
    current.engine = 'MyISAM';
    current.charset = 'latin1';
    current.collation = 'latin1_swedish_ci';
    const desired = schema(50);
    desired.tables.properties!.collation = 'utf8mb4_unicode_ci';

    const plan = planSchema('housing', desired, new Map([['properties', current]]));
    expect(plan.actions).toHaveLength(2);
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'alterTableEngine', automatic: false }),
        expect.objectContaining({ kind: 'alterTableCharset', automatic: false }),
      ]),
    );
  });

  test('detects primary-key, index, and foreign-key drift', () => {
    const current = actual(50);
    current.indexes.set('properties_label_idx', {
      name: 'properties_label_idx',
      columns: ['id'],
      unique: false,
      primary: false,
      indexType: 'BTREE',
    });
    current.foreignKeys.set('properties_owner_fk', {
      name: 'properties_owner_fk',
      columns: ['id'],
      referencedTable: 'legacy_owners',
      referencedColumns: ['id'],
      onDelete: 'RESTRICT',
      onUpdate: 'RESTRICT',
    });
    const desired = schema(50);
    desired.tables.properties!.primaryKey = ['label'];
    desired.tables.properties!.columns.id!.primary = false;
    desired.tables.properties!.indexes = [
      { name: 'properties_label_idx', columns: ['label'], unique: true },
    ];
    desired.tables.properties!.foreignKeys = [
      {
        name: 'properties_owner_fk',
        columns: ['id'],
        references: { table: 'owners', columns: ['id'] },
        onDelete: 'CASCADE',
      },
    ];

    const actions = planSchema('housing', desired, new Map([['properties', current]])).actions;
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'alterPrimaryKey', automatic: false }),
        expect.objectContaining({ kind: 'replaceIndex', automatic: false }),
        expect.objectContaining({ kind: 'replaceForeignKey', automatic: false }),
      ]),
    );
  });

  test('warns about unmanaged indexes and foreign keys without removing them', () => {
    const current = actual(50);
    current.indexes.set('manual_idx', {
      name: 'manual_idx',
      columns: ['label'],
      unique: false,
      primary: false,
      indexType: 'BTREE',
    });
    current.foreignKeys.set('manual_fk', {
      name: 'manual_fk',
      columns: ['id'],
      referencedTable: 'owners',
      referencedColumns: ['id'],
      onDelete: 'RESTRICT',
      onUpdate: 'RESTRICT',
    });

    const plan = planSchema('housing', schema(50), new Map([['properties', current]]));
    expect(plan.actions).toHaveLength(0);
    expect(plan.warnings.join(' ')).toContain("unmanaged index 'manual_idx'");
    expect(plan.warnings.join(' ')).toContain("unmanaged foreign key 'manual_fk'");
  });

  test('treats NO ACTION and RESTRICT foreign-key rules as equivalent', () => {
    const current = actual(50);
    current.foreignKeys.set('properties_owner_fk', {
      name: 'properties_owner_fk',
      columns: ['id'],
      referencedTable: 'owners',
      referencedColumns: ['id'],
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION',
    });
    const desired = schema(50);
    desired.tables.properties!.foreignKeys = [
      {
        name: 'properties_owner_fk',
        columns: ['id'],
        references: { table: 'owners', columns: ['id'] },
      },
    ];

    expect(
      planSchema('housing', desired, new Map([['properties', current]])).actions,
    ).toHaveLength(0);
  });
});
