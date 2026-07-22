import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createConnection } from 'mysql2/promise';
import {
  registerCompatibilityExports,
  type ExportFunction,
  type RuntimeBindings,
} from '../../src/api/compatibility.js';
import type { QbxSqlConfig } from '../../src/config.js';
import { DatabaseService } from '../../src/core/database.js';
import { MySqlDriver } from '../../src/drivers/mysql.js';

const databaseName = 'qbxsql_test';
const adminConnection = process.env.QBXSQL_TEST_ADMIN_URL ?? 'mysql://root@127.0.0.1';
const connectionString = `${adminConnection}/${databaseName}`;

const config: QbxSqlConfig = {
  connectionString,
  connectionLimit: 4,
  connectTimeout: 5_000,
  slowQueryWarning: 10_000,
  debug: false,
  transactionIsolationLevel: 'READ COMMITTED',
  connectionWaitTimeout: 30_000,
  connectionQueueLimit: 1_000,
  healthInterval: 10_000,
  connectionRetryMax: 30_000,
  transactionTimeout: 30_000,
  schemaMode: 'auto',
  schemaAllowBlocking: false,
};

let database: DatabaseService;
let directExports: Map<string, ExportFunction>;
let providerExports: Map<string, ExportFunction>;

describe('MySQL driver integration', () => {
  beforeAll(async () => {
    const admin = await createConnection(adminConnection);
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.query(
      `CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await admin.end();

    database = new DatabaseService(new MySqlDriver(config), config);
    await database.connect();
    directExports = new Map();
    providerExports = new Map();
    const bindings: RuntimeBindings = {
      addExport: (name, callback) => directExports.set(name, callback),
      addProviderExport: (resource, name, callback) =>
        providerExports.set(`${resource}:${name}`, callback),
      emitEvent: () => {},
      invokingResource: () => 'integration-resource',
    };
    registerCompatibilityExports(database, bindings);
    await database.query(`
      CREATE TABLE values_test (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        enabled TINYINT(1) NOT NULL,
        happened_at DATETIME NULL,
        payload BLOB NULL,
        note TEXT NULL
      )
    `);
  });

  afterAll(async () => {
    if (database) await database.close();
    const admin = await createConnection(adminConnection);
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.end();
  });

  test('connects and reports database metadata', () => {
    expect(database.driver.ready).toBe(true);
    expect(database.driver.databaseName).toBe(databaseName);
    expect(database.driver.serverVersion).toBeTruthy();
  });

  test('supports named parameters and normalizes returned values', async () => {
    const date = '2026-07-22 12:30:00';
    const id = await database.insert(
      `INSERT INTO values_test (name, enabled, happened_at, payload, note)
       VALUES (@name, @enabled, @happenedAt, @payload, @note)`,
      {
        '@name': 'Ada',
        '@enabled': true,
        '@happenedAt': date,
        '@payload': Buffer.from([1, 2, 255]),
        '@note': null,
      },
    );

    const row = (await database.single('SELECT * FROM values_test WHERE id = ?', [id])) as Record<
      string,
      unknown
    >;
    expect(row.name).toBe('Ada');
    expect(row.enabled).toBe(true);
    expect(row.happened_at).toBe(new Date(date).getTime());
    expect(row.payload).toEqual([1, 2, 255]);
    expect(row.note).toBeNull();
  });

  test('supports mysqljs identifier placeholders', async () => {
    const rows = (await database.query('SELECT ?? FROM values_test ORDER BY id LIMIT 1', [
      'name',
    ])) as Array<Record<string, unknown>>;
    expect(rows).toEqual([{ name: 'Ada' }]);
  });

  test('returns scalar and affected-row results', async () => {
    expect(await database.scalar('SELECT COUNT(*) FROM values_test')).toBe(1);
    expect(await database.update('UPDATE values_test SET name = ? WHERE name = ?', ['Grace', 'Ada'])).toBe(
      1,
    );
  });

  test('commits successful transactions and rolls back failed transactions', async () => {
    await database.transaction(
      [
        {
          query: 'INSERT INTO values_test (name, enabled) VALUES (?, ?)',
          parameters: ['Committed', true],
        },
      ],
      'integration-test',
    );
    expect(await database.scalar('SELECT COUNT(*) FROM values_test WHERE name = ?', ['Committed'])).toBe(
      1,
    );

    let transactionError: unknown;
    try {
      await database.transaction(
        [
          {
            query: 'INSERT INTO values_test (name, enabled) VALUES (?, ?)',
            parameters: ['Rolled back', true],
          },
          { query: 'INSERT INTO table_that_does_not_exist (id) VALUES (1)' },
        ],
        'integration-test',
      );
    } catch (error) {
      transactionError = error;
    }
    expect(transactionError).toBeInstanceOf(Error);

    expect(
      await database.scalar('SELECT COUNT(*) FROM values_test WHERE name = ?', ['Rolled back']),
    ).toBe(0);
  });

  test('supports callback-style transactions', async () => {
    expect(
      await database.startTransaction(async (query) => {
        const rows = (await query('SELECT ? AS value', [48])) as Array<Record<string, unknown>>;
        expect(rows[0]?.value).toBe(48);
        await query('INSERT INTO values_test (name, enabled) VALUES (?, ?)', ['Callback', true]);
        return true;
      }, 'integration-test'),
    ).toBe(true);
    expect(await database.scalar('SELECT COUNT(*) FROM values_test WHERE name = ?', ['Callback'])).toBe(1);

    expect(
      await database.startTransaction(async (query) => {
        await query('INSERT INTO values_test (name, enabled) VALUES (?, ?)', ['Callback rollback', true]);
        return false;
      }, 'integration-test'),
    ).toBe(false);
    expect(
      await database.scalar('SELECT COUNT(*) FROM values_test WHERE name = ?', ['Callback rollback']),
    ).toBe(0);
  });

  test('supports batch prepare and raw execute operations', async () => {
    expect(await database.prepare('SELECT ? AS value', [[1], [2]])).toEqual([1, 2]);
    expect(await database.rawExecute('SELECT ? AS value', [[3], [4]])).toEqual([
      [{ value: 3 }],
      [{ value: 4 }],
    ]);
    const id = (await database.prepare(
      'INSERT INTO values_test (name, enabled, payload) VALUES (?, ?, ?)',
      ['Prepared buffer', true, Buffer.from([8, 9])],
    )) as number;
    expect(id).not.toBeNull();
    expect(await database.scalar('SELECT COUNT(*) FROM values_test WHERE id = ?', [id])).toBe(1);
  });

  test('registers oxmysql, mysql-async, and ghmattimysql compatibility exports', () => {
    expect(providerExports.has('oxmysql:query')).toBe(true);
    expect(providerExports.has('mysql-async:mysql_fetch_all')).toBe(true);
    expect(providerExports.has('mysql-async:mysql_fetch_scalar')).toBe(true);
    expect(providerExports.has('ghmattimysql:execute')).toBe(true);
    expect(providerExports.has('ghmattimysql:executeSync')).toBe(true);
  });

  test('executes callback and promise compatibility APIs', async () => {
    const query = providerExports.get('mysql-async:mysql_fetch_all')!;
    const callbackRows = await new Promise<unknown>((resolve, reject) => {
      query('SELECT ? AS value', [42], (result: unknown, error?: string) => {
        if (error) reject(new Error(error));
        else resolve(result);
      });
    });
    expect(callbackRows).toEqual([{ value: 42 }]);

    const scalarSync = providerExports.get('ghmattimysql:scalarSync')!;
    expect(await scalarSync('SELECT ? AS value', [73])).toBe(73);

    const queryAsync = directExports.get('query_async')!;
    expect(await queryAsync('SELECT ? AS value', [99])).toEqual([{ value: 99 }]);
  });
});
