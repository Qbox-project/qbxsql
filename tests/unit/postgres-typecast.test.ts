import { describe, expect, test } from 'bun:test';
import { parsePostgresTemporal } from '../../src/drivers/postgres.js';

describe('PostgreSQL result type casting', () => {
  test('preserves positive and negative temporal infinity', () => {
    for (const type of ['date', 'timestamp', 'timestamptz'] as const) {
      expect(parsePostgresTemporal('infinity', type)).toBe(Number.POSITIVE_INFINITY);
      expect(parsePostgresTemporal('-infinity', type)).toBe(Number.NEGATIVE_INFINITY);
    }
  });

  test('keeps ordinary temporal values as UTC dates', () => {
    expect(parsePostgresTemporal('2026-09-08', 'date')).toEqual(
      new Date('2026-09-08T00:00:00.000Z'),
    );
    expect(parsePostgresTemporal('2026-09-08 12:30:00', 'timestamp')).toEqual(
      new Date('2026-09-08T12:30:00.000Z'),
    );
    expect(parsePostgresTemporal('2026-09-08 12:30:00+00', 'timestamptz')).toEqual(
      new Date('2026-09-08T12:30:00.000Z'),
    );
  });
});
