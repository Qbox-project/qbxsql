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
    this.connectPromise ??= this.driver.connect().catch((error: unknown) => {
      this.connectPromise = null;
      throw error;
    });
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

  public async prepare(
    sql: string,
    parameters?: SqlParameters,
    options: QueryOptions = {},
  ): Promise<unknown> {
    const parameterSets =
      Array.isArray(parameters) &&
      parameters.length > 0 &&
      parameters.every((entry) => Array.isArray(entry) || (entry !== null && typeof entry === 'object'))
        ? parameters
        : [parameters];
    const results: unknown[] = [];

    for (const values of parameterSets) {
      const result = await this.run(sql, values as SqlParameters, { ...options, prepared: true });
      results.push(this.parsePreparedResult(sql, result));
    }

    return results.length === 1 ? results[0] : results;
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

  public async startTransaction(
    work: (query: (sql: string, parameters?: SqlParameters) => Promise<unknown>) => Promise<unknown>,
    invokingResource = 'unknown',
  ): Promise<boolean> {
    if (typeof work !== 'function') throw new TypeError('Transaction callback must be a function.');
    await this.connect();
    const connection = await this.driver.acquire();
    let closed = false;
    const timeout = setTimeout(() => {
      closed = true;
    }, 30_000);
    timeout.unref();

    try {
      await connection.beginTransaction();
      const query = async (sql: string, parameters?: SqlParameters): Promise<unknown> => {
        if (closed) throw new Error('Transaction timed out after 30 seconds.');
        const [statement, values] = normalizeParameters(sql, parameters);
        try {
          return (await connection.query(statement, values)).rows;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Query: ${statement}\n${JSON.stringify(values)}\n${reason}`);
        }
      };
      const result = await work(query);
      if (closed) throw new Error('Transaction timed out after 30 seconds.');
      if (result === false) {
        await connection.rollback();
        return false;
      }
      await connection.commit();
      return true;
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        // The original transaction error is more useful than a secondary rollback failure.
      }
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[qbxsql] callback transaction failed [${invokingResource}]: ${reason}`);
      return false;
    } finally {
      clearTimeout(timeout);
      closed = true;
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

  private parsePreparedResult(sql: string, result: DriverResult): unknown {
    const operation = sql.trimStart().split(/\s+/, 1)[0]?.toUpperCase();
    if (operation === 'INSERT' || operation === 'REPLACE') return result.insertId || null;
    if (operation === 'UPDATE' || operation === 'DELETE') return result.affectedRows;

    if (!Array.isArray(result.rows)) return result.rows;
    const first = result.rows[0];
    if (!first || typeof first !== 'object') return first ?? null;
    const values = Object.values(first);
    return values.length === 1 ? (values[0] ?? null) : first;
  }
}
