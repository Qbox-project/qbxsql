# oxmysql compatibility

qbxsql implements the query contract of
[oxmysql 2.14.1](https://github.com/overextended/oxmysql/releases/tag/v2.14.1)
and provides the `oxmysql`, `mysql-async`, and `ghmattimysql` export names.
The compatibility surface is pinned: it changes only after a newer upstream
contract has been reviewed and tested, never just to satisfy a version check.

## What is covered

- oxmysql callbacks, promises, `MySQL.*`, `.await`, `_async`, `MySQL.Async`,
  `MySQL.Sync`, and stored queries.
- mysql-async and ghmattimysql exports and imports, including ghmattimysql's
  `insert`/`insertSync` helpers.
- The subtle 2.14.1 behaviors, verified by contract fixtures and a live
  FXServer probe:
  - text-protocol queries convert `TINYINT(1)` and one-bit `BIT` columns to
    booleans, while prepared/raw-execute calls keep mysql2-native values;
  - dates are epoch milliseconds from both protocols;
  - binary values are CFX-safe byte arrays, including oxmysql's `[null]`
    result for a NULL binary blob from a text query;
  - absent bind values and sparse Lua parameter tables become SQL `NULL`;
  - tuple transactions, object transactions, named placeholders, numeric-key
    prepared batches, and multi-row batch flattening are accepted;
  - callback exceptions are isolated, promise calls reject database errors,
    failed statement-list transactions resolve `false` and emit
    `oxmysql:error`.

**Not included:** the oxmysql NUI profiler, its UI commands, and external
logger plugins.

## Deliberate deviations

- **`null` rather than `undefined` for empty results.** `single`, `scalar`,
  and `insert` return `null` where oxmysql returns `undefined`. Both arrive in
  Lua as `nil`; only JavaScript consumers comparing with `=== undefined` can
  tell the difference.
- **The manifest `version` reports the oxmysql contract.** `fxmanifest.lua`
  declares `version '2.14.1'` so dependency checks in other resources pass.
  qbxsql's own version is `qbxsql_version`.

## Switching from oxmysql

1. Back up the database and verify the backup restores.
2. Copy the qbxsql resource into `resources/` and remove or disable the real
   `oxmysql` resource. qbxsql detects a running resource named `oxmysql`,
   reports the conflict, and leaves its own connector inactive rather than
   fighting over exports.
3. Keep your existing connection string — `mysql_connection_string` works
   unchanged — and `ensure qbxsql` before any database consumer.
4. Leave consuming resources alone. `@oxmysql/lib/MySQL.lua` and
   `@mysql-async/lib/MySQL.lua` imports resolve through qbxsql, and no SQL or
   API calls need to change. `mysql_option 'return_callback_errors'` remains
   resource-scoped.
5. Test the things that matter on a staging server with real clients:
   characters, inventory, banking, vehicles, properties, a restart, and a
   planned database outage.

### Convar precedence

qbxsql-native convars win over their legacy names:

- `qbxsql_connection_string` over `mysql_connection_string`
- `qbxsql_slow_query_warning` over `mysql_slow_query_warning`
- `qbxsql_resultset_warning` over `mysql_resultset_warning`
- `qbxsql_debug` over `mysql_debug`
- `qbxsql_transaction_isolation_level` over the legacy name

Connection-string options override connector defaults unless the matching
qbxsql convar was set explicitly. Unknown options are ignored with a warning;
values and credentials are never printed. `namedPlaceholders=false`, JSON
`flags`, and `dateStrings` keep their oxmysql meanings.

### Rollback

Stop consumers, stop qbxsql, restore the real oxmysql resource, start
consumers again. Schema changes qbxsql applied are forward-compatible by
design; it never runs automatic down-migrations. If an explicitly destructive
migration must be reversed, restore the verified backup.

## Restarting qbxsql at runtime

Restart the whole server, not just qbxsql, once any resource has called the
legacy aliases.

The CFX scheduler caches a fetched export closure in the *calling* resource
under the name that was referenced, and only invalidates it when a resource
with that exact name stops. Stopping `qbxsql` clears cached `exports.qbxsql`
entries but leaves cached `exports.oxmysql` entries pointing at dead
functions; the next call fails with "attempted to call a function reference
that no longer exists" until the consumer restarts too.

This is inherent to serving another resource's export name. It does not
affect consumers that call `exports.qbxsql` directly or import
`@qbxsql/lib/MySQL.lua`. The physical bridge resource in
`tests/fxserver/oxmysql_bridge` also avoids it for the `oxmysql` name, because
the bridge is a real resource whose name matches the cache key.

## Supported databases and servers

| Routing | Database |
| --- | --- |
| `MySQL.*`, oxmysql, mysql-async, ghmattimysql | MySQL/MariaDB only |
| `Postgres.*` | PostgreSQL 16+ only |
| Cross-database transactions | Not supported |
| MySQL-to-PostgreSQL SQL translation | Not supported |

CI runs every push against MariaDB 11.4 and PostgreSQL 16 (with pgvector).
MariaDB 10.11/11.8 and MySQL 8.0/8.4 are supported lines that get re-tested
locally when serialization, introspection, or DDL behavior changes.

The minimum FXServer artifact is build `12913`, matching oxmysql 2.14.1's own
floor; the packaged resource is additionally tested on a pinned stock-Linux
artifact through the local containerized gate (see
[development.md](development.md)).

On PostgreSQL, `BIGINT` and `NUMERIC` stay strings to avoid JavaScript
precision loss, timestamps become epoch milliseconds, `BYTEA` becomes byte
arrays, and JSON/JSONB stays structured. See [postgresql.md](postgresql.md).
