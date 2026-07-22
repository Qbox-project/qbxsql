import { describe, expect, test } from 'bun:test';
import { normalizeTransactionStatements } from '../../src/api/compatibility.js';

describe('legacy transaction normalization', () => {
  test('applies shared parameters to string statements', () => {
    expect(normalizeTransactionStatements(['UPDATE a SET value = @value'], { value: 2 })).toEqual([
      { query: 'UPDATE a SET value = @value', parameters: { value: 2 } },
    ]);
  });

  test('accepts query objects with values or parameters', () => {
    expect(
      normalizeTransactionStatements([
        { query: 'SELECT ?', values: [1] },
        { query: 'SELECT ?', parameters: [2] },
      ]),
    ).toEqual([
      { query: 'SELECT ?', parameters: [1] },
      { query: 'SELECT ?', parameters: [2] },
    ]);
  });

  test('rejects malformed transaction entries', () => {
    expect(() => normalizeTransactionStatements([{}])).toThrow('missing a query string');
  });
});

