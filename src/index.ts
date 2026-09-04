import { loadConfig, type PostgresSqlConfig, type QbxSqlConfig } from './config.js';
import { registerCompatibilityExports, registerMySqlUnavailableExports } from './api/compatibility.js';
import { registerPostgresExports, registerPostgresUnavailableExports } from './api/postgres.js';
import {
  registerPostgresSchemaExports,
  registerPostgresSchemaUnavailableExports,
} from './api/postgres-schema.js';
import { registerSchemaExports, registerSchemaUnavailableExports } from './api/schema.js';
import { DatabaseService, type DatabaseStatus } from './core/database.js';
import { MySqlDriver } from './drivers/mysql.js';
import { PostgresDriver } from './drivers/postgres.js';
import { PostgresExtensionRegistry } from './postgres-extensions.js';
import { PostgresSchemaManager } from './postgres-schema/manager.js';
import { SchemaManager } from './schema/manager.js';

const resourceName =
  typeof GetCurrentResourceName === 'function' ? GetCurrentResourceName() : 'qbxsql';

function mysqlService(databaseConfig: QbxSqlConfig): DatabaseService {
  return new DatabaseService(new MySqlDriver(databaseConfig), databaseConfig);
}

function postgresService(databaseConfig: PostgresSqlConfig): DatabaseService {
  return new DatabaseService(new PostgresDriver(databaseConfig), databaseConfig);
}

interface Runtime {
  mysqlDatabase: DatabaseService | null;
  postgresDatabase: DatabaseService | null;
  postgresExtensions: PostgresExtensionRegistry | null;
  mysqlSchemaDatabase: DatabaseService | null;
  mysqlSchemas: SchemaManager | null;
  postgresSchemaDatabase: DatabaseService | null;
  postgresSchemas: PostgresSchemaManager | null;
  primaryDatabase: DatabaseService;
}

/**
 * Builds every service from convars. Anything this throws -- an unset or
 * malformed connection string -- must not stop the module before exports are
 * registered, or dependent resources fail with "No such export" instead of a
 * diagnosable error.
 */
function createRuntime(): Runtime {
  const config = loadConfig();
  const mysqlDatabase = config.mysql ? mysqlService(config.mysql) : null;
  const postgresDatabase = config.postgres ? postgresService(config.postgres) : null;
  const postgresExtensions = postgresDatabase
    ? new PostgresExtensionRegistry(postgresDatabase)
    : null;
  const mysqlSchemaDatabase =
    config.mysql?.schemaConnectionString
      ? mysqlService({ ...config.mysql, connectionString: config.mysql.schemaConnectionString })
      : mysqlDatabase;
  const postgresSchemaDatabase =
    config.postgres?.schemaConnectionString
      ? postgresService({
          ...config.postgres,
          connectionString: config.postgres.schemaConnectionString,
        })
      : postgresDatabase;

  return {
    mysqlDatabase,
    postgresDatabase,
    postgresExtensions,
    mysqlSchemaDatabase,
    mysqlSchemas:
      mysqlSchemaDatabase && mysqlDatabase
        ? new SchemaManager(mysqlSchemaDatabase, {
            mode: config.schemaMode,
            allowBlocking: config.schemaAllowBlocking,
            applicationDatabase: mysqlDatabase,
            ...(config.mysql?.schemaLockTimeout !== undefined
              ? { lockTimeout: config.mysql.schemaLockTimeout }
              : {}),
            ...(config.mysql?.schemaLockAcquireTimeout !== undefined
              ? { lockAcquireTimeout: config.mysql.schemaLockAcquireTimeout }
              : {}),
          })
        : null,
    postgresSchemaDatabase,
    postgresSchemas:
      postgresSchemaDatabase && postgresDatabase
        ? new PostgresSchemaManager(postgresSchemaDatabase, {
            mode: config.schemaMode,
            allowBlocking: config.schemaAllowBlocking,
            applicationDatabase: postgresDatabase,
            extensionRegistry: postgresExtensions!,
            ...(config.postgres?.schemaLockTimeout !== undefined
              ? { lockTimeout: config.postgres.schemaLockTimeout }
              : {}),
            ...(config.postgres?.schemaLockAcquireTimeout !== undefined
              ? { lockAcquireTimeout: config.postgres.schemaLockAcquireTimeout }
              : {}),
          })
        : null,
    primaryDatabase: (mysqlDatabase ?? postgresDatabase)!,
  };
}

let startupError: unknown = null;
let runtime: Runtime | null = null;
try {
  runtime = createRuntime();
} catch (error) {
  startupError = error;
}

const mysqlDatabase = runtime?.mysqlDatabase ?? null;
const postgresDatabase = runtime?.postgresDatabase ?? null;
const postgresExtensions = runtime?.postgresExtensions ?? null;
const mysqlSchemaDatabase = runtime?.mysqlSchemaDatabase ?? null;
const mysqlSchemas = runtime?.mysqlSchemas ?? null;
const postgresSchemaDatabase = runtime?.postgresSchemaDatabase ?? null;
const postgresSchemas = runtime?.postgresSchemas ?? null;
const primaryDatabase = runtime?.primaryDatabase ?? null;

function statusFor(dialect?: string): DatabaseStatus | null {
  const normalized = dialect?.trim().toLowerCase();
  if (normalized === 'postgres' || normalized === 'postgresql') {
    const status = postgresDatabase?.getStatus();
    return status && postgresExtensions
      ? { ...status, extensions: postgresExtensions.cachedSummary() }
      : status ?? null;
  }
  if (normalized === 'mysql' || normalized === 'mariadb') {
    return mysqlDatabase?.getStatus() ?? null;
  }
  return primaryDatabase?.getStatus() ?? null;
}

function allStatuses(): { mysql: DatabaseStatus | null; postgresql: DatabaseStatus | null } {
  return {
    mysql: mysqlDatabase?.getStatus() ?? null,
    postgresql: statusFor('postgresql'),
  };
}

function isConcreteOxmysqlInstalled(): boolean {
  if (
    typeof GetNumResources !== 'function' ||
    typeof GetResourceByFindIndex !== 'function'
  ) {
    return false;
  }

  for (let index = 0; index < GetNumResources(); index += 1) {
    if (GetResourceByFindIndex(index) === 'oxmysql') return true;
  }
  return false;
}

function isQbxsqlCompatibilityBridge(): boolean {
  return (
    isConcreteOxmysqlInstalled() &&
    typeof GetResourceMetadata === 'function' &&
    GetResourceMetadata('oxmysql', 'qbxsql_bridge', 0) === 'true'
  );
}

function isConcreteOxmysqlActive(): boolean {
  if (
    !isConcreteOxmysqlInstalled() ||
    isQbxsqlCompatibilityBridge() ||
    typeof GetResourceState !== 'function'
  ) {
    return false;
  }
  const state = GetResourceState('oxmysql');
  return state === 'started' || state === 'starting';
}

function reportOxmysqlConflict(): void {
  console.error(
    '^1[qbxsql] Refusing to run while the real oxmysql resource is active. Stop and remove oxmysql before starting qbxsql.^0',
  );
}

function startQbxsqlCompatibilityBridge(): void {
  if (
    !mysqlDatabase ||
    !isQbxsqlCompatibilityBridge() ||
    typeof GetResourceState !== 'function' ||
    typeof StartResource !== 'function'
  ) {
    return;
  }

  setImmediate(() => {
    if (GetResourceState('oxmysql') === 'stopped') StartResource('oxmysql');
  });
}

const services: DatabaseService[] = [
  mysqlDatabase,
  postgresDatabase,
  ...(mysqlSchemaDatabase && mysqlSchemaDatabase !== mysqlDatabase
    ? [mysqlSchemaDatabase]
    : []),
  ...(postgresSchemaDatabase && postgresSchemaDatabase !== postgresDatabase
    ? [postgresSchemaDatabase]
    : []),
].filter((entry): entry is DatabaseService => entry !== null);

let connectorStarted = false;

if (isConcreteOxmysqlActive()) {
  reportOxmysqlConflict();
  if (typeof StopResource === 'function') {
    setImmediate(() => {
      if (
        typeof GetResourceState !== 'function' ||
        ['started', 'starting'].includes(GetResourceState(resourceName))
      ) {
        StopResource(resourceName);
      }
    });
  }
} else {
  const startupReason = startupError
    ? {
        code: 'QBXSQL_STARTUP_FAILED',
        message: `qbxsql failed to start: ${
          startupError instanceof Error ? startupError.message : String(startupError)
        }`,
      }
    : undefined;
  if (startupReason) console.error(`^1[${resourceName}] ${startupReason.message}^0`);

  const compatibilityOptions = {
    legacyProviders: true,
    oxmysqlProvider: !isQbxsqlCompatibilityBridge(),
    getStatus: statusFor,
    getStatuses: allStatuses,
    ...(startupReason ? { unavailableReason: startupReason } : {}),
  };
  if (mysqlDatabase) {
    registerCompatibilityExports(mysqlDatabase, undefined, compatibilityOptions);
    registerSchemaExports(mysqlSchemas!);
  } else {
    registerMySqlUnavailableExports(undefined, compatibilityOptions);
    registerSchemaUnavailableExports(undefined, startupReason);
  }

  if (postgresDatabase) {
    registerPostgresExports(postgresDatabase);
    registerPostgresSchemaExports(postgresSchemas!);
  } else {
    registerPostgresUnavailableExports(undefined, startupReason);
    registerPostgresSchemaUnavailableExports(undefined, startupReason);
  }

  for (const service of [mysqlDatabase, postgresDatabase]) {
    if (!service) continue;
    const label = service.driver.dialect === 'mysql' ? 'mysql' : 'postgres';
    service.onLifecycle((event, status) => {
      if (event === 'ready' || event === 'reconnected') {
        console.log(
          `[${resourceName}] ${label} ${event === 'ready' ? 'connected' : 'reconnected'} to ${status.databaseName ?? '(no database)'} on ${status.databaseVersion ?? 'unknown server'}`,
        );
      }
      if (typeof emit === 'function') {
        emit(`qbxsql:${label}:${event}`, status);
        if (service === primaryDatabase) emit(`qbxsql:${event}`, status);
      }
    });
    service.start();
  }

  startQbxsqlCompatibilityBridge();
  connectorStarted = true;

  if (typeof RegisterCommand === 'function') {
    RegisterCommand(
      'qbxsql_status',
      (source: number) => {
        if (source !== 0) return;
        console.log(`[${resourceName}] ${JSON.stringify(allStatuses())}`);
      },
      false,
    );
    RegisterCommand(
      'qbxsql_extensions',
      (source: number) => {
        if (source !== 0) return;
        if (!postgresExtensions) {
          console.log(`[${resourceName}] PostgreSQL is not configured.`);
          return;
        }
        void postgresExtensions.diagnostics().then(
          (diagnostic) => {
            console.log(
              `[${resourceName}] PostgreSQL extensions checked at ${new Date(diagnostic.checkedAt).toISOString()}`,
            );
            console.log(
              `[${resourceName}] installed: ${diagnostic.installed.map((extension) =>
                `${extension.name}@${extension.version} (${extension.schema})`).join(', ') || '(none)'}`,
            );
            for (const report of diagnostic.requirements) {
              console.log(
                `[${resourceName}] ${report.resource}: ${report.satisfied ? 'ready' : 'action required'}`,
              );
              for (const extension of report.extensions) {
                console.log(`[${resourceName}]   ${extension.state}: ${extension.message}`);
              }
            }
          },
          (error: unknown) => console.error(
            `[${resourceName}] PostgreSQL extension diagnostics failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      },
      false,
    );
  }
}

if (typeof on === 'function') {
  on('onResourceStart', (startedResource: string) => {
    if (
      startedResource !== 'oxmysql' ||
      !isConcreteOxmysqlInstalled() ||
      isQbxsqlCompatibilityBridge()
    ) {
      return;
    }
    reportOxmysqlConflict();
    if (typeof StopResource === 'function') StopResource(resourceName);
  });

  on('onResourceStop', (stoppedResource: string) => {
    if (stoppedResource === resourceName) {
      if (connectorStarted) void Promise.all(services.map((service) => service.close()));
      if (isConcreteOxmysqlInstalled() && !isQbxsqlCompatibilityBridge()) {
        reportOxmysqlConflict();
      }
      if (connectorStarted) {
        // CFX caches an export closure in the calling resource under the name it
        // referenced, and only invalidates that cache when a resource of that
        // name stops. Consumers holding exports.oxmysql/mysql-async/ghmattimysql
        // closures keep pointing at functions that no longer exist.
        console.warn(
          `^3[${resourceName}] Stopped. Resources that already called exports.oxmysql, exports['mysql-async'], or exports.ghmattimysql keep a stale cached reference and must be restarted too; restarting the server is the reliable option.^0`,
        );
      }
    }
  });
}

// Preserve the historical exports for embedders while exposing both explicit lanes.
const database = primaryDatabase;
const schemaDatabase = mysqlSchemaDatabase;
const schemas = mysqlSchemas;

export {
  database,
  mysqlDatabase,
  mysqlSchemaDatabase,
  mysqlSchemas,
  postgresDatabase,
  postgresExtensions,
  postgresSchemaDatabase,
  postgresSchemas,
  schemaDatabase,
  schemas,
};
