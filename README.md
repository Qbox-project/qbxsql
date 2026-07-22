# qbxsql

`qbxsql` is a server-side database adapter for Cfx.re/FiveM. It targets MySQL
and MariaDB first, while keeping the driver boundary open for PostgreSQL.

The resource is being built around three layers:

- a database-driver-neutral query service;
- compatibility adapters for oxmysql, mysql-async, and ghmattimysql;
- declarative, resource-owned schemas with safe reconciliation and versioned
  migrations.

## Development

```sh
bun install
bun run typecheck
bun test
bun run build
```

Built output is written to `dist/index.cjs`, which FXServer loads through
`fxmanifest.lua`.

## Installation

Create the database, configure the connection string before resources start,
and start `qbxsql` before database consumers:

```cfg
set mysql_connection_string "mysql://user:password@127.0.0.1/qbox"
ensure qbxsql
```

The resource also declares itself as a provider for `oxmysql`, `mysql-async`,
and `ghmattimysql`. Existing dependencies and the common callback, await,
`Async`, and `Sync` query APIs are forwarded into the qbxsql core.

For modern Lua resources, load the compatibility library:

```lua
server_script '@qbxsql/lib/MySQL.lua'
```

Then use the familiar API:

```lua
local user = MySQL.single.await('SELECT * FROM users WHERE id = ?', { userId })
```

Positional `?`/`??` parameters and named `:name`/`@name` parameters are
supported. Values are normalized before reaching the driver; missing values
become SQL `NULL`, and binary buffers become Lua byte arrays.

## Resource-owned schemas

A resource can declare the schema it needs by loading the schema façade before
its own schema bootstrap:

```lua
server_scripts {
    '@qbxsql/lib/Schema.lua',
    'schema.lua',
    'server.lua'
}
```

`schema.lua` can block initialization until its storage is ready:

```lua
QBXSQL.Schema.ensure.await({
    version = 1,
    tables = {
        properties = {
            columns = {
                id = {
                    type = 'bigint',
                    unsigned = true,
                    autoIncrement = true,
                    primary = true
                },
                label = { type = 'varchar', length = 100 }
            }
        }
    }
})
```

qbxsql records the invoking resource as the table owner, serializes schema
changes with a database lock, and keeps schema and migration checksums in its
metadata tables. Removing a table or column from the declaration never deletes
it automatically.

Safe desired-state changes are reconciled automatically, including:

- creating missing tables;
- adding nullable columns or columns with defaults;
- widening string columns;
- relaxing a column to allow `NULL`;
- adding ordinary indexes.

Potentially destructive or data-dependent changes require a versioned
migration. This includes narrowing or changing column types, required-column
backfills, primary-key changes, unique constraints, foreign keys on existing
data, and deletion. Operations that can discard data require
`allowDataLoss = true`.

Use `QBXSQL.Schema.plan.await(schema)` to inspect generated SQL without making
changes. See `examples/properties-schema.lua` for a complete declaration and
migration.

Schema DDL is journaled rather than treated as transactionally rollbackable,
because MySQL and MariaDB implicitly commit many `CREATE` and `ALTER`
statements. Failed migration state is retained for diagnosis and idempotent
operations can be retried.

## Driver boundary

All Lua and compatibility APIs call a driver-neutral database service. The
current implementation supplies the MySQL/MariaDB driver; PostgreSQL can be
added as another driver without changing resource-facing APIs. SQL syntax and
schema compilation are currently MySQL-specific and will receive a PostgreSQL
dialect alongside that future driver.

