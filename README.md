# qbxsql

qbxsql is a dual-database connector and declarative schema manager for Cfx.re/FiveM. One resource can run MySQL/MariaDB, PostgreSQL, or both at the same time. The MySQL lane targets the oxmysql 2.14.1, mysql-async, and ghmattimysql query contracts; new resources can use the explicit PostgreSQL-native API.

This is a `0.x` prerelease. Promote it only after the lean automated checks, a stock-FXServer smoke test, and the relevant real-Qbox checks pass.

## Installation

Use the generated release artifact, which contains one resource directory:

```text
resources/
└── qbxsql/
```

Remove any real `oxmysql`, `mysql-async`, or `ghmattimysql` connector resources. Configure one or both database lanes before qbxsql starts, then start it before database consumers:

```cfg
# MySQL/MariaDB only
set mysql_connection_string "mysql://user:password@127.0.0.1/qbox"
ensure qbxsql
```

```cfg
# PostgreSQL only
set qbxsql_postgres_connection_string "postgresql://user:password@127.0.0.1/qbox"
ensure qbxsql
```

```cfg
# Both, with independent pools
set qbxsql_mysql_connection_string "mysql://user:password@127.0.0.1/qbox_legacy"
set qbxsql_postgres_connection_string "postgresql://user:password@127.0.0.1/qbox_new"
ensure qbxsql
```

The manifest reports `version '2.14.1'` for oxmysql dependency and version checks while `qbxsql_version '0.4.0'` records the connector's own release. The public `version` stays at the greater of the qbxsql release and the supported oxmysql version, so it will follow qbxsql after qbxsql surpasses `2.14.1`. qbxsql remains client-visible and provides `oxmysql`, `mysql-async`, and `ghmattimysql` directly. It refuses to run alongside a real resource named `oxmysql`.

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

The legacy names always route to MySQL. They are intentionally unavailable in a PostgreSQL-only installation because qbxsql does not translate MySQL SQL into PostgreSQL SQL.

## PostgreSQL-native resources

Load the dedicated facade and use PostgreSQL `$1`, `$2`, ... parameters:

```lua
server_scripts {
    '@qbxsql/lib/Postgres.lua',
    'server.lua'
}

local rows = Postgres.query.await(
    'SELECT id, metadata FROM properties WHERE owner = $1',
    { ownerId }
)

local result = Postgres.execute.await(
    'UPDATE properties SET metadata = $1 WHERE id = $2 RETURNING id',
    { metadata, propertyId }
)
print(result.command, result.rowCount, result.rows[1].id)
```

`Postgres.query`, `single`, `scalar`, and `execute` have callback and `.await` forms. `Postgres.transaction` executes a statement list on one pinned connection, and `Postgres.startTransaction` supports callback-controlled work. PostgreSQL errors are structured and preserve fields such as `code`, `detail`, `hint`, and `constraint` without exposing credentials or bind values.

PostgreSQL 16 or newer is required. `BIGINT` and `NUMERIC` values remain strings to prevent precision loss, timestamps become epoch milliseconds, `BYTEA` becomes a byte array, and JSON/JSONB remains a Lua table. See [the PostgreSQL guide](docs/POSTGRESQL.md).

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

PostgreSQL resources use `Postgres.Schema` with PostgreSQL-native types and operations:

```lua
Postgres.Schema.ensure.await({
    version = 1,
    tables = {
        properties = {
            columns = {
                id = { type = 'bigint', identity = 'byDefault', primary = true },
                owner = { type = 'uuid' },
                metadata = { type = 'jsonb', default = {} },
                created_at = {
                    type = 'timestamptz',
                    defaultExpression = 'CURRENT_TIMESTAMP'
                }
            },
            indexes = {
                { name = 'properties_owner_idx', columns = { 'owner' } }
            }
        }
    }
})
```

The PostgreSQL manager uses transactions for ordinary DDL, concurrent index creation where needed, `NOT VALID` followed by `VALIDATE CONSTRAINT` for online constraint rollout, advisory locks, action journaling, ownership, adoption, and resumable reconciliation. It never accepts MySQL-only schema fields.

## Health and operations

```lua
local primary = exports.qbxsql:getStatus()
local postgres = exports.qbxsql:getStatus('postgresql')
local both = exports.qbxsql:getStatuses()
```

Each sanitized result includes the dialect, lifecycle state, database family/version/name, pool counts, queue depth, process-memory counters, query/error/slow-query totals, and reconnect count. The same information is available through the server-console command `qbxsql_status`. The primary lane emits `qbxsql:ready`, `qbxsql:disconnected`, and `qbxsql:reconnected`; explicit lane events use `qbxsql:mysql:*` and `qbxsql:postgres:*`.

See the [operations runbook](docs/OPERATIONS.md) for convars, outage behavior, monitoring, shutdown, and recovery.

## Development and releases

```sh
bun install
bun run typecheck
bun test
bun run release
bun run release:validate
```

With Docker available, the packaged resources can be exercised locally on the pinned official stock-Linux artifact:

```sh
bun run cfx-key:save
bun run test:fxserver
```

`cfx-key:save` securely prompts once and stores the key in `.cache/qbxsql/cfx-license-key`, which is gitignored and restricted to the local user where the operating system supports Unix file modes. `test:fxserver` uses `CFX_LICENSE_KEY` first, then the saved key, and otherwise shows the same hidden prompt without saving it. It rebuilds the release, downloads and verifies the stock artifact once, and reuses it from `.cache/`. The command creates isolated MariaDB 11.4 and PostgreSQL 16 containers plus a Docker network, runs the complete packaged dual-database FXServer gate, then removes the databases, network, and temporary server configuration. No external database, GitHub secret, `act` installation, or self-hosted runner is required.

GitHub Actions intentionally contains only `CI`: one hosted job for typechecking, unit/contract tests, the build, and MariaDB 11.4 plus PostgreSQL 16 integration tests on pushes to `main` and pull requests. FXServer execution is deliberately local because it requires each tester's own CFX key.

The deterministic builder produces `release/qbxsql/`, a versioned ZIP, and its SHA-256 checksum. Development servers can consume the verified artifact through a guarded junction:

```sh
bun run install:dev -- --resources C:\path\to\server\resources
```

Broader database checks, benchmarks, and canary tooling remain available for targeted local validation; they are not continuously scheduled workflows. See [release policy](docs/RELEASE.md), [optional benchmark checks](docs/BENCHMARKS.md), and [canary evidence](docs/CANARY.md).
