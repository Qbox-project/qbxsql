import { describe, expect, test } from 'bun:test';
import { countPlaceholders, normalizeParameters } from '../../src/core/parameters.js';
import { normalizePostgresParameters } from '../../src/core/postgres-parameters.js';

describe('SQL parameter normalization', () => {
  test('counts value and identifier placeholders outside literals and comments', () => {
    expect(countPlaceholders("SELECT ?? FROM t WHERE a = ? AND b = '?' -- ?\nAND c = ?")).toBe(3);
  });

  test('fills missing positional values with null', () => {
    expect(normalizeParameters('SELECT ?, ?', [42])).toEqual(['SELECT ?, ?', [42, null]]);
  });

  test('preserves holes in one-based CFX parameter records', () => {
    expect(
      normalizeParameters('VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', {
        1: 'withdraw',
        3: 'XGX73T89',
        6: 3250,
        7: 'Bank withdraw',
        8: 'XGX73T89',
      }),
    ).toEqual([
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['withdraw', null, 'XGX73T89', null, null, 3250, 'Bank withdraw', 'XGX73T89', null],
    ]);
  });

  test('preserves holes in zero-based parameter records', () => {
    expect(normalizeParameters('VALUES (?, ?, ?)', { 0: 'first', 2: 'third' })).toEqual([
      'VALUES (?, ?, ?)',
      ['first', null, 'third'],
    ]);
  });

  test('rejects excess positional values', () => {
    expect(() => normalizeParameters('SELECT ?', [1, 2])).toThrow(
      'Expected 1 parameters, but received 2.',
    );
  });

  test('accepts unused values when the query has no placeholders like oxmysql', () => {
    expect(normalizeParameters('SELECT 1', [99])).toEqual(['SELECT 1', [99]]);
  });

  test('supports colon and at-sign named placeholders', () => {
    expect(
      normalizeParameters(
        "SELECT * FROM users WHERE id = @id AND kind = :kind AND note = '@ignored'",
        { '@id': 7, ':kind': 'admin' },
      ),
    ).toEqual([
      "SELECT * FROM users WHERE id = ? AND kind = ? AND note = '@ignored'",
      [7, 'admin'],
    ]);
  });

  test('turns absent named values into null', () => {
    expect(normalizeParameters('SELECT :missing', {})).toEqual(['SELECT ?', [null]]);
  });

  test('leaves named placeholders untouched when connection conversion is disabled', () => {
    expect(normalizeParameters('SELECT :value', { value: 7 }, false)).toEqual([
      'SELECT :value',
      [],
    ]);
  });

  test('wraps an object for mysqljs SET syntax', () => {
    expect(normalizeParameters('INSERT INTO users SET ?', { name: 'Ada' })).toEqual([
      'INSERT INTO users SET ?',
      [{ name: 'Ada' }],
    ]);
  });
});

describe('scalar parameters', () => {
  test('binds a bare scalar instead of an empty object', () => {
    expect(normalizeParameters('SELECT name FROM users WHERE id = ?', 5 as never)).toEqual([
      'SELECT name FROM users WHERE id = ?',
      [5],
    ]);
    expect(normalizeParameters('SELECT 1 WHERE name = ?', 'ochre' as never)).toEqual([
      'SELECT 1 WHERE name = ?',
      ['ochre'],
    ]);
  });

  test('binds Date and Buffer values whole', () => {
    const stamp = new Date('2026-07-31T00:00:00.000Z');
    expect(normalizeParameters('SELECT 1 WHERE created = ?', stamp as never)[1]).toEqual([stamp]);
    const blob = Buffer.from([1, 2, 3]);
    expect(normalizeParameters('SELECT 1 WHERE data = ?', blob as never)[1]).toEqual([blob]);
  });

  test('binds a bare scalar for PostgreSQL placeholders', () => {
    expect(normalizePostgresParameters('SELECT name FROM users WHERE id = $1', 5 as never)).toEqual([
      'SELECT name FROM users WHERE id = $1',
      [5],
    ]);
  });
});
