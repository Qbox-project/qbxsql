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

void database
  .connect()
  .then(() => {
    const driver = database.driver;
    console.log(
      `[${resourceName}] connected to ${driver.databaseName ?? '(no database)'} on ${driver.serverVersion ?? 'unknown server'}`,
    );
  })
  .catch((error: unknown) => {
    console.error(`[${resourceName}] failed to connect`, error);
  });

if (typeof on === 'function') {
  on('onResourceStop', (stoppedResource: string) => {
    if (stoppedResource === resourceName) void database.close();
  });
}

export { database, schemas };
