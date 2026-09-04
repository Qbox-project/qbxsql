<div align="center">

# qbxsql

**Database connector and declarative schema manager for FiveM.**

[![CI](https://github.com/Qbox-project/qbxsql/actions/workflows/ci.yml/badge.svg)](https://github.com/Qbox-project/qbxsql/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

One resource that replaces oxmysql, adds an optional PostgreSQL lane, and lets
resources declare their database schema in Lua instead of shipping `.sql` files.

</div>

---

## What it does

**Drop-in oxmysql replacement.** qbxsql implements the oxmysql 2.14.1 query
contract and provides the `oxmysql`, `mysql-async`, and `ghmattimysql` export
names. Existing resources keep their imports and their SQL — no source changes.

**Declarative schemas.** A resource declares what its tables should look like;
qbxsql creates them on a fresh database, verifies them on every start, and
applies safe changes online. Anything destructive or blocking requires an
explicit versioned migration, signed off by both the script author and the
server owner. No more "import this .sql file before starting".

**Optional PostgreSQL.** A separate PostgreSQL 16+ lane with its own pools,
lifecycle, and schema manager. Run MySQL/MariaDB only, PostgreSQL only, or both
side by side. Legacy APIs always route to MySQL; qbxsql never translates SQL
between dialects.

## Installation

Download the latest [release](https://github.com/Qbox-project/qbxsql/releases)
(or clone this repository — the built resource is committed) into your
`resources/` folder, remove any real `oxmysql`, `mysql-async`, or
`ghmattimysql` resource, and configure a database before qbxsql starts:

```cfg
# MySQL/MariaDB
set mysql_connection_string "mysql://user:password@127.0.0.1/qbox"
ensure qbxsql
```

```cfg
# PostgreSQL
set qbxsql_postgres_connection_string "postgresql://user:password@127.0.0.1/qbox"
ensure qbxsql
```

```cfg
# Both, with independent pools
set qbxsql_mysql_connection_string "mysql://user:password@127.0.0.1/qbox_legacy"
set qbxsql_postgres_connection_string "postgresql://user:password@127.0.0.1/qbox_new"
ensure qbxsql
```

Start qbxsql before any resource that touches the database. If a real resource
named `oxmysql` is still running, qbxsql refuses to start its connector and
says so, instead of fighting over exports.

> [!NOTE]
> The manifest reports `version '2.14.1'` so other resources' oxmysql
> dependency checks keep passing. qbxsql's own version lives in
> `qbxsql_version`.

## Queries

Existing resources keep working as-is:

```lua
server_script '@oxmysql/lib/MySQL.lua'   -- or @mysql-async/lib/MySQL.lua
```

New resources can import the same API under qbxsql's own name:

```lua
server_script '@qbxsql/lib/MySQL.lua'
```

Callbacks, `.await`, `_async`, `Sync`/`Async`, stored queries, prepared
batches, raw execute, and transactions all follow oxmysql 2.14.1 semantics,
including the subtle ones (boolean casting, epoch-millisecond dates, byte-array
blobs). The differences that exist are deliberate and documented in
[docs/compatibility.md](docs/compatibility.md).

## Schemas

Declare tables instead of shipping `.sql` files:

```lua
server_scripts {
    '@qbxsql/lib/MySQL.lua',
    '@qbxsql/lib/Schema.lua',
    'schema.lua',
    'server.lua'
}
```

```lua
-- schema.lua
QBXSQL.Schema.ensure.await({
    version = 1,
    tables = {
        myscript_players = {
            columns = {
                id = { type = 'bigint', unsigned = true, autoIncrement = true, primary = true },
                citizenid = { type = 'varchar', length = 50 },
                cash = { type = 'int', unsigned = true, default = 0 },
                metadata = { type = 'json', nullable = true }
            },
            indexes = {
                { name = 'myscript_players_citizenid_idx', columns = { 'citizenid' }, unique = true }
            }
        }
    }
})
```

On a fresh database this creates the table. On every later start it verifies
the declaration against the live database: safe changes (new columns, wider
varchars, new indexes) are applied with enforced online DDL, and anything that
could lose data or lock a live table is refused until you write a versioned
migration for it. Tables that already exist — every server migrating from
`.sql` imports — are brought under management explicitly with the adoption API.

The full model (migrations, safety gates, ownership, adoption, dry-run plans)
is documented in [docs/schemas.md](docs/schemas.md), and
[qbxsql_example](https://github.com/Qbox-project/qbxsql_example) is a runnable
walkthrough resource that demonstrates all of it against a live test server.

## PostgreSQL

```lua
server_script '@qbxsql/lib/Postgres.lua'

local row = Postgres.single.await(
    'SELECT id, profile FROM characters WHERE license = $1',
    { license }
)
```

`Postgres.query`/`single`/`scalar`/`execute` with callback and `.await` forms,
transactions, structured errors, precision-safe type conversion, a
PostgreSQL-native schema manager (identity columns, JSONB, partial indexes,
`NOT VALID` constraint rollout), and verify-only extension requirements
including pgvector types and indexes. See
[docs/postgresql.md](docs/postgresql.md).

## Monitoring

```lua
local status  = exports.qbxsql:getStatus()              -- primary lane
local pg      = exports.qbxsql:getStatus('postgresql')  -- one lane
local both    = exports.qbxsql:getStatuses()
```

The same information is available from the server console via `qbxsql_status`
(and `qbxsql_extensions` for PostgreSQL extension state). Lifecycle events:
`qbxsql:ready`, `qbxsql:disconnected`, `qbxsql:reconnected`, plus per-lane
`qbxsql:mysql:*` and `qbxsql:postgres:*`. Status output never contains
credentials or query values.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/compatibility.md](docs/compatibility.md) | oxmysql compatibility details, deliberate deviations, switching from oxmysql, supported databases |
| [docs/schemas.md](docs/schemas.md) | Declarative schemas: modes, migrations, safety gates, ownership, adoption |
| [docs/postgresql.md](docs/postgresql.md) | The PostgreSQL lane: queries, types, schemas, extensions |
| [docs/operations.md](docs/operations.md) | Every convar, lifecycle and outage behavior, incident guidance |
| [docs/development.md](docs/development.md) | Building, the test suites, benchmarks, releases |

## Status

qbxsql is a `0.x` prerelease. The query layer is contract-tested against
oxmysql 2.14.1 fixtures, integration-tested against live MariaDB and
PostgreSQL on every push, and exercised on a real packaged FXServer through a
local containerized gate. Treat it accordingly: test on staging with a
verified backup before putting it in front of players, and report anything
surprising in the [issues](https://github.com/Qbox-project/qbxsql/issues).

## License

[MIT](LICENSE)
