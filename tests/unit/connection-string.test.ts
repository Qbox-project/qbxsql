import { describe, expect, test } from 'bun:test';
import { parseMySqlConnectionString } from '../../src/drivers/mysql.js';

describe('legacy MySQL connection strings', () => {
  test('passes URI connection strings to mysql2', () => {
    expect(parseMySqlConnectionString('mysql://user:pass@localhost/database')).toEqual({
      uri: 'mysql://user:pass@localhost/database',
    });
  });

  test('normalizes mysql-async semicolon aliases and typed options', () => {
    expect(
      parseMySqlConnectionString(
        'server=127.0.0.1;uid=root;pwd=secret;db=qbox;port=3307;multipleStatements=false;charset=utf8mb4',
      ),
    ).toEqual({
      host: '127.0.0.1',
      user: 'root',
      password: 'secret',
      database: 'qbox',
      port: 3307,
      multipleStatements: false,
      charset: 'utf8mb4',
    });
  });

  test('preserves URI pool options and warns when multiple statements are enabled', () => {
    const warnings: string[] = [];
    expect(
      parseMySqlConnectionString(
        'mysql://root@localhost/qbox?connectionLimit=23&connectTimeout=9000&multipleStatements=true',
        (warning) => warnings.push(warning),
      ),
    ).toMatchObject({ connectionLimit: 23, connectTimeout: 9000, multipleStatements: true });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('SQL injection');
  });

  test('validates and filters typed URI query options', () => {
    const warnings: string[] = [];
    const options = parseMySqlConnectionString(
      'mysql://root@localhost/qbox?waitForConnections=false&queueLimit=20&enableKeepAlive=true&unknownSecret=value',
      (message) => warnings.push(message),
    );

    expect(options).toMatchObject({
      waitForConnections: false,
      queueLimit: 20,
      enableKeepAlive: true,
    });
    expect(String(options.uri)).not.toContain('unknownSecret');
    expect(warnings).toEqual([
      "[qbxsql] Ignoring unknown connection-string option 'unknownSecret'.",
    ]);
    expect(() =>
      parseMySqlConnectionString('mysql://root@localhost/qbox?queueLimit=unbounded'),
    ).toThrow("Connection-string option 'queueLimit' must be an integer");
  });

  test('validates typed values and warns about unknown options without exposing values', () => {
    expect(() => parseMySqlConnectionString('port=not-a-number')).toThrow('must be an integer');
    expect(() => parseMySqlConnectionString('multipleStatements=maybe')).toThrow(
      'must be a boolean',
    );

    const warnings: string[] = [];
    parseMySqlConnectionString('password=secret;madeUp=sensitive', (warning) =>
      warnings.push(warning),
    );
    expect(warnings).toEqual(["[qbxsql] Ignoring unknown connection-string option 'madeUp'."]);
    expect(warnings[0]).not.toContain('sensitive');
  });

  test('parses oxmysql flags, dateStrings, and named-placeholder options', () => {
    expect(
      parseMySqlConnectionString(
        'mysql://root@localhost/qbox?flags=%5B%22FOUND_ROWS%22%5D&dateStrings=%5B%22DATE%22%5D&namedPlaceholders=false',
      ),
    ).toMatchObject({
      flags: ['FOUND_ROWS'],
      dateStrings: ['DATE'],
      namedPlaceholders: false,
    });
    expect(() => parseMySqlConnectionString('flags={bad-json}')).toThrow('valid JSON');
    expect(() => parseMySqlConnectionString('dateStrings=42')).toThrow(
      'boolean, string, or JSON array',
    );
  });
});
