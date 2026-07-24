import { loadConfig } from './config.js';
import { DatabaseService } from './core/database.js';
import { MySqlDriver } from './drivers/mysql.js';
import { registerCompatibilityExports } from './api/compatibility.js';
import { registerSchemaExports } from './api/schema.js';
import { SchemaManager } from './schema/manager.js';

const resourceName =
  typeof GetCurrentResourceName === 'function' ? GetCurrentResourceName() : 'qbxsql';
const config = loadConfig();
const database = new DatabaseService(new MySqlDriver(config), config);
const schemaDatabase = config.schemaConnectionString
  ? new DatabaseService(
      new MySqlDriver({ ...config, connectionString: config.schemaConnectionString }),
      { ...config, connectionString: config.schemaConnectionString },
    )
  : database;
const schemas = new SchemaManager(schemaDatabase, {
  mode: config.schemaMode,
  allowBlocking: config.schemaAllowBlocking,
  applicationDatabase: database,
});

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

function isConcreteOxmysqlActive(): boolean {
  if (!isConcreteOxmysqlInstalled() || typeof GetResourceState !== 'function') return false;
  const state = GetResourceState('oxmysql');
  return state === 'started' || state === 'starting';
}

function reportOxmysqlConflict(): void {
  console.error(
    '^1[qbxsql] Refusing to run while the real oxmysql resource is active. Stop and remove oxmysql before starting qbxsql.^0',
  );
}

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
  registerCompatibilityExports(database, undefined, { legacyProviders: true });
  registerSchemaExports(schemas);

  database.onLifecycle((event, status) => {
    if (event === 'ready' || event === 'reconnected') {
      console.log(
        `[${resourceName}] ${event === 'ready' ? 'connected' : 'reconnected'} to ${status.databaseName ?? '(no database)'} on ${status.databaseVersion ?? 'unknown server'}`,
      );
    }
    if (typeof emit === 'function') emit(`qbxsql:${event}`, status);
  });

  database.start();
  connectorStarted = true;

  if (typeof RegisterCommand === 'function') {
    RegisterCommand(
      'qbxsql_status',
      (source: number) => {
        if (source !== 0) return;
        console.log(`[${resourceName}] ${JSON.stringify(database.getStatus())}`);
      },
      false,
    );
  }
}

if (typeof on === 'function') {
  on('onResourceStart', (startedResource: string) => {
    if (startedResource !== 'oxmysql' || !isConcreteOxmysqlInstalled()) return;
    reportOxmysqlConflict();
    if (typeof StopResource === 'function') StopResource(resourceName);
  });

  on('onResourceStop', (stoppedResource: string) => {
    if (stoppedResource === resourceName) {
      if (connectorStarted) {
        void Promise.all([
          database.close(),
          ...(schemaDatabase === database ? [] : [schemaDatabase.close()]),
        ]);
      }
      if (isConcreteOxmysqlInstalled()) reportOxmysqlConflict();
    }
  });
}

export { database, schemaDatabase, schemas };
