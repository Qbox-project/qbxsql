import { describe, expect, test } from 'bun:test';
import { planSchema } from '../../src/schema/planner.js';
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
    collation: 'utf8mb4_unicode_ci',
    columns: new Map([
      [
        'id',
        {
          name: 'id',
          type: 'bigint',
          columnType: 'bigint(20) unsigned',
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
  test('creates missing tables', () => {
    const plan = planSchema('housing', schema(100), new Map());
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.kind).toBe('createTable');
    expect(plan.actions[0]?.safe).toBe(true);
  });

  test('automatically widens varchar columns', () => {
    const plan = planSchema('housing', schema(100), new Map([['properties', actual(50)]]));
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ kind: 'alterColumn', safe: true });
    expect(plan.actions[0]?.sql).toContain('VARCHAR(100)');
  });

  test('refuses automatic narrowing', () => {
    const plan = planSchema('housing', schema(50), new Map([['properties', actual(100)]]));
    expect(plan.actions[0]).toMatchObject({ kind: 'alterColumn', safe: false });
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
});

