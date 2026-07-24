# PostgreSQL-native lane

qbxsql can run PostgreSQL by itself or beside MySQL/MariaDB. The pools, lifecycle state, outage queues, transactions, health checks, and schema credentials are independent. There is deliberately no SQL translation and no cross-database transaction coordinator.

## Configuration

```cfg
set qbxsql_postgres_connection_string "postgresql://user:password@127.0.0.1/qbox"
```

PostgreSQL 16 or newer is required. qbxsql uses the pure-JavaScript `pg` driver; it does not load `pg-native` or require compiled database addons.

In a dual setup, every legacy `MySQL.*`, oxmysql, mysql-async, and ghmattimysql call routes to the MySQL lane. Only the `Postgres` facade routes to PostgreSQL:

```lua
server_script '@qbxsql/lib/Postgres.lua'

local character = Postgres.single.await(
    'SELECT id, profile FROM characters WHERE license = $1',
    { license }
)
```

Numbered placeholders are required. qbxsql recognizes placeholders outside quoted strings, quoted identifiers, comments, and dollar-quoted bodies. Missing entries in sparse Lua arrays become SQL `NULL`; named parameter maps and MySQL `?` placeholders are rejected.

## Query API

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
- `DATE`, `TIMESTAMP`, and `TIMESTAMPTZ` are epoch milliseconds; `TIME` remains a PostgreSQL time string.
- `BYTEA` is a numeric byte array.
- `JSON` and `JSONB` are objects/tables.
- PostgreSQL error properties such as SQLSTATE `code`, `detail`, `hint`, table, column, and constraint are preserved. qbxsql does not attach the SQL text, bind list, connection string, or credentials to native errors. PostgreSQL's own message/detail can still describe a rejected value, so do not expose raw database errors directly to clients.

## Declarative schemas

Load `@qbxsql/lib/Postgres.lua` and call `Postgres.Schema.ensure.await(schema)`. Supported column types are:

```text
smallint integer int bigint numeric decimal real double
boolean char varchar text bytea date time timestamp timestamptz
uuid json jsonb inet cidr
```

PostgreSQL columns use `identity = 'always'` or `identity = 'byDefault'`, not MySQL `autoIncrement`. MySQL-only fields such as `unsigned`, `engine`, `charset`, and `collation` are rejected.

Tables support primary keys, named indexes, partial indexes (`where`), included columns (`include`), btree/gin/gist/brin/hash methods, named checks, foreign keys, and comments. The complete example is [postgres-properties-schema.lua](../examples/postgres-properties-schema.lua).

The same `auto`, `plan`, and `off` policy applies to both dialects. PostgreSQL automatic reconciliation uses transactional DDL for ordinary safe changes, `CREATE INDEX CONCURRENTLY`, and `NOT VALID` plus `VALIDATE CONSTRAINT`. A per-resource session advisory lock serializes schema work, and action journals allow interrupted work to be reconciled.

Use `Postgres.Schema.plan.await`, `planAdoption.await`, and `adopt.await` for planning and legacy-table adoption. Only one resource may own a table. Leaving a table unmanaged requires an explicit `releaseTable` migration with `allowOwnershipTransfer = true`.

All managed application tables currently live in the `public` schema. qbxsql stores its registry, migration, action, adoption, and ownership metadata in the reserved `qbxsql_internal` schema.

## Health

```lua
local status = exports.qbxsql:getStatus('postgresql')
local all = exports.qbxsql:getStatuses()
```

PostgreSQL lifecycle events are `qbxsql:postgres:ready`, `qbxsql:postgres:disconnected`, and `qbxsql:postgres:reconnected`. When PostgreSQL is the only configured lane it is also the primary lane and emits the unscoped lifecycle events.
