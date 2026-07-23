import { describe, expect, test } from 'bun:test';
import { createSecretSafeWriter } from '../../scripts/secret-safe-writer.mjs';

describe('secret-safe streamed output', () => {
  test('redacts complete and cross-chunk credentials before writing', () => {
    const license = 'cfxk_secret-license-value';
    const connection = 'mysql://user:password@database/qbxsql';
    let output = '';
    const writer = createSecretSafeWriter(
      { write: (value: string) => (output += value) },
      [license, connection],
    );

    const source = `starting ${license}\nconnecting to ${connection}\nQBXSQL_RUNTIME_TEST_PASS\n`;
    for (let index = 0; index < source.length; index += 3) {
      writer.push(source.slice(index, index + 3));
    }
    writer.flush();

    expect(output).not.toContain(license);
    expect(output).not.toContain(connection);
    expect(output).toContain('*'.repeat(license.length));
    expect(output).toContain('*'.repeat(connection.length));
    expect(output).toContain('QBXSQL_RUNTIME_TEST_PASS');
  });
});
