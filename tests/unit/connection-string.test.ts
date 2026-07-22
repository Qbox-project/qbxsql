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
});

