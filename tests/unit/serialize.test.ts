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
});

