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
