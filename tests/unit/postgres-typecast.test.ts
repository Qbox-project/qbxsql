import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  parsePostgresTemporal,
  parsePostgresTemporalArray,
} from '../../src/drivers/postgres.js';

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

  test('parses BC temporal values as astronomical years', () => {
    const idesOfMarch = new Date(0);
    idesOfMarch.setUTCFullYear(-43, 2, 15);
    expect(parsePostgresTemporal('0044-03-15 BC', 'date')).toEqual(idesOfMarch);
    idesOfMarch.setUTCHours(12);
    expect(parsePostgresTemporal('0044-03-15 12:00:00 BC', 'timestamp')).toEqual(idesOfMarch);
    expect(parsePostgresTemporal('0044-03-15 12:00:00+00 BC', 'timestamptz')).toEqual(
      idesOfMarch,
    );
    expect(parsePostgresTemporal('4713-01-01 BC', 'date')).toEqual(
      new Date('-004712-01-01T00:00:00.000Z'),
    );
  });

  test('parses years with five or more digits', () => {
    const expected = new Date('+010000-01-01T00:00:00.000Z');
    expect(parsePostgresTemporal('10000-01-01', 'date')).toEqual(expected);
    expect(parsePostgresTemporal('10000-01-01 00:00:00', 'timestamp')).toEqual(expected);
    expect(parsePostgresTemporal('10000-01-01 00:00:00+00', 'timestamptz')).toEqual(expected);
  });

  test('applies fractional seconds and timestamptz offsets', () => {
    expect(parsePostgresTemporal('2026-09-08 12:30:00.29', 'timestamp')).toEqual(
      new Date('2026-09-08T12:30:00.290Z'),
    );
    expect(parsePostgresTemporal('2026-09-08 08:30:00.123456-04', 'timestamptz')).toEqual(
      new Date('2026-09-08T12:30:00.123Z'),
    );
    expect(parsePostgresTemporal('2026-09-08 18:00:00+05:30', 'timestamptz')).toEqual(
      new Date('2026-09-08T12:30:00.000Z'),
    );
  });

  test('returns unrepresentable or unrecognised temporal values as strings', () => {
    expect(parsePostgresTemporal('5874897-12-31', 'date')).toBe('5874897-12-31');
    expect(parsePostgresTemporal('08/09/2026', 'date')).toBe('08/09/2026');
  });

  test('parses temporal arrays with the scalar UTC semantics', () => {
    expect(parsePostgresTemporalArray('{2026-09-08,NULL,infinity}', 'date')).toEqual([
      new Date('2026-09-08T00:00:00.000Z'),
      null,
      Number.POSITIVE_INFINITY,
    ]);
    expect(
      parsePostgresTemporalArray('{"2026-09-08 12:30:00","-infinity"}', 'timestamp'),
    ).toEqual([new Date('2026-09-08T12:30:00.000Z'), Number.NEGATIVE_INFINITY]);
    expect(
      parsePostgresTemporalArray('{{"2026-09-08 12:30:00+00"},{"2026-09-08 08:30:00-04"}}', 'timestamptz'),
    ).toEqual([
      [new Date('2026-09-08T12:30:00.000Z')],
      [new Date('2026-09-08T12:30:00.000Z')],
    ]);
  });

  test('parses temporal arrays independently of the process timezone', () => {
    const script = `
      import { parsePostgresTemporalArray } from './src/drivers/postgres.ts';
      const [date] = parsePostgresTemporalArray('{2026-09-08}', 'date');
      const [timestamp] = parsePostgresTemporalArray('{"2026-09-08 12:30:00"}', 'timestamp');
      console.log(JSON.stringify([date.getTime(), timestamp.getTime()]));
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: `${import.meta.dir}/../..`,
      env: { ...process.env, TZ: 'America/New_York' },
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual([1788825600000, 1788870600000]);
  });
});
