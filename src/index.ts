import { loadConfig, type PostgresSqlConfig, type QbxSqlConfig } from './config.js';
import { registerCompatibilityExports, registerMySqlUnavailableExports } from './api/compatibility.js';
import { registerPostgresExports, registerPostgresUnavailableExports } from './api/postgres.js';
import {
  registerPostgresSchemaExports,
  registerPostgresSchemaUnavailableExports,
} from './api/postgres-schema.js';
import { registerSchemaExports } from './api/schema.js';
import { DatabaseService, type DatabaseStatus } from './core/database.js';
import { MySqlDriver } from './drivers/mysql.js';
import { PostgresDriver } from './drivers/postgres.js';
import { PostgresSchemaManager } from './postgres-schema/manager.js';
import { SchemaManager } from './schema/manager.js';

const resourceName =
  typeof GetCurrentResourceName === 'function' ? GetCurrentResourceName() : 'qbxsql';
const config = loadConfig();

function mysqlService(databaseConfig: QbxSqlConfig): DatabaseService {
  return new DatabaseService(new MySqlDriver(databaseConfig), databaseConfig);
}

function postgresService(databaseConfig: PostgresSqlConfig): DatabaseService {
  return new DatabaseService(new PostgresDriver(databaseConfig), databaseConfig);
}

const mysqlDatabase = config.mysql ? mysqlService(config.mysql) : null;
const postgresDatabase = config.postgres ? postgresService(config.postgres) : null;
const primaryDatabase = mysqlDatabase ?? postgresDatabase!;

const mysqlSchemaDatabase =
  config.mysql?.schemaConnectionString
    ? mysqlService({ ...config.mysql, connectionString: config.mysql.schemaConnectionString })
    : mysqlDatabase;
const mysqlSchemas =
  mysqlSchemaDatabase && mysqlDatabase
    ? new SchemaManager(mysqlSchemaDatabase, {
        mode: config.schemaMode,
        allowBlocking: config.schemaAllowBlocking,
        applicationDatabase: mysqlDatabase,
      })
    : null;
const postgresSchemaDatabase =
  config.postgres?.schemaConnectionString
    ? postgresService({
        ...config.postgres,
        connectionString: config.postgres.schemaConnectionString,
      })
    : postgresDatabase;
const postgresSchemas =
  postgresSchemaDatabase && postgresDatabase
    ? new PostgresSchemaManager(postgresSchemaDatabase, {
        mode: config.schemaMode,
        allowBlocking: config.schemaAllowBlocking,
        applicationDatabase: postgresDatabase,
        ...(config.postgres?.schemaLockTimeout !== undefined
          ? { lockTimeout: config.postgres.schemaLockTimeout }
          : {}),
      })
    : null;

function statusFor(dialect?: string): DatabaseStatus | null {
  const normalized = dialect?.trim().toLowerCase();
  if (normalized === 'postgres' || normalized === 'postgresql') {
    return postgresDatabase?.getStatus() ?? null;
  }
  if (normalized === 'mysql' || normalized === 'mariadb') {
    return mysqlDatabase?.getStatus() ?? null;
  }
  return primaryDatabase.getStatus();
}

function allStatuses(): { mysql: DatabaseStatus | null; postgresql: DatabaseStatus | null } {
  return {
    mysql: mysqlDatabase?.getStatus() ?? null,
    postgresql: postgresDatabase?.getStatus() ?? null,
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

const services = [
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
  const compatibilityOptions = {
    legacyProviders: true,
    oxmysqlProvider: !isQbxsqlCompatibilityBridge(),
    getStatus: statusFor,
    getStatuses: allStatuses,
  };
  if (mysqlDatabase) {
    registerCompatibilityExports(mysqlDatabase, undefined, compatibilityOptions);
    registerSchemaExports(mysqlSchemas!);
  } else {
    registerMySqlUnavailableExports(undefined, compatibilityOptions);
  }

  if (postgresDatabase) {
    registerPostgresExports(postgresDatabase);
    registerPostgresSchemaExports(postgresSchemas!);
  } else {
    registerPostgresUnavailableExports();
    registerPostgresSchemaUnavailableExports();
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
  postgresSchemaDatabase,
  postgresSchemas,
  schemaDatabase,
  schemas,
};
