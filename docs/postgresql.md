# PostgreSQL

qbxsql can run PostgreSQL by itself or beside MySQL/MariaDB. The pools,
lifecycle state, outage queues, transactions, health checks, and schema
credentials are independent per lane. There is deliberately no SQL
translation and no cross-database transaction coordinator: legacy APIs always
mean MySQL, and `Postgres.*` always means PostgreSQL.

## Configuration

```cfg
set qbxsql_postgres_connection_string "postgresql://user:password@127.0.0.1/qbox"
```

PostgreSQL 16 or newer is required. qbxsql uses the pure-JavaScript `pg` driver; it does not load `pg-native` or require compiled database addons.

In a dual setup, `MySQL.*` and its compatibility aliases use MySQL/MariaDB.
Use the `Postgres` facade for PostgreSQL queries:

```lua
server_script '@qbxsql/lib/Postgres.lua'

local character = Postgres.single.await(
    'SELECT id, profile FROM characters WHERE license = $1',
    { license }
)
```

Numbered placeholders are required. qbxsql recognizes placeholders outside quoted strings, quoted identifiers, comments, and dollar-quoted bodies. Missing entries in sparse Lua arrays become SQL `NULL`; named parameter maps and MySQL `?` placeholders are rejected.

## Query API

Each call accepts **one SQL statement**, including calls without parameters.
Use `Postgres.transaction` for a group of statements that must succeed together.
Multi-statement strings are rejected by PostgreSQL before execution. Connections
start with `standard_conforming_strings=on`; use `E'...'` for SQL backslash
escapes and keep this setting enabled so placeholder parsing stays consistent.

- `Postgres.query(sql, parameters, callback)` returns an array of rows.
- `Postgres.single(...)` returns the first row or `nil`.
- `Postgres.scalar(...)` returns the first value of the first row or `nil`.
- `Postgres.execute(...)` returns `{ command, rowCount, rows, fields }`.
- Every method has `.await(sql, parameters)`.
- `Postgres.transaction.await(statements)` returns one execute result per statement.
- `Postgres.startTransaction.await(function(query) ... end)` pins one connection and commits only when the callback succeeds.
- `Postgres.ready(callback)` and `Postgres.ready.await()` wait for this lane.

Statement transactions use entries shaped as either SQL strings or `{ query = '...', parameters = { ... } }`. Transactions are local to PostgreSQL; a MySQL operation invoked inside application code is not atomically coordinated with them.

Results retain PostgreSQL semantics safely across CFX:

- `BIGINT` and `NUMERIC` are strings, preserving exact precision.
- `BOOLEAN` is boolean.
- `DATE`, `TIMESTAMP`, and `TIMESTAMPTZ` are epoch milliseconds; their PostgreSQL
  `infinity` sentinels remain numeric positive or negative infinity. `TIME` remains a PostgreSQL time string.
- `BYTEA` is a numeric byte array.
- `JSON` and `JSONB` are objects/tables.
- PostgreSQL error properties such as SQLSTATE `code`, `detail`, `hint`, table, column, and constraint are preserved. qbxsql does not attach the SQL text, bind list, connection string, or credentials to native errors. PostgreSQL's own message/detail can still describe a rejected value, so do not expose raw database errors directly to clients.
- pgvector `vector` and `halfvec` values become dense Lua number arrays by default. Set `qbxsql_postgres_parse_vector_results false` to retain their text representation.

`Postgres.vector({ 0.1, 0.2, 0.3 })`, `Postgres.halfvec(...)`, and
`Postgres.sparsevec(dimensions, valuesByIndex)` produce validated parameter
values. Cast them in SQL when PostgreSQL cannot infer the type, for example
`$1::vector`.

## Extensions

Extensions are database capabilities, not qbxsql npm dependencies. The
PostgreSQL server must have an extension's files installed, and an operator
must enable it once in each database that uses it. qbxsql deliberately does
not download, create, update, or drop extensions and never needs a superuser
connection string.

A resource declares only what it actually needs:

```lua
local schema = {
    version = 1,
    extensions = {
        { name = 'vector', minimumVersion = '0.8.5' },
        { name = 'pg_trgm' }
    },
    tables = {
        property_embeddings = {
            columns = {
                id = { type = 'bigint', identity = 'byDefault', primary = true },
                label = { type = 'text' },
                embedding = { type = 'vector', dimensions = 1536 }
            },
            indexes = {
                {
                    name = 'property_embeddings_hnsw_idx',
                    method = 'hnsw',
                    columns = {
                        {
                            name = 'embedding',
                            operatorClass = 'vector_cosine_ops'
                        }
                    },
                    options = { m = 16, ef_construction = 64 }
                },
                {
                    name = 'property_embeddings_label_trgm_idx',
                    method = 'gin',
                    columns = {
                        { name = 'label', operatorClass = 'gin_trgm_ops' }
                    }
                }
            }
        }
    }
}
```

During `plan`, qbxsql reports one of four states for every requirement:
`ready`, `not-installed`, `unavailable`, or `version-too-old`. `ensure` stops
before application DDL if any requirement is unsatisfied. The structured
error code is `QBXSQL_POSTGRES_EXTENSION_REQUIRED`.

Use either interface to inspect the currently registered requirements:

```text
qbxsql_extensions
```

```lua
local diagnostic = Postgres.extensions.await()
```

### Operator installation

For a new Docker deployment, the simplest reproducible pgvector base is its
published PostgreSQL image:

```yaml
services:
  postgres:
    image: pgvector/pgvector:0.8.5-pg16-bookworm
    environment:
      POSTGRES_DB: qbox
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_ADMIN_PASSWORD}
```

For an existing PostgreSQL 16 host, install the extension's package using the
operating system or vendor instructions. Package names vary by distribution;
common PGDG Debian/Ubuntu examples are:

```sh
sudo apt install postgresql-16-pgvector postgresql-16-postgis-3 postgresql-contrib
```

Then connect as a database administrator and enable only the capabilities
required by installed resources:

```sql
\connect qbox
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;
-- Enable only when a resource actually requires them:
-- CREATE EXTENSION IF NOT EXISTS postgis;
-- CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
```

Do not put the administrator password or an administrator connection string
in `server.cfg`. qbxsql should continue to use an ordinary application role;
extension installation is an operator/deployment step.

`pg_stat_statements` is special: its library must be added to
`shared_preload_libraries` and PostgreSQL restarted before
`CREATE EXTENSION pg_stat_statements`. Other extensions can have their own
preload, packaging, or background-worker requirements; follow the extension's
upstream installation instructions.

Operator references:

- [PostgreSQL extension packaging and `CREATE EXTENSION`](https://www.postgresql.org/docs/16/external-extensions.html)
- [pgvector installation and index options](https://github.com/pgvector/pgvector)
- [PostGIS installation](https://postgis.net/documentation/getting_started/)
- [`pg_stat_statements` preload requirements](https://www.postgresql.org/docs/16/pgstatstatements.html)

## Declarative schemas

Load `@qbxsql/lib/Postgres.lua` and call `Postgres.Schema.ensure.await(schema)`. Supported column types are:

```text
smallint integer int bigint numeric decimal real double
boolean char varchar text bytea date time timestamp timestamptz
uuid json jsonb inet cidr int4range int8range numrange
tsrange tstzrange daterange vector halfvec sparsevec geometry geography
```

PostGIS `geometry`/`geography` columns may optionally declare both
`spatialType` (for example `point`) and `srid` (for example `4326`). Their
schemas must declare the `postgis` extension.

PostgreSQL columns use `identity = 'always'` or `identity = 'byDefault'`, not MySQL `autoIncrement`. MySQL-only fields such as `unsigned`, `engine`, `charset`, and `collation` are rejected.

Tables support primary keys, named indexes, partial indexes (`where`), included columns (`include`), btree/gin/gist/spgist/brin/hash/hnsw/ivfflat methods, per-column operator classes, index storage options, named checks, foreign keys, exclusion constraints, and comments. The complete example is [postgres-properties-schema.lua](../examples/postgres-properties-schema.lua); the shared policy model (modes, migrations, gates, ownership, adoption) is described in [schemas.md](schemas.md).

The same `auto`, `plan`, and `off` policy applies to both dialects. PostgreSQL automatic reconciliation uses transactional DDL for ordinary safe changes, `CREATE INDEX CONCURRENTLY`, and `NOT VALID` plus `VALIDATE CONSTRAINT`. A per-resource session advisory lock serializes schema work, and action journals allow interrupted work to be reconciled.

Use `Postgres.Schema.plan.await`, `planAdoption.await`, and `adopt.await` for planning and legacy-table adoption. Only one resource may own a table. Leaving a table unmanaged requires an explicit `releaseTable` migration with `allowOwnershipTransfer = true`.

All managed application tables currently live in the `public` schema. qbxsql stores its registry, migration, action, adoption, and ownership metadata in the reserved `qbxsql_internal` schema.

## Health

```lua
local status = exports.qbxsql:getStatus('postgresql')
local all = exports.qbxsql:getStatuses()
```

PostgreSQL lifecycle events are `qbxsql:postgres:ready`, `qbxsql:postgres:disconnected`, and `qbxsql:postgres:reconnected`. When PostgreSQL is the only configured lane it is also the primary lane and emits the unscoped lifecycle events.
