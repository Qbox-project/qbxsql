# Compatibility matrix

## Query API target

The compatibility contract is pinned to [oxmysql 2.14.1](https://github.com/overextended/oxmysql/releases/tag/v2.14.1).

| Surface | Target | Gate |
| --- | --- | --- |
| oxmysql callbacks and promises | 2.14.1 result/error semantics | Static fixtures plus a live stock-FXServer differential probe through qbxsql's packaged `oxmysql` provider |
| `MySQL.*`, `.await`, `Async`, `Sync` | 2.14.1 Lua wrapper | Static fixture and stock FXServer |
| mysql-async aliases/import | oxmysql 2.14.1 mappings | Dedicated FXServer import fixture |
| ghmattimysql aliases | oxmysql 2.14.1 mappings | Contract and FXServer fixture |
| NUI profiling/UI commands | Excluded | Not shipped |
| External logger plugins | Excluded | Not shipped |

Compatibility fixtures also cover the less obvious 2.14.1 behavior:

- text-protocol queries convert `TINYINT(1)` and one-bit `BIT` columns to booleans, while prepared/raw-execute calls retain mysql2-native numeric/buffer values;
- dates from both protocols are epoch milliseconds;
- binary values are CFX-safe byte arrays, including oxmysql's `[null]` result for a NULL binary BLOB from a text query;
- absent bind values and sparse Lua parameter tables become SQL `NULL`;
- tuple transactions (`{ { query, parameters } }`), object transactions, named placeholders, numeric-key prepared batches, and multi-row batch result flattening are accepted;
- callback exceptions are isolated, promise calls reject database errors, failed statement-list transactions resolve `false`, and callback-transaction failures emit `oxmysql:error`;
- `_async`, `Sync`, `Async`, stored-query, mysql-async, and ghmattimysql aliases are registered.

## Database release target

Routine CI uses MariaDB 11.4 and PostgreSQL 16 as the representative integration targets. MariaDB 10.11/11.8 and MySQL 8.0/8.4 remain supported lines and should be rerun locally when query serialization, schema introspection, or DDL behavior changes. They are not separate jobs on every push.

Local development on 2026-07-22 passed the complete 35-test integration suite against each required line: MariaDB 10.11, 11.4, and 11.8 plus MySQL 8.0 and 8.4. MariaDB 12.0.2 also passed locally as rolling-release smoke coverage, but is not a guaranteed support line.

The native PostgreSQL lane supports PostgreSQL 16 and newer. Its hosted gate covers PostgreSQL 16; newer major releases remain compatible targets but should be rerun locally after driver, type conversion, introspection, or DDL changes.

| Routing | Database |
| --- | --- |
| `MySQL.*`, oxmysql, mysql-async, ghmattimysql | MySQL/MariaDB only |
| `Postgres.*` | PostgreSQL only |
| Cross-database transactions | Not supported |
| MySQL-to-PostgreSQL SQL translation | Not supported |

`BIGINT` and `NUMERIC` values remain strings on PostgreSQL to avoid JavaScript precision loss. PostgreSQL timestamps become epoch milliseconds, bytea becomes byte arrays, and JSON/JSONB remains structured data. See [POSTGRESQL.md](POSTGRESQL.md).

## FXServer target

- Minimum stock artifact: server build `12913`, matching the oxmysql 2.14.1 dependency floor.
- Release smoke artifact: the pinned official stock-Linux artifact and SHA-256 recorded by the local runner.
- Historical stock Windows evidence: build `32561` passed the former two-resource packaged compatibility/runtime gate on 2026-07-22.
- Current single-resource stock Linux evidence: recommended build `25770` passed the containerized packaged gate on 2026-07-23, including provider metadata/imports/exports, active-query restart, and concrete-oxmysql conflict handling.
- `bun run test:fxserver` downloads, verifies, caches, and tests the packaged resource locally with disposable MariaDB 11.4 and PostgreSQL 16.
- Enhanced CFX is not an active automation target while it remains in early access. Add a dedicated gate after it becomes the supported production runtime.

Historical local enhanced-CFX results remain useful development evidence, but stock FXServer defines the current runtime contract. Treat a future enhanced build as uncertified until a new focused gate passes.

## Qbox

Qbox is accepted only through the real-client checklist in [QBOX-CERTIFICATION.md]. Unit tests and a headless FXServer pass do not replace character, inventory, banking, vehicle, property, restart, outage, and shutdown persistence checks.
