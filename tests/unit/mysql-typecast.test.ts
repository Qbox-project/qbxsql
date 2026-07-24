import { describe, expect, test } from 'bun:test';
import type { TypeCastField, TypeCastNext } from 'mysql2';
import { typeCast, typeCastExecute } from '../../src/drivers/mysql.js';

interface CastProbe {
  result: unknown;
  bufferReads: number;
  stringReads: number;
  nextCalls: number;
}

function castProbe(
  type: string,
  length: number,
  stringValue: string | null,
  bufferValue: Buffer | null,
  caster = typeCast,
): CastProbe {
  let bufferReads = 0;
  let stringReads = 0;
  let nextCalls = 0;
  const fallback = Symbol('fallback');
  const field = {
    type,
    length,
    string() {
      stringReads += 1;
      return stringValue;
    },
    buffer() {
      bufferReads += 1;
      return bufferValue;
    },
  } as TypeCastField;
  const next = (() => {
    nextCalls += 1;
    return fallback;
  }) as TypeCastNext;

  return {
    result: caster(field, next),
    bufferReads,
    stringReads,
    nextCalls,
  };
}

describe('MySQL result type casting', () => {
  test('casts TINYINT(1) without reading the packet twice', () => {
    expect(castProbe('TINY', 1, '0', null)).toEqual({
      result: false,
      bufferReads: 0,
      stringReads: 1,
      nextCalls: 0,
    });
    expect(castProbe('TINY', 1, '1', null)).toEqual({
      result: true,
      bufferReads: 0,
      stringReads: 1,
      nextCalls: 0,
    });
    expect(castProbe('TINY', 1, '2', null)).toEqual({
      result: false,
      bufferReads: 0,
      stringReads: 1,
      nextCalls: 0,
    });
  });

  test('delegates wider TINY values before consuming the packet', () => {
    const probe = castProbe('TINY', 4, '2', null);
    expect(typeof probe.result).toBe('symbol');
    expect(probe).toEqual({
      result: probe.result,
      bufferReads: 0,
      stringReads: 0,
      nextCalls: 1,
    });
  });

  test('reads BIT fields exactly once', () => {
    expect(castProbe('BIT', 1, null, Buffer.from([1]))).toEqual({
      result: true,
      bufferReads: 1,
      stringReads: 0,
      nextCalls: 0,
    });
    expect(castProbe('BIT', 1, null, Buffer.from([2]))).toEqual({
      result: false,
      bufferReads: 1,
      stringReads: 0,
      nextCalls: 0,
    });
    expect(castProbe('BIT', 8, null, Buffer.from([5]))).toEqual({
      result: 5,
      bufferReads: 1,
      stringReads: 0,
      nextCalls: 0,
    });
  });

  test('keeps prepared TINY and BIT values native while still casting dates', () => {
    const tiny = castProbe('TINY', 1, '1', null, typeCastExecute);
    expect(typeof tiny.result).toBe('symbol');
    expect(tiny.nextCalls).toBe(1);
    expect(tiny.stringReads).toBe(0);

    const bit = castProbe('BIT', 1, null, Buffer.from([1]), typeCastExecute);
    expect(typeof bit.result).toBe('symbol');
    expect(bit.nextCalls).toBe(1);
    expect(bit.bufferReads).toBe(0);

    expect(
      castProbe('DATETIME', 19, '2026-07-24 10:00:00', null, typeCastExecute).result,
    ).toBe(new Date('2026-07-24 10:00:00').getTime());
  });
});
