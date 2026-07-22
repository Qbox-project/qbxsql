import { describe, expect, test } from 'bun:test';
import { countPlaceholders, normalizeParameters } from '../../src/core/parameters.js';

describe('SQL parameter normalization', () => {
  test('counts value and identifier placeholders outside literals and comments', () => {
    expect(countPlaceholders("SELECT ?? FROM t WHERE a = ? AND b = '?' -- ?\nAND c = ?")).toBe(3);
  });

  test('fills missing positional values with null', () => {
    expect(normalizeParameters('SELECT ?, ?', [42])).toEqual(['SELECT ?, ?', [42, null]]);
  });

  test('rejects excess positional values', () => {
    expect(() => normalizeParameters('SELECT ?', [1, 2])).toThrow(
      'Expected 1 parameters, but received 2.',
    );
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

  test('wraps an object for mysqljs SET syntax', () => {
    expect(normalizeParameters('INSERT INTO users SET ?', { name: 'Ada' })).toEqual([
      'INSERT INTO users SET ?',
      [{ name: 'Ada' }],
    ]);
  });
});

