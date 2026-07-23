# Operations runbook

## Connector configuration

| Convar | Default | Purpose |
| --- | ---: | --- |
| `qbxsql_connection_string` / `mysql_connection_string` | local development URL | Application database connection |
| `qbxsql_connection_limit` | `10` | Pool connection limit |
| `qbxsql_connect_timeout` | `60000` | Driver connection timeout (ms) |
| `qbxsql_connection_wait_timeout` | `30000` | Maximum outage queue wait (ms) |
| `qbxsql_connection_queue_limit` | `1000` | Maximum calls waiting for connectivity |
| `qbxsql_health_interval` | `10000` | Idle health-check interval (ms) |
| `qbxsql_connection_retry_max` | `30000` | Maximum reconnect backoff (ms) |
| `qbxsql_transaction_timeout` | `30000` | Callback transaction limit (ms) |
| `qbxsql_slow_query_warning` / `mysql_slow_query_warning` | `200` | Slow-query threshold (ms), `0` disables |
| `qbxsql_debug` / `mysql_debug` | `false` | Boolean or JSON resource-name array |
| `qbxsql_transaction_isolation_level` / legacy name | `READ COMMITTED` | Session transaction isolation |
| `qbxsql_schema_mode` | `auto` | `auto`, `plan`, or `off` |
| `qbxsql_schema_allow_blocking` | `false` | Operator half of blocking-DDL approval |
| `qbxsql_schema_connection_string` | unset | Optional schema-only credentials |

Native names win over legacy names. Invalid typed values are rejected with sanitized warnings. Enabling `multipleStatements` emits a prominent warning because it increases the impact of SQL injection.

## Lifecycle and outages

The states are `connecting`, `ready`, `reconnecting`, and `closing`. Startup and reconnect attempts continue indefinitely with jittered exponential backoff from 250 ms to the configured maximum. Calls made while unavailable wait in a bounded queue; overflow and expiry return normal compatibility errors.

Fatal active-query errors and failed idle health checks trigger one pool rebuild coordinator. Listen for:

- `qbxsql:ready`
- `qbxsql:disconnected`
- `qbxsql:reconnected`

Use `qbxsql_status` from the server console or `exports.qbxsql:getStatus()` from a server resource. Alert on non-ready state, rising errors/reconnects, sustained queue depth, slow queries, acquired connections that never return, and final-half process-memory growth.

Status never contains connection strings, credentials, or query parameter values.

## Incident response

1. Capture sanitized status, the first database error code/message, artifact versions, and database server health.
2. Do not repeatedly restart qbxsql; it already reconnects indefinitely and prevents reconnect storms.
3. If the database is intentionally unavailable, watch queue depth against the 1,000-call default and restore service within 30 seconds or expect normal timeout errors.
4. For a stuck callback transaction, confirm the 30-second timeout destroyed the pinned connection and the pool's acquired count returned to baseline.
5. For deadlocks or lock timeouts, inspect transaction order/indexes and retry at the resource/business layer where idempotency is known.
6. Before scheduled shutdown, stop write-producing resources, allow queries to drain, then stop qbxsql. Confirm the next startup emits `qbxsql:ready` and persistence checks pass.

## Schema incidents

Never enable blocking DDL globally to bypass an unexplained plan. Switch to `plan`, save the structured action/risk/algorithm output, verify a backup, and schedule a reviewed migration. Failed migrations remain journaled. Raw SQL migrations that failed are not retried automatically.

When separate schema credentials are configured, qbxsql verifies both pools identify the same server and database before granting schema access.
