import { describe, expect, test } from 'bun:test';
import {
  countPostgresPlaceholders,
  normalizePostgresParameters,
} from '../../src/core/postgres-parameters.js';

describe('PostgreSQL parameter normalization', () => {
  test('counts numbered parameters outside PostgreSQL literals and comments', () => {
    const sql = `
      SELECT $1, '$8', "$7", $$ $6 $$, $tag$ $5 $tag$, $3
      -- $9
      /* $10 /* $11 */ */
    `;
    expect(countPostgresPlaceholders(sql)).toBe(3);
  });

  test('preserves PostgreSQL casts and operators', () => {
    expect(countPostgresPlaceholders(`SELECT $1::jsonb @> $2::jsonb`)).toBe(2);
    expect(normalizePostgresParameters(`SELECT $1::jsonb @> $2::jsonb`, [{ a: 1 }, { a: 1 }]))
      .toEqual([`SELECT $1::jsonb @> $2::jsonb`, [{ a: 1 }, { a: 1 }]]);
  });

  test('fills sparse CFX parameter records with null', () => {
    expect(normalizePostgresParameters('SELECT $1, $2, $3', { 1: 'a', 3: 'c' }))
      .toEqual(['SELECT $1, $2, $3', ['a', null, 'c']]);
  });

  test('allows a JSON object as one positional value', () => {
    expect(normalizePostgresParameters('SELECT $1::jsonb', { active: true }))
      .toEqual(['SELECT $1::jsonb', [{ active: true }]]);
  });

  test('rejects named maps and excess values', () => {
    expect(() =>
      normalizePostgresParameters('SELECT $1, $2', { first: 1, second: 2 }),
    ).toThrow('named parameter objects are not supported');
    expect(() => normalizePostgresParameters('SELECT $1', [1, 2])).toThrow(
      'Expected 1 PostgreSQL parameters',
    );
    expect(() => normalizePostgresParameters('SELECT $1', { 1: 1, 2: 2 })).toThrow(
      'Expected 1 PostgreSQL parameters',
    );
    expect(() => countPostgresPlaceholders('SELECT $65536')).toThrow(
      'supported maximum of 65535',
    );
  });
});
