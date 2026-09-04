import { performance } from 'node:perf_hooks';
import type { QbxSqlConfig } from '../config.js';
import type {
  DatabaseConnection,
  DatabaseDriver,
  DriverResult,
  PoolStatus,
  QueryOptions,
  SqlParameter,
  SqlParameters,
  TransactionStatement,
} from './types.js';
import { normalizeParameters } from './parameters.js';

export type ConnectionState = 'connecting' | 'ready' | 'reconnecting' | 'closing';
export type LifecycleEvent = 'ready' | 'disconnected' | 'reconnected';

export interface DatabaseStatus {
  state: ConnectionState;
  dialect: DatabaseDriver['dialect'];
  databaseFamily: 'MariaDB' | 'MySQL' | 'PostgreSQL' | 'unknown';
  databaseVersion: string | null;
  databaseName: string | null;
  pool: PoolStatus;
  queuedCalls: number;
  memory: {
    rss: number;
    heapUsed: number;
    external: number;
  };
  totals: {
    queries: number;
    errors: number;
    slowQueries: number;
    reconnects: number;
  };
  extensions?: {
    required: number;
    ready: number;
    unsatisfied: number;
    resources: number;
  };
}

interface ConnectionWaiter {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class ConnectionUnavailableError extends Error {
  public constructor(
    message: string,
    public readonly code: 'QBXSQL_CONNECTION_QUEUE_FULL' | 'QBXSQL_CONNECTION_WAIT_TIMEOUT' | 'QBXSQL_CLOSING',
  ) {
    super(message);
    this.name = 'ConnectionUnavailableError';
  }
}

const emptyPoolStatus: PoolStatus = { total: 0, free: 0, acquired: 0, queued: 0 };

export class DatabaseService {
  private connectionState: ConnectionState = 'connecting';
  private connectionTask: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseRetryWait: (() => void) | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private readonly waiters = new Set<ConnectionWaiter>();
  private readonly lifecycleListeners = new Set<
    (event: LifecycleEvent, status: DatabaseStatus) => void
  >();
  private connectedBefore = false;
  private disconnectAnnounced = false;
  private queryTotal = 0;
  private errorTotal = 0;
  private slowQueryTotal = 0;
  private reconnectTotal = 0;

  public constructor(
    public readonly driver: DatabaseDriver,
    private readonly config: QbxSqlConfig,
  ) {
    this.driver.onFatalError?.((error) => this.handleDisconnect(error));
  }

  public get state(): ConnectionState {
    return this.connectionState;
  }

  public start(): void {
    this.ensureConnectionLoop();
  }

  public connect(): Promise<void> {
    return this.awaitConnection();
  }

  public awaitConnection(timeout = this.config.connectionWaitTimeout): Promise<void> {
    if (this.connectionState === 'ready' && this.driver.ready) return Promise.resolve();
    if (this.connectionState === 'closing') {
      return Promise.reject(
        new ConnectionUnavailableError('Database connector is closing.', 'QBXSQL_CLOSING'),
      );
    }
    if (this.waiters.size >= this.config.connectionQueueLimit) {
      return Promise.reject(
        new ConnectionUnavailableError(
          `Database connection queue is full (${this.config.connectionQueueLimit} calls).`,
          'QBXSQL_CONNECTION_QUEUE_FULL',
        ),
      );
    }

    this.ensureConnectionLoop();
    return new Promise<void>((resolve, reject) => {
      const waiter: ConnectionWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(
            new ConnectionUnavailableError(
              `Database connection was unavailable for ${timeout}ms.`,
              'QBXSQL_CONNECTION_WAIT_TIMEOUT',
            ),
          );
        }, timeout),
      };
      this.waiters.add(waiter);

      if (this.connectionState === 'ready' && this.driver.ready) this.resolveWaiters();
    });
  }

  public onLifecycle(
    listener: (event: LifecycleEvent, status: DatabaseStatus) => void,
  ): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  public getStatus(): DatabaseStatus {
    const serverVersion = this.driver.serverVersion;
    const memory = process.memoryUsage();
    const databaseFamily = this.driver.dialect === 'postgresql'
      ? 'PostgreSQL'
      : !serverVersion
      ? 'unknown'
      : /mariadb/i.test(serverVersion)
        ? 'MariaDB'
        : 'MySQL';
    return {
      state: this.connectionState,
      dialect: this.driver.dialect,
      databaseFamily,
      databaseVersion: serverVersion,
      databaseName: this.driver.databaseName,
      pool: this.driver.getPoolStatus?.() ?? emptyPoolStatus,
      queuedCalls: this.waiters.size,
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        external: memory.external,
      },
      totals: {
        queries: this.queryTotal,
        errors: this.errorTotal,
        slowQueries: this.slowQueryTotal,
        reconnects: this.reconnectTotal,
      },
    };
  }

  public async close(): Promise<void> {
    if (this.connectionState === 'closing') return;
    this.connectionState = 'closing';
    this.stopHealthCheck();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.releaseRetryWait?.();
    this.releaseRetryWait = null;
    this.rejectWaiters(
      new ConnectionUnavailableError('Database connector is closing.', 'QBXSQL_CLOSING'),
    );
    await this.connectionTask?.catch(() => {});
    await this.driver.close();
  }

  public async query(
    sql: string,
    parameters?: SqlParameters,
    options: QueryOptions = {},
  ): Promise<unknown> {
    const result = await this.run(sql, parameters, options);
    return result.rows;
  }

  public normalize(
    sql: string,
    parameters?: SqlParameters,
  ): [query: string, parameters: SqlParameter[]] {
    if (this.driver.normalizeParameters) {
      return this.driver.normalizeParameters(sql, parameters);
    }
    return normalizeParameters(sql, parameters, this.driver.namedPlaceholders !== false);
  }

  public normalizePrepared(
    sql: string,
    parameters?: SqlParameters,
  ): [query: string, parameterSets: SqlParameter[][]] {
    let normalizedQuery = sql;
    const parameterSets = this.parameterSets(parameters).map((parameterSet) => {
      const [query, values] = this.normalize(sql, parameterSet);
      normalizedQuery = query;
      return values;
    });
    return [normalizedQuery, parameterSets];
  }

  public async single(
    sql: string,
    parameters?: SqlParameters,
    options: QueryOptions = {},
  ): Promise<unknown> {
    const rows = await this.query(sql, parameters, options);
    return Array.isArray(rows) ? (rows[0] ?? null) : null;
  }

  public async scalar(
    sql: string,
    parameters?: SqlParameters,
    options: QueryOptions = {},
  ): Promise<unknown> {
    const row = await this.single(sql, parameters, options);
    if (!row || typeof row !== 'object') return null;
    return Object.values(row)[0] ?? null;
  }

  public async insert(
    sql: string,
    parameters?: SqlParameters,
    options: QueryOptions = {},
  ): Promise<number | string | null> {
    const result = await this.run(sql, parameters, options);
    return result.insertId ?? null;
  }

  public async update(
    sql: string,
    parameters?: SqlParameters,
    options: QueryOptions = {},
  ): Promise<number | null> {
    return (await this.run(sql, parameters, options)).affectedRows;
  }

  public async executeResult(
    sql: string,
    parameters?: SqlParameters,
    options: QueryOptions = {},
  ): Promise<DriverResult> {
    return this.run(sql, parameters, options);
  }

  public async prepare(
    sql: string,
    parameters?: SqlParameters,
    options: QueryOptions = {},
  ): Promise<unknown> {
    const parameterSets = this.parameterSets(parameters);
    const results = await this.executePreparedBatch(sql, parameterSets, options);
    return this.parsePreparedResponse(sql, results);
  }

  public async rawExecute(
    sql: string,
    parameters?: SqlParameters,
    options: QueryOptions = {},
  ): Promise<unknown> {
    const response: unknown[] = [];
    for (const result of await this.executePreparedBatch(sql, this.parameterSets(parameters), options)) {
      if (Array.isArray(result.rows) && result.rows.length > 1) {
        response.push(...result.rows);
      } else {
        response.push(result.rows);
      }
    }
    return response.length === 1 ? response[0] : response;
  }

  private async executePreparedBatch(
    sql: string,
    parameterSets: Array<SqlParameters | undefined>,
    options: QueryOptions,
  ): Promise<DriverResult[]> {
    if (parameterSets.length === 1) {
      return [
        await this.run(sql, parameterSets[0], { ...options, prepared: true }),
      ];
    }

    await this.awaitConnection();
    const connection = await this.driver.acquire();
    const resource = options.invokingResource ?? 'unknown';
    const results: DriverResult[] = [];
    try {
      for (const parameters of parameterSets) {
        const [query, values] = options.normalized
          ? [sql, (parameters ?? []) as SqlParameter[]]
          : this.normalize(sql, parameters);
        results.push(
          await this.measureQuery(query, resource, () => connection.execute(query, values)),
        );
      }
      return results;
    } finally {
      connection.release();
    }
  }

  public async transaction(
    statements: readonly TransactionStatement[],
    invokingResource = 'unknown',
  ): Promise<boolean> {
    await this.awaitConnection();
    const connection = await this.driver.acquire();

    try {
      await connection.beginTransaction();
      for (const statement of statements) {
        const [query, parameters] = this.normalize(statement.query, statement.parameters);
        await this.measureQuery(query, invokingResource, () => connection.query(query, parameters));
      }
      await connection.commit();
      return true;
    } catch (error) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(`[qbxsql] rollback failed for ${invokingResource}`, rollbackError);
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  public async transactionResults(
    statements: readonly TransactionStatement[],
    invokingResource = 'unknown',
  ): Promise<DriverResult[]> {
    await this.awaitConnection();
    const connection = await this.driver.acquire();
    const results: DriverResult[] = [];

    try {
      await connection.beginTransaction();
      for (const statement of statements) {
        const [query, parameters] = this.normalize(statement.query, statement.parameters);
        results.push(
          await this.measureQuery(query, invokingResource, () =>
            connection.query(query, parameters),
          ),
        );
      }
      await connection.commit();
      return results;
    } catch (error) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(`[qbxsql] rollback failed for ${invokingResource}`, rollbackError);
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  public async withTransaction(
    work: (query: (sql: string, parameters?: SqlParameters) => Promise<unknown>) => Promise<unknown>,
    invokingResource = 'unknown',
  ): Promise<boolean> {
    if (typeof work !== 'function') throw new TypeError('Transaction callback must be a function.');
    await this.awaitConnection();
    const connection = await this.driver.acquire();
    let closed = false;
    let timedOut = false;
    let rejectTimeout: ((error: Error) => void) | null = null;
    const timeoutError = new Error(
      `Transaction timed out after ${this.config.transactionTimeout}ms.`,
    );
    const timeout = setTimeout(() => {
      closed = true;
      timedOut = true;
      connection.destroy();
      rejectTimeout?.(timeoutError);
    }, this.config.transactionTimeout);
    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });

    try {
      await connection.beginTransaction();
      const query = async (sql: string, parameters?: SqlParameters): Promise<unknown> => {
        if (closed) throw new Error(`Transaction timed out after ${this.config.transactionTimeout}ms.`);
        const [statement, values] = this.normalize(sql, parameters);
        try {
          return (
            await this.measureQuery(statement, invokingResource, () =>
              connection.query(statement, values),
            )
          ).rows;
        } catch (error) {
          if (this.driver.dialect === 'postgresql') throw error;
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Query: ${statement}\n${JSON.stringify(values)}\n${reason}`);
        }
      };
      const result = await Promise.race([work(query), timeoutPromise]);
      if (closed) throw timeoutError;
      if (result === false) {
        await connection.rollback();
        return false;
      }
      await connection.commit();
      return true;
    } catch (error) {
      if (!timedOut) {
        try {
          await connection.rollback();
        } catch {
          // The original transaction error is more useful than a secondary rollback failure.
        }
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      rejectTimeout = null;
      closed = true;
      connection.release();
    }
  }

  public async startTransaction(
    work: (query: (sql: string, parameters?: SqlParameters) => Promise<unknown>) => Promise<unknown>,
    invokingResource = 'unknown',
    onError?: (error: unknown) => void,
  ): Promise<boolean> {
    try {
      return await this.withTransaction(work, invokingResource);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[qbxsql] callback transaction failed [${invokingResource}]: ${reason}`);
      try {
        onError?.(error);
      } catch (listenerError) {
        console.error('[qbxsql] callback transaction error listener failed', listenerError);
      }
      return false;
    }
  }

  public async run(
    sql: string,
    parameters?: SqlParameters,
    options: QueryOptions = {},
  ): Promise<DriverResult> {
    await this.awaitConnection();
    const [query, values] = options.normalized
      ? [sql, (parameters ?? []) as SqlParameter[]]
      : this.normalize(sql, parameters);
    return this.measureQuery(query, options.invokingResource ?? 'unknown', () =>
      options.prepared
        ? this.driver.execute(query, values)
        : this.driver.query(query, values),
    );
  }

  /** Same accounting and debug output as pooled queries, on a connection the caller holds. */
  public runOn(
    connection: DatabaseConnection,
    sql: string,
    parameters: readonly unknown[] = [],
    options: QueryOptions = {},
  ): Promise<DriverResult> {
    return this.measureQuery(sql, options.invokingResource ?? 'unknown', () =>
      connection.query(sql, parameters),
    );
  }

  private async measureQuery<T>(
    query: string,
    resource: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    this.queryTotal += 1;

    try {
      const result = await operation();
      this.validateResultSet(query, resource, result);
      return result;
    } catch (error) {
      this.errorTotal += 1;
      throw error;
    } finally {
      const duration = performance.now() - started;
      // The connector's own schema introspection routinely exceeds the
      // threshold on servers where INFORMATION_SCHEMA is slow; operators can
      // neither tune nor act on those queries, so they stay out of the slow
      // counter and warning. Debug mode still shows them.
      const internal = resource === 'qbxsql:schema';
      const slow =
        !internal && this.config.slowQueryWarning > 0 && duration >= this.config.slowQueryWarning;
      if (slow) this.slowQueryTotal += 1;
      const debug =
        this.config.debug === true ||
        (Array.isArray(this.config.debug) && this.config.debug.includes(resource));
      if (debug || slow) {
        const level = slow ? 'slow query' : 'query';
        console.log(`[qbxsql] ${level} (${duration.toFixed(2)}ms) [${resource}] ${query}`);
      }
    }
  }

  private validateResultSet(query: string, resource: string, result: unknown): void {
    const warning = this.config.resultsetWarning ?? 1_000;
    if (warning <= 0 || !result || typeof result !== 'object' || !('rows' in result)) return;
    const rows = (result as DriverResult).rows;
    if (!Array.isArray(rows) || rows.length < warning) return;
    console.warn(
      `[qbxsql] ${resource} returned ${rows.length} rows for a query; qbxsql_resultset_warning is ${warning}.\n${query}`,
    );
  }

  private ensureConnectionLoop(): void {
    if (
      this.connectionState === 'closing' ||
      (this.connectionState === 'ready' && this.driver.ready) ||
      this.connectionTask
    ) {
      return;
    }

    this.connectionState = this.connectedBefore ? 'reconnecting' : 'connecting';
    if (this.connectedBefore && !this.disconnectAnnounced) {
      this.disconnectAnnounced = true;
      this.emitLifecycle('disconnected');
    }

    const task = this.connectionLoop();
    this.connectionTask = task;
    void task.finally(() => {
      if (this.connectionTask !== task) return;
      this.connectionTask = null;
      if (
        this.connectionState !== 'closing' &&
        (this.connectionState !== 'ready' || !this.driver.ready)
      ) {
        this.ensureConnectionLoop();
      }
    });
  }

  private async connectionLoop(): Promise<void> {
    let delay = 250;

    while (!this.isClosing()) {
      try {
        await this.driver.close();
        await this.driver.connect();
        if (this.isClosing()) {
          await this.driver.close();
          return;
        }

        const reconnected = this.connectedBefore;
        this.connectedBefore = true;
        this.disconnectAnnounced = false;
        this.connectionState = 'ready';
        if (reconnected) this.reconnectTotal += 1;
        this.startHealthCheck();
        this.resolveWaiters();
        this.emitLifecycle(reconnected ? 'reconnected' : 'ready');
        return;
      } catch (error) {
        await this.driver.close().catch(() => {});
        if (this.isClosing()) return;
        const reason = error instanceof Error ? error.message : String(error);
        const wait = Math.min(
          this.config.connectionRetryMax,
          delay + Math.floor(Math.random() * Math.max(1, delay * 0.2)),
        );
        console.error(`[qbxsql] database connection failed; retrying in ${wait}ms: ${reason}`);
        await this.waitForRetry(wait);
        delay = Math.min(this.config.connectionRetryMax, delay * 2);
      }
    }
  }

  private waitForRetry(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.retryTimer = null;
        this.releaseRetryWait = null;
        resolve();
      };
      this.releaseRetryWait = release;
      this.retryTimer = setTimeout(release, milliseconds);
    });
  }

  private handleDisconnect(error: unknown): void {
    if (this.connectionState === 'closing' || !this.connectedBefore) return;
    this.stopHealthCheck();
    this.connectionState = 'reconnecting';
    if (!this.disconnectAnnounced) {
      this.disconnectAnnounced = true;
      this.emitLifecycle('disconnected');
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[qbxsql] database connection lost: ${reason}`);
    }
    this.ensureConnectionLoop();
  }

  private startHealthCheck(): void {
    this.stopHealthCheck();
    if (!this.driver.healthCheck) return;
    this.healthTimer = setInterval(() => {
      if (this.connectionState !== 'ready') return;
      void this.driver.healthCheck!().catch((error: unknown) => this.handleDisconnect(error));
    }, this.config.healthInterval);
    this.healthTimer.unref();
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  private resolveWaiters(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.waiters.clear();
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  private emitLifecycle(event: LifecycleEvent): void {
    const status = this.getStatus();
    for (const listener of this.lifecycleListeners) listener(event, status);
  }

  private isClosing(): boolean {
    return this.connectionState === 'closing';
  }

  private parsePreparedResponse(sql: string, results: DriverResult[]): unknown {
    const operation = sql.trimStart().split(/\s+/, 1)[0]?.toUpperCase();
    const response: unknown[] = [];

    for (const result of results) {
      if (Array.isArray(result.rows) && result.rows.length > 1) {
        for (const value of result.rows) response.push(value);
        continue;
      }

      if (operation === 'INSERT' || operation === 'REPLACE') {
        response.push(result.hasResultSetHeader ? result.insertId : null);
      } else if (operation === 'UPDATE' || operation === 'DELETE') {
        response.push(result.hasResultSetHeader ? result.affectedRows : null);
      } else {
        response.push(result.rows);
      }
    }

    if (response.length !== 1) return response;
    if (operation === 'INSERT' || operation === 'REPLACE' || operation === 'UPDATE' || operation === 'DELETE') {
      return response[0];
    }

    const rows = response[0];
    if (!Array.isArray(rows)) return rows;
    const first = rows[0];
    if (!first || typeof first !== 'object') return first ?? null;
    const values = Object.values(first);
    return values.length === 1 ? (values[0] ?? null) : first;
  }

  private parameterSets(parameters?: SqlParameters): Array<SqlParameters | undefined> {
    let candidate: unknown = parameters;
    if (candidate && !Array.isArray(candidate) && typeof candidate === 'object') {
      const entries = Object.entries(candidate);
      if (entries.length > 0 && entries.every(([key]) => /^\d+$/.test(key))) {
        const base = Object.hasOwn(candidate, '0') ? 0 : 1;
        const highest = Math.max(...entries.map(([key]) => Number(key)));
        const ordered = Array.from({ length: highest - base + 1 }, (_, index) =>
          (candidate as Record<string, unknown>)[String(index + base)],
        );
        if (ordered.every((entry) => this.isParameterContainer(entry))) candidate = ordered;
      }
    }

    const batch =
      Array.isArray(candidate) &&
      candidate.length > 0 &&
      candidate.every((entry) => this.isParameterContainer(entry));
    return batch ? (candidate as Array<SqlParameters>) : [parameters];
  }

  private isParameterContainer(value: unknown): boolean {
    return (
      Array.isArray(value) ||
      (value !== null &&
        typeof value === 'object' &&
        !Buffer.isBuffer(value) &&
        !(value instanceof Date))
    );
  }
}
