import { describe, expect, test } from 'bun:test';
import { configValue, createSecretSafeWriter } from '../../scripts/secret-safe-writer.mjs';

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

  test('redacts a PostgreSQL connection string too', () => {
    const postgres = 'postgresql://user:hunter2@database:5432/qbxsql';
    let output = '';
    const writer = createSecretSafeWriter(
      { write: (value: string) => (output += value) },
      ['cfxk_key-value-here', postgres],
    );
    writer.push(`connecting to ${postgres}\n`);
    writer.flush();
    expect(output).not.toContain('hunter2');
  });

  test('refuses config values that would inject extra directives', () => {
    expect(configValue('mysql://user:pw@host/db', 'the connection string')).toBe(
      'mysql://user:pw@host/db',
    );
    // A quote alone was stripped, but a newline ends the directive and makes
    // everything after it another line of config.
    expect(configValue('a"b', 'a value')).toBe('ab');
    expect(() => configValue('cfxk_key\nset rcon_password owned', 'the license key')).toThrow(
      'contains a newline',
    );
    expect(() => configValue('mysql://host/db\rset x y', 'the connection string')).toThrow(
      'contains a newline',
    );
  });
});
