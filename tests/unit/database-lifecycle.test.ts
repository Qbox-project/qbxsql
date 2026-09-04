import { afterEach, describe, expect, test } from 'bun:test';
import type { QbxSqlConfig } from '../../src/config.js';
import {
  ConnectionUnavailableError,
  DatabaseService,
  type LifecycleEvent,
} from '../../src/core/database.js';
import type {
  DatabaseConnection,
  DatabaseDriver,
  DriverResult,
  PoolStatus,
} from '../../src/core/types.js';

const result: DriverResult = {
  rows: [],
  fields: [],
  affectedRows: 0,
  changedRows: 0,
  insertId: 0,
  warningStatus: 0,
  hasResultSetHeader: false,
};

const config: QbxSqlConfig = {
  connectionString: 'mysql://test',
  connectionLimit: 2,
  connectTimeout: 1_000,
  slowQueryWarning: 1_000,
  debug: false,
  transactionIsolationLevel: 'READ COMMITTED',
  connectionWaitTimeout: 500,
  connectionQueueLimit: 2,
  healthInterval: 1_000,
  connectionRetryMax: 250,
  transactionTimeout: 500,
  schemaMode: 'auto',
  schemaAllowBlocking: false,
};

class FakeConnection implements DatabaseConnection {
  destroyed = false;
  query = async () => result;
  execute = async () => result;
  beginTransaction = async () => {};
  commit = async () => {};
  rollback = async () => {};
  release = () => {};
  destroy = () => {
    this.destroyed = true;
  };
}

class FakeDriver implements DatabaseDriver {
  readonly dialect = 'mysql' as const;
  databaseName: string | null = 'qbox';
  serverVersion: string | null = '11.4.7-MariaDB';
  ready = false;
  connectAttempts = 0;
  acquireAttempts = 0;
  failures = 0;
  private fatalListener: ((error: unknown) => void) | null = null;
  connection: DatabaseConnection = new FakeConnection();

  async connect(): Promise<void> {
    this.connectAttempts += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('offline');
    }
    this.ready = true;
  }

  async close(): Promise<void> {
    this.ready = false;
  }

  async query(): Promise<DriverResult> {
    return result;
  }

  async execute(): Promise<DriverResult> {
    return result;
  }

  async acquire(): Promise<DatabaseConnection> {
    this.acquireAttempts += 1;
    return this.connection;
  }

  async healthCheck(): Promise<void> {}

  getPoolStatus(): PoolStatus {
    return { total: 2, free: 1, acquired: 1, queued: 0 };
  }

  onFatalError(listener: (error: unknown) => void): void {
    this.fatalListener = listener;
  }

  disconnect(): void {
    this.ready = false;
    this.fatalListener?.(Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }));
  }
}

const databases: DatabaseService[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe('database connection lifecycle', () => {
  test('retries startup failures in the background and drains queued calls', async () => {
    const driver = new FakeDriver();
    driver.failures = 1;
    const database = new DatabaseService(driver, config);
    databases.push(database);
    const events: LifecycleEvent[] = [];
    database.onLifecycle((event) => events.push(event));
    const originalError = console.error;
    console.error = () => {};

    try {
      await database.connect();
    } finally {
      console.error = originalError;
    }

    expect(driver.connectAttempts).toBe(2);
    expect(database.state).toBe('ready');
    expect(events).toEqual(['ready']);
  });

  test('allows only one pool rebuild during a reconnect storm', async () => {
    const driver = new FakeDriver();
    const database = new DatabaseService(driver, config);
    databases.push(database);
    const events: LifecycleEvent[] = [];
    database.onLifecycle((event) => events.push(event));
    await database.connect();

    driver.disconnect();
    driver.disconnect();
    await database.awaitConnection();

    expect(driver.connectAttempts).toBe(2);
    expect(events).toEqual(['ready', 'disconnected', 'reconnected']);
    expect(database.getStatus().totals.reconnects).toBe(1);
  });

  test('bounds the outage queue by count and wait time', async () => {
    const driver = new FakeDriver();
    driver.failures = Number.MAX_SAFE_INTEGER;
    const database = new DatabaseService(driver, {
      ...config,
      connectionQueueLimit: 1,
      connectionWaitTimeout: 20,
    });
    databases.push(database);
    const originalError = console.error;
    console.error = () => {};

    try {
      const first = database.awaitConnection();
      await expect(database.awaitConnection()).rejects.toMatchObject({
        code: 'QBXSQL_CONNECTION_QUEUE_FULL',
      });
      await expect(first).rejects.toBeInstanceOf(ConnectionUnavailableError);
    } finally {
      console.error = originalError;
    }

    expect(database.getStatus().queuedCalls).toBe(0);
  });

  test('reports sanitized status and query counters', async () => {
    const driver = new FakeDriver();
    const database = new DatabaseService(driver, config);
    databases.push(database);
    await database.query('SELECT 1');

    expect(database.getStatus()).toMatchObject({
      state: 'ready',
      databaseFamily: 'MariaDB',
      databaseVersion: '11.4.7-MariaDB',
      databaseName: 'qbox',
      pool: { total: 2, free: 1, acquired: 1, queued: 0 },
      queuedCalls: 0,
      memory: {
        rss: expect.any(Number),
        heapUsed: expect.any(Number),
        external: expect.any(Number),
      },
      totals: { queries: 1, errors: 0, slowQueries: 0, reconnects: 0 },
    });
    expect(JSON.stringify(database.getStatus())).not.toContain('mysql://test');
  });

  test('excludes internal schema introspection from slow-query accounting', async () => {
    const driver = new FakeDriver();
    driver.query = async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return result;
    };
    const database = new DatabaseService(driver, { ...config, slowQueryWarning: 1 });
    databases.push(database);
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(' '));
    };
    try {
      await database.query('SELECT 1', [], { invokingResource: 'qbxsql:schema' });
      await database.query('SELECT 1', [], { invokingResource: 'consumer' });
    } finally {
      console.log = originalLog;
    }

    expect(database.getStatus().totals.slowQueries).toBe(1);
    const slowLines = lines.filter((line) => line.includes('slow query'));
    expect(slowLines).toHaveLength(1);
    expect(slowLines[0]).toContain('[consumer]');
  });

  test('warns on large result sets using the oxmysql convar threshold', async () => {
    const driver = new FakeDriver();
    driver.query = async () => ({ ...result, rows: [{ id: 1 }, { id: 2 }] });
    const database = new DatabaseService(driver, { ...config, resultsetWarning: 2 });
    databases.push(database);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      await database.query('SELECT id FROM large_table', undefined, {
        invokingResource: 'large-resource',
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('large-resource returned 2 rows');
    expect(warnings[0]).toContain('SELECT id FROM large_table');
  });

  test('destroys a pinned connection when a callback transaction times out', async () => {
    const driver = new FakeDriver();
    const connection = new FakeConnection();
    connection.query = () => new Promise<DriverResult>(() => {});
    driver.connection = connection;
    const database = new DatabaseService(driver, { ...config, transactionTimeout: 20 });
    databases.push(database);
    const originalError = console.error;
    console.error = () => {};

    try {
      await expect(
        database.startTransaction(async (query) => {
          await query('SELECT SLEEP(60)');
        }, 'timeout-resource'),
      ).resolves.toBe(false);
    } finally {
      console.error = originalError;
    }

    expect(connection.destroyed).toBe(true);
  });

  test('counts queries and errors executed on pinned transaction connections', async () => {
    const driver = new FakeDriver();
    const connection = new FakeConnection();
    let calls = 0;
    connection.query = async () => {
      calls += 1;
      if (calls === 2) throw new Error('deadlock');
      return result;
    };
    driver.connection = connection;
    const database = new DatabaseService(driver, config);
    databases.push(database);
    const originalError = console.error;
    console.error = () => {};

    try {
      await expect(
        database.transaction(
          [{ query: 'SELECT 1' }, { query: 'UPDATE deadlock_probe SET value = 1' }],
          'metrics-resource',
        ),
      ).rejects.toThrow('deadlock');
    } finally {
      console.error = originalError;
    }

    expect(database.getStatus().totals).toMatchObject({ queries: 2, errors: 1 });
  });

  test('pins one connection for prepared batches', async () => {
    const driver = new FakeDriver();
    const connection = new FakeConnection();
    let executeCalls = 0;
    connection.execute = async () => {
      executeCalls += 1;
      return { ...result, rows: [{ value: executeCalls }] };
    };
    driver.connection = connection;
    const database = new DatabaseService(driver, config);
    databases.push(database);

    await expect(database.rawExecute('SELECT ? AS value', [[1], [2], [3], [4]])).resolves.toEqual([
      [{ value: 1 }],
      [{ value: 2 }],
      [{ value: 3 }],
      [{ value: 4 }],
    ]);
    expect(driver.acquireAttempts).toBe(1);
    expect(executeCalls).toBe(4);
    expect(database.getStatus().totals.queries).toBe(4);
  });
});
