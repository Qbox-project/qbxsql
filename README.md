# qbxsql

qbxsql is a resilient MySQL/MariaDB connector and declarative schema manager for Cfx.re/FiveM. The `qbxsql_compat` companion resource targets the oxmysql 2.14.1, mysql-async, and ghmattimysql query contracts.

This is a `0.x` prerelease. Do not treat it as `1.0.0` until the documented database, FXServer, Qbox, failure, and soak gates have passed.

## Installation

Use the generated release artifact, which contains two resource directories:

```text
resources/
├── qbxsql/
└── qbxsql_compat/
```

Remove the real `oxmysql` resource, configure the connection before either resource starts, then start both in this order:

```cfg
set mysql_connection_string "mysql://user:password@127.0.0.1/qbox"
ensure qbxsql
ensure qbxsql_compat
```

The honestly versioned core does not claim legacy resource names. `qbxsql_compat` reports version `2.14.1`, remains client-visible, and provides `oxmysql`, `mysql-async`, and `ghmattimysql`. It refuses to run alongside a real resource named `oxmysql`.

Existing resources can keep their normal imports:

```lua
server_script '@oxmysql/lib/MySQL.lua'
-- or @mysql-async/lib/MySQL.lua
```

Modern qbxsql-native resources may instead load:

```lua
server_script '@qbxsql/lib/MySQL.lua'
```

Callback, `.await`, `_async`, `Sync`, `Async`, stored-query, prepared batch, raw execute, and transaction APIs are supported. Positional `?`/`??` and named `:name`/`@name` parameters are normalized before reaching the driver.

NUI profiling, oxmysql UI commands, and external logger plugins are intentionally not included. See [the migration guide](docs/MIGRATION.md) and [compatibility matrix](docs/COMPATIBILITY.md) before replacing a production connector.

## Resource-owned schemas

Load the schema facade before the declaring resource's bootstrap:

```lua
server_scripts {
    '@qbxsql/lib/Schema.lua',
    'schema.lua',
    'server.lua'
}
```

Then declare and await the required schema:

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

The default `auto` mode applies only changes that are data-safe and enforced online by the database. qbxsql never falls back from `INSTANT` or `INPLACE/LOCK=NONE` to blocking DDL. Destructive, blocking, or data-dependent work requires explicit versioned migrations and operator approval where applicable.

Use `QBXSQL.Schema.plan.await(schema)` for a no-DDL plan. Existing unmanaged tables require explicit `planAdoption` and `adopt` calls with a baseline version. Removing a table from a declaration never deletes or releases it implicitly. See [schema operations](docs/SCHEMAS.md) and [the complete example](examples/properties-schema.lua).

## Health and operations

```lua
local status = exports.qbxsql:getStatus()
```

The sanitized result includes lifecycle state, database family/version/name, pool counts, queue depth, process-memory counters, query/error/slow-query totals, and reconnect count. The same information is available through the server-console command `qbxsql_status`. Lifecycle events are `qbxsql:ready`, `qbxsql:disconnected`, and `qbxsql:reconnected`.

See the [operations runbook](docs/OPERATIONS.md) for convars, outage behavior, monitoring, shutdown, and recovery.

## Development and releases

```sh
bun install
bun run typecheck
bun test
bun run release
bun run release:validate
```

With Docker available, the pinned Linux artifact can be exercised from any host before release:

```sh
CFX_LICENSE_KEY=... QBXSQL_TEST_CONNECTION_STRING=... bun run gate:linux
```

The command rebuilds the release, runs the complete stock FXServer gate in a pinned container, and rewrites loopback database hosts to Docker's host gateway without placing credentials in process arguments.

The deterministic builder produces `release/qbxsql/`, `release/qbxsql_compat/`, a versioned ZIP, and its SHA-256 checksum. Development servers can consume the verified artifact through guarded junctions:

```sh
bun run install:dev -- --resources C:\path\to\server\resources
```

CI definitions cover quality, the LTS database matrix, security scanning, stock/enhanced FXServer gates, and the manually dispatched release-candidate soak. See [release policy](docs/RELEASE.md) and [benchmark gates](docs/BENCHMARKS.md).
