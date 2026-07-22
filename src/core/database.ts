import { performance } from 'node:perf_hooks';
import type { QbxSqlConfig } from '../config.js';
import type {
  DatabaseDriver,
  DriverResult,
  QueryOptions,
  SqlParameters,
  TransactionStatement,
} from './types.js';
import { normalizeParameters } from './parameters.js';

export class DatabaseService {
  private connectPromise: Promise<void> | null = null;

  public constructor(
    public readonly driver: DatabaseDriver,
    private readonly config: QbxSqlConfig,
  ) {}

  public connect(): Promise<void> {
    this.connectPromise ??= this.driver.connect();
    return this.connectPromise;
  }

  public async close(): Promise<void> {
    this.connectPromise = null;
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
    return result.insertId || null;
  }

  public async update(
    sql: string,
    parameters?: SqlParameters,
    options: QueryOptions = {},
  ): Promise<number> {
    return (await this.run(sql, parameters, options)).affectedRows;
  }

  public async transaction(
    statements: readonly TransactionStatement[],
    invokingResource = 'unknown',
  ): Promise<boolean> {
    await this.connect();
    const connection = await this.driver.acquire();

    try {
      await connection.beginTransaction();
      for (const statement of statements) {
        const [query, parameters] = normalizeParameters(statement.query, statement.parameters);
        await connection.query(query, parameters);
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

  public async run(
    sql: string,
    parameters?: SqlParameters,
    options: QueryOptions = {},
  ): Promise<DriverResult> {
    await this.connect();
    const [query, values] = normalizeParameters(sql, parameters);
    const started = performance.now();

    try {
      return options.prepared
        ? await this.driver.execute(query, values)
        : await this.driver.query(query, values);
    } finally {
      const duration = performance.now() - started;
      const resource = options.invokingResource ?? 'unknown';
      if (this.config.debug || duration >= this.config.slowQueryWarning) {
        const level = duration >= this.config.slowQueryWarning ? 'slow query' : 'query';
        console.log(`[qbxsql] ${level} (${duration.toFixed(2)}ms) [${resource}] ${query}`);
      }
    }
  }
}

