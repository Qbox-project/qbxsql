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
};

class FakeConnection implements DatabaseConnection {
  query = async () => result;
  execute = async () => result;
  beginTransaction = async () => {};
  commit = async () => {};
  rollback = async () => {};
  release = () => {};
  destroy = () => {};
}

class FakeDriver implements DatabaseDriver {
  readonly dialect = 'mysql' as const;
  databaseName: string | null = 'qbox';
  serverVersion: string | null = '11.4.7-MariaDB';
  ready = false;
  connectAttempts = 0;
  failures = 0;
  private fatalListener: ((error: unknown) => void) | null = null;

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
    return new FakeConnection();
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
      totals: { queries: 1, errors: 0, slowQueries: 0, reconnects: 0 },
    });
    expect(JSON.stringify(database.getStatus())).not.toContain('mysql://test');
  });
});
