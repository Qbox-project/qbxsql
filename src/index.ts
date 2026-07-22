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
const schemas = new SchemaManager(database);

registerCompatibilityExports(database);
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

if (typeof on === 'function') {
  on('onResourceStop', (stoppedResource: string) => {
    if (stoppedResource === resourceName) void database.close();
  });
}

export { database, schemas };
