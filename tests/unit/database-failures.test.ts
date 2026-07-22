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

const success: DriverResult = {
  rows: [{ value: 1 }],
  fields: [],
  affectedRows: 0,
  changedRows: 0,
  insertId: 0,
  warningStatus: 0,
};

const config: QbxSqlConfig = {
  connectionString: 'mysql://test',
  connectionLimit: 1,
  connectTimeout: 100,
  slowQueryWarning: 1_000,
  debug: false,
  transactionIsolationLevel: 'READ COMMITTED',
  connectionWaitTimeout: 100,
  connectionQueueLimit: 4,
  healthInterval: 10,
  connectionRetryMax: 250,
  transactionTimeout: 100,
  schemaMode: 'auto',
  schemaAllowBlocking: false,
};

class FailureConnection implements DatabaseConnection {
  queryError: Error | null = null;
  rollbackError: Error | null = null;
  released = false;
  destroyed = false;
  rollbackCalls = 0;

  async query(): Promise<DriverResult> {
    if (this.queryError) throw this.queryError;
    return success;
  }

  async execute(): Promise<DriverResult> {
    return this.query();
  }

  async beginTransaction(): Promise<void> {}
  async commit(): Promise<void> {}

  async rollback(): Promise<void> {
    this.rollbackCalls += 1;
    if (this.rollbackError) throw this.rollbackError;
  }

  release(): void {
    this.released = true;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

class FailureDriver implements DatabaseDriver {
  readonly dialect = 'mysql' as const;
  databaseName: string | null = 'failure_test';
  serverVersion: string | null = '8.4.0';
  ready = false;
  connectAttempts = 0;
  failAcquire: Error | null = null;
  failNextQueryFatally = false;
  failNextHealthCheck = false;
  connection = new FailureConnection();
  private fatalListener: ((error: unknown) => void) | null = null;

  async connect(): Promise<void> {
    this.connectAttempts += 1;
    this.ready = true;
  }

  async close(): Promise<void> {
    this.ready = false;
  }

  async query(): Promise<DriverResult> {
    if (this.failNextQueryFatally) {
      this.failNextQueryFatally = false;
      const error = Object.assign(new Error('active connection reset'), { code: 'ECONNRESET' });
      this.ready = false;
      this.fatalListener?.(error);
      throw error;
    }
    return success;
  }

  execute(): Promise<DriverResult> {
    return this.query();
  }

  async acquire(): Promise<DatabaseConnection> {
    if (this.failAcquire) throw this.failAcquire;
    return this.connection;
  }

  async healthCheck(): Promise<void> {
    if (!this.failNextHealthCheck) return;
    this.failNextHealthCheck = false;
    const error = Object.assign(new Error('idle connection reset'), { code: 'ECONNRESET' });
    this.ready = false;
    throw error;
  }

  getPoolStatus(): PoolStatus {
    return { total: 1, free: 0, acquired: 1, queued: 1 };
  }

  onFatalError(listener: (error: unknown) => void): void {
    this.fatalListener = listener;
  }
}

const databases: DatabaseService[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function until(predicate: () => boolean, timeout = 1_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition did not become true before timeout.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('database failure handling', () => {
  test('rebuilds the pool after an idle health-check outage', async () => {
    const driver = new FailureDriver();
    const database = new DatabaseService(driver, config);
    databases.push(database);
    const events: LifecycleEvent[] = [];
    database.onLifecycle((event) => events.push(event));
    const originalError = console.error;
    console.error = () => {};

    try {
      await database.connect();
      driver.failNextHealthCheck = true;
      await until(() => driver.connectAttempts === 2 && database.state === 'ready');
    } finally {
      console.error = originalError;
    }

    expect(events).toEqual(['ready', 'disconnected', 'reconnected']);
    expect(database.getStatus().totals.reconnects).toBe(1);
  });

  test('rejects the active failed query and serves later calls after reconnect', async () => {
    const driver = new FailureDriver();
    const database = new DatabaseService(driver, config);
    databases.push(database);
    await database.connect();
    driver.failNextQueryFatally = true;
    const originalError = console.error;
    console.error = () => {};

    try {
      await expect(database.query('SELECT active_failure')).rejects.toThrow('active connection reset');
      await database.awaitConnection();
      await expect(database.query('SELECT recovered')).resolves.toEqual([{ value: 1 }]);
    } finally {
      console.error = originalError;
    }

    expect(driver.connectAttempts).toBe(2);
    expect(database.getStatus().totals).toMatchObject({ queries: 2, errors: 1, reconnects: 1 });
  });

  test('surfaces pool exhaustion without changing a healthy lifecycle state', async () => {
    const driver = new FailureDriver();
    driver.failAcquire = Object.assign(new Error('pool queue limit reached'), {
      code: 'POOL_CONNLIMIT',
    });
    const database = new DatabaseService(driver, config);
    databases.push(database);

    await expect(database.transaction([{ query: 'SELECT 1' }])).rejects.toThrow(
      'pool queue limit reached',
    );
    expect(database.state).toBe('ready');
    expect(database.getStatus().pool).toEqual({ total: 1, free: 0, acquired: 1, queued: 1 });
  });

  test('preserves a deadlock error when rollback also fails and releases the connection', async () => {
    const driver = new FailureDriver();
    driver.connection.queryError = Object.assign(new Error('deadlock victim'), {
      code: 'ER_LOCK_DEADLOCK',
    });
    driver.connection.rollbackError = new Error('rollback connection lost');
    const database = new DatabaseService(driver, config);
    databases.push(database);
    const originalError = console.error;
    console.error = () => {};

    try {
      await expect(database.transaction([{ query: 'UPDATE accounts SET balance = 0' }])).rejects.toThrow(
        'deadlock victim',
      );
    } finally {
      console.error = originalError;
    }

    expect(driver.connection.rollbackCalls).toBe(1);
    expect(driver.connection.released).toBe(true);
    expect(database.getStatus().totals).toMatchObject({ queries: 1, errors: 1 });
  });

  test('rolls back lock-timeout callback transactions and resolves false', async () => {
    const driver = new FailureDriver();
    driver.connection.queryError = Object.assign(new Error('lock wait timeout exceeded'), {
      code: 'ER_LOCK_WAIT_TIMEOUT',
    });
    const database = new DatabaseService(driver, config);
    databases.push(database);
    const originalError = console.error;
    console.error = () => {};

    try {
      await expect(
        database.startTransaction((query) => query('UPDATE locked_table SET value = 1')),
      ).resolves.toBe(false);
    } finally {
      console.error = originalError;
    }

    expect(driver.connection.rollbackCalls).toBe(1);
    expect(driver.connection.released).toBe(true);
  });

  test('rejects queued and future calls when the resource closes', async () => {
    const driver = new FailureDriver();
    driver.ready = false;
    driver.connect = async () => {
      driver.connectAttempts += 1;
      throw new Error('database unavailable');
    };
    const database = new DatabaseService(driver, { ...config, connectionWaitTimeout: 5_000 });
    databases.push(database);
    const originalError = console.error;
    console.error = () => {};

    try {
      const queued = database.awaitConnection();
      await until(() => database.getStatus().queuedCalls === 1);
      await database.close();
      await expect(queued).rejects.toMatchObject({ code: 'QBXSQL_CLOSING' });
      await expect(database.awaitConnection()).rejects.toBeInstanceOf(ConnectionUnavailableError);
    } finally {
      console.error = originalError;
    }
  });
});
