# Operations

## Convars

| Convar | Default | Purpose |
| --- | ---: | --- |
| `qbxsql_mysql_connection_string` / `qbxsql_connection_string` / `mysql_connection_string` | unset | MySQL/MariaDB application connection, in precedence order |
| `qbxsql_postgres_connection_string` | unset | PostgreSQL application connection |
| `qbxsql_connection_limit` | `10` | Query pool connection limit; schema use may open one additional connection |
| `qbxsql_connect_timeout` | `60000` | Driver connection timeout (ms) |
| `qbxsql_connection_wait_timeout` | `30000` | Maximum outage queue wait (ms) |
| `qbxsql_connection_queue_limit` | `1000` | Maximum calls waiting for connectivity |
| `qbxsql_health_interval` | `10000` | Idle health-check interval (ms) |
| `qbxsql_connection_retry_max` | `30000` | Maximum reconnect backoff (ms) |
| `qbxsql_transaction_timeout` | `30000` | Callback transaction limit (ms) |
| `qbxsql_slow_query_warning` / `mysql_slow_query_warning` | `200` | Slow-query threshold (ms), `0` disables |
| `qbxsql_resultset_warning` / `mysql_resultset_warning` | `1000` | Warn when a query returns at least this many rows, `0` disables |
| `qbxsql_debug` / `mysql_debug` | `false` | Boolean, or a JSON array of resource names |
| `qbxsql_transaction_isolation_level` / legacy name | `READ COMMITTED` | Session transaction isolation |
| `qbxsql_schema_mode` | `auto` | `auto`, `plan`, or `off` |
| `qbxsql_schema_allow_blocking` | `false` | Operator half of blocking-DDL approval |
| `qbxsql_mysql_schema_connection_string` | unset | Optional MySQL schema-only credentials (`qbxsql_schema_connection_string` is a legacy alias) |
| `qbxsql_postgres_schema_connection_string` | unset | Optional PostgreSQL schema-only credentials |
| `qbxsql_schema_lock_timeout` | MySQL `30000`, PostgreSQL `2000` | Longest a schema DDL statement may wait for a table lock (ms): `lock_wait_timeout` on the MySQL schema session, `lock_timeout` on PostgreSQL |
| `qbxsql_schema_lock_acquire_timeout` | `30000` | Wait for the schema advisory lock before giving up (ms) |
| `qbxsql_postgres_parse_vector_results` | `true` | Parse pgvector `vector`/`halfvec` results into Lua arrays |

Pool size, connection and transaction timeouts, warnings, queue limits,
health intervals, retry delays, and schema-lock options accept a `qbxsql_mysql_` or `qbxsql_postgres_`
prefixed form; the per-lane form wins over the shared value, and native names
win over legacy `mysql_*` names. Invalid values are rejected with sanitized
warnings. Enabling MySQL `multipleStatements` emits a prominent warning
because it increases the impact of SQL injection. Debug and transaction
isolation settings are shared by both databases.

Schema locks use a separate pool with at most one connection per database
service. This leaves the query pool available for introspection and metadata
queries even when its limit is `1`, and serializes local schema application.
Pool status includes this additional connection. Separate schema credentials
create another database service with its own query pool and schema connection.

At least one connection string is required. PostgreSQL must be version 16 or
newer. When both lanes are configured they get independent pools, queues,
health checks, and reconnect coordinators. MySQL is the primary lane for the
unscoped status and lifecycle interfaces; without MySQL, PostgreSQL is
primary.

## Lifecycle and outages

States are `connecting`, `ready`, `reconnecting`, and `closing`. Startup and
reconnect attempts continue indefinitely with jittered exponential backoff
from 250 ms up to `qbxsql_connection_retry_max`. Calls made while the
database is unavailable wait in a bounded queue; overflow and expiry return
normal compatibility errors rather than hanging forever.

These queue limits cover loss of connectivity, not a busy but connected pool.
MySQL's `queueLimit` connection-string option controls its driver queue;
PostgreSQL pool acquisition uses `qbxsql_postgres_connect_timeout`. Ordinary
queries and statement-list transactions have no connector execution deadline.
The callback transaction timeout starts after pool acquisition and covers
`BEGIN`, callback work, `COMMIT`, and rollback. A disconnect or timeout during
commit can leave the outcome unknown; do not blindly retry writes.

Events, primary lane: `qbxsql:ready`, `qbxsql:disconnected`,
`qbxsql:reconnected`. Per lane: `qbxsql:mysql:*` and `qbxsql:postgres:*` with
the same three suffixes.

Status: `qbxsql_status` in the server console, or from code:

```lua
local status = exports.qbxsql:getStatus()               -- primary lane
local lane   = exports.qbxsql:getStatus('postgresql')   -- one lane
local both   = exports.qbxsql:getStatuses()
```

Each result includes lifecycle state, database family/version/name, pool
counts, queue depth, process memory, query/error/slow-query totals, and
reconnect count — never connection strings, credentials, or query values.
Worth alerting on: a non-ready state, rising errors or reconnects, sustained
queue depth, and acquired connections that never return.

`qbxsql_extensions` prints PostgreSQL extension requirements and installed
versions. `unavailable` means the server package is missing; `not-installed`
means `CREATE EXTENSION` has not been run in this database;
`version-too-old` means the enabled version is below a resource's declared
minimum. Those are operator steps — perform them with administrative tooling,
never by putting admin credentials in `server.cfg`.

## When something goes wrong

- **Database outage:** don't restart qbxsql — it already reconnects
  indefinitely and coordinates pool rebuilds to avoid reconnect storms. Watch
  queue depth against the 1,000-call default; calls that wait longer than
  `qbxsql_connection_wait_timeout` fail with normal timeout errors.
- **Stuck callback transaction:** the 30-second timeout destroys the pinned
  connection; confirm the pool's acquired count returned to baseline.
- **Deadlocks / lock timeouts:** fix transaction ordering and indexes in the
  resource; retry at the business layer where idempotency is known.
- **Planned shutdown:** stop write-producing resources first, let queries
  drain, then stop qbxsql. Confirm the next startup emits `qbxsql:ready`.

## Schema incidents

Never set `qbxsql_schema_allow_blocking` globally to get past a plan you
don't understand. Switch `qbxsql_schema_mode` to `plan`, save the structured
action/risk/algorithm output, verify a backup, and schedule a reviewed
migration.

Failed migrations stay journaled. A raw-SQL migration that failed — or
crashed without recording completion — is never retried automatically: inspect
the database, then clear its journal row or supersede it with a new version.

Schema advisory locks are scoped per database (MySQL `GET_LOCK` names include
the database name; PostgreSQL uses per-resource keys), so servers on separate
databases of a shared instance don't contend. On MySQL, lock liveness is
re-verified before migrations and metadata writes — if a reconnect silently
released the lock mid-ensure, the run aborts instead of continuing unlocked.

DDL never waits indefinitely behind a long-running transaction's metadata
lock: each statement gives up after `qbxsql_schema_lock_timeout`, the ensure
fails with the database's lock-wait error, and the advisory lock is released
for other resources. Find and end the blocking transaction, then restart the
resource.

When separate schema credentials are configured, qbxsql verifies both pools
point at the same server and database before granting schema access, for each
lane independently.
