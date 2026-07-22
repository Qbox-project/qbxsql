import { describe, expect, test } from 'bun:test';
import { serializeForRuntime } from '../../src/core/serialize.js';

describe('runtime serialization', () => {
  test('normalizes buffers, dates, bigints, undefined, and nested values', () => {
    expect(
      serializeForRuntime({
        bytes: Buffer.from([1, 2, 255]),
        date: new Date(1_000),
        id: 9_007_199_254_740_993n,
        missing: undefined,
        nested: [Buffer.from([3])],
      }),
    ).toEqual({
      bytes: [1, 2, 255],
      date: 1_000,
      id: '9007199254740993',
      missing: null,
      nested: [[3]],
    });
  });

  test('does not clone values that are already runtime-safe', () => {
    const row = { id: 1, name: 'Ada', active: true, nested: [2, null] };
    const rows = [row];

    expect(serializeForRuntime(rows)).toBe(rows);
    expect(serializeForRuntime(row)).toBe(row);
  });

  test('only clones paths containing values that require conversion', () => {
    const safe = { id: 1 };
    const changed = { bytes: Buffer.from([4]) };
    const rows = [safe, changed];
    const serialized = serializeForRuntime(rows) as Array<Record<string, unknown>>;

    expect(serialized).not.toBe(rows);
    expect(serialized[0]).toBe(safe);
    expect(serialized[1]).not.toBe(changed);
    expect(serialized[1]).toEqual({ bytes: [4] });
    expect(changed.bytes).toEqual(Buffer.from([4]));
  });
});
