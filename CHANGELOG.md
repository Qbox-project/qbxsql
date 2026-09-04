# Changelog

All notable changes are recorded here. qbxsql follows semantic versioning after `1.0.0`; `0.x` releases may still change prerelease APIs.

## Unreleased

- Fixed `@qbxsql/lib/Postgres.lua` crashing at load ("attempt to index a
  function value") and leaving the `Postgres` global unpublished for every
  resource that imports it: the facade's `__index` fallthrough turned the
  `Postgres.Schema` read into a passthrough function.
- Fixed declared `json` columns never converging on MariaDB, which stores
  JSON as `longtext`; the first `ensure` failed with "did not converge".
- Fixed `QBXSQL_SCHEMA_RESOURCE_MISMATCH` refusals of every legitimate schema
  call on server builds that attribute qbxsql's own cross-runtime exports to
  qbxsql itself; the connector's own name now counts as unresolvable
  attribution, like `unknown`.
- Stopped "Unhandled promise rejection" warnings when a schema refusal or
  query error is delivered to a Lua callback: CFX function references return
  a promise for the caller's completion, and its mirrored rejection now gets
  a handler at every callback site.
- Stopped counting and warning about qbxsql's own schema introspection in the
  slow-query accounting; on servers with slow `INFORMATION_SCHEMA` these
  warnings drowned real output. Debug mode still shows the queries.
- Removed internal release-evidence tooling (certification template, runtime
  evidence, soak/canary validators) and reorganized the documentation.

## 0.6.0 - 2026-08-01

Correctness release for the schema managers, driven by a full external-style
review. Prerelease installs that already ran 0.5.0 schema management should
expect one-time journal churn: PostgreSQL reconcile action keys and any
in-flight `running` migration rows are interpreted more strictly.

- Fixed MySQL/MariaDB drift comparison for literal column defaults: MariaDB
  10.2.7+ reports them quoted, so any string default produced a spurious
  MODIFY COLUMN and ensure() failed to converge on every boot.
- Fixed PostgreSQL drift comparison by canonicalizing declared defaults, check
  expressions, partial-index predicates, and exclusion definitions through the
  server's own deparser (session-local scratch table) instead of string
  normalizers, and fixed the outer-paren strip corrupting compound
  expressions. Ordinary schemas with dates, casts, or varchar comparisons now
  converge instead of failing ensure() unrecoverably.
- Fixed crash-window migration replay: MySQL raw-SQL migrations stuck at
  `running` are refused instead of blindly re-run, the original migration
  error survives a failed status write, PostgreSQL journal completion commits
  atomically with its DDL, and concurrent index builds are replayable.
- Closed the implicit-adoption holes: the refusal now runs under the advisory
  lock on every ensure (not only before the first registration), tables are
  claimed before/with their creation so interrupted first runs resume,
  PostgreSQL adoption migrations cannot touch tables another resource owns,
  raw SQL may not reference qbxsql metadata tables, and `releaseTable`
  enforces `allowOwnershipTransfer` at runtime in both lanes.
- Hardened expression fragments against ALTER-subcommand smuggling: balanced
  parentheses are required and comment tokens and dollar quoting are rejected
  outside quoted spans.
- Reworked the schema advisory locks: MySQL lock names are scoped per
  database, lock liveness is verified before migrations and metadata writes
  so a mid-ensure reconnect aborts instead of running unlocked, PostgreSQL
  uses per-resource keys with a separate metadata-creation key and races on
  `CREATE ... IF NOT EXISTS` are tolerated, and the acquisition wait is
  configurable via `qbxsql_schema_lock_acquire_timeout`.
- Made `addForeignKey` migrations actually work online: orphan pre-check, the
  constraint is added with `ALGORITHM=INPLACE, LOCK=NONE` on a dedicated
  `foreign_key_checks=0` session that is destroyed on failure, then
  re-verified -- mirroring the PostgreSQL `NOT VALID` rollout. Authorized
  blocking migrations keep the fully validating ALTER.
- Refused silently-unenforceable online DDL: when the server version cannot
  enforce the promised algorithm, the migration errors with the dual
  authorization required instead of emitting a bare statement the server may
  run as a locking COPY. `addColumn` falls back from INSTANT to enforced
  INPLACE first.
- Fixed `setPrimaryKey` blocking classification to be data-dependent: adding a
  table's first primary key is an online INPLACE rebuild and no longer
  demands operator signoff; replacing one still does. Adoption plans now
  render migration statements with the same capabilities and introspection
  data `adopt()` executes with.
- Fixed the pool-connection isolation-level setup to handle errors and discard
  the connection, and removed double normalization on the prepared paths.
- Gate scripts now warn when database connection strings are passed as
  command arguments, and gate/probe FXServer configs set `sv_master1 ""`.
- Extended CI integration coverage: quoted/deparsed default and expression
  convergence in both lanes, raw-SQL resume and implicit-adoption guards,
  online foreign keys, real outage recovery by killing server-side
  connections, and an entry-point wiring smoke test that executes
  `src/index.ts` under faked CFX globals against live databases.

## 0.5.0 - 2026-07-24

- Added verify-only PostgreSQL extension requirements with minimum versions,
  actionable unavailable/not-enabled/outdated states, structured schema errors,
  cached health summaries, the `Postgres.extensions` API, and the
  `qbxsql_extensions` console diagnostic.
- Added pgvector-native `vector`, `halfvec`, and `sparsevec` schema types,
  dimension validation, HNSW/IVFFlat indexes, per-column operator classes,
  index storage options, safe Lua vector parameter helpers, and optional dense
  vector result parsing.
- Added generic extension-ready operator-class indexes and PostgreSQL exclusion
  constraints. Blocking exclusion changes remain protected by migration and
  operator approval.
- Pinned the hosted PostgreSQL integration service and local stock-Linux
  FXServer gate to pgvector 0.8.5 on PostgreSQL 16 and exercised extension
  discovery, schema reconciliation, HNSW catalog drift, parameters, and result
  parsing end to end.
- Documented operator-owned extension installation, per-database enablement,
  least-privilege application credentials, Docker/PGDG examples, and
  `pg_stat_statements` preload requirements.

## 0.4.0 - 2026-07-24

- Added an independent PostgreSQL 16+ lane using the pure-JavaScript `pg` driver. PostgreSQL-only and simultaneous MySQL/PostgreSQL deployments are supported with separate pools, reconnect lifecycles, queues, health status, events, and schema credentials.
- Added the `Postgres` Lua facade with callback and `.await` query/single/scalar/execute methods, statement-list and callback transactions, `$1` parameter validation, structured PostgreSQL errors, and precision-safe CFX value conversion.
- Added `Postgres.Schema` with PostgreSQL-native types, identity columns, JSONB, UUID, checks, foreign keys, partial/include/method indexes, comments, plan/auto/off modes, advisory locking, action journals, ownership, adoption, separate credentials, transactional DDL, concurrent indexes, and `NOT VALID` constraint rollout.
- Kept all oxmysql, mysql-async, and ghmattimysql names routed exclusively to MySQL/MariaDB; qbxsql performs no SQL translation and no cross-database transactions.
- Extended the lean hosted CI and local packaged stock-Linux FXServer gate to exercise MariaDB 11.4 and PostgreSQL 16 together.
- Added support for an explicitly marked physical `oxmysql` bridge resource for scripts that refuse CFX `provide` aliases.
- Added `ghmattimysql` `insert` and `insertSync` provider exports for resources that use the extended legacy insert helpers.

## 0.3.2 - 2026-07-24

- Matched oxmysql's distinct text- and prepared-protocol casting: query `TINYINT(1)`/`BIT` values retain legacy booleans, prepared values remain mysql2-native, dates remain epoch milliseconds, binary BLOBs become byte arrays, and a NULL binary BLOB from a text query becomes `[null]`.
- Added tuple transactions, numeric-key CFX prepared batches, multi-row raw-execute flattening, placeholder-free extra-parameter tolerance, SELECT misuse returning `nil` from insert/update helpers, and normalized error-event parameters.
- Isolated consumer callbacks so thrown callback errors never cause duplicate invocation or false database-error events; callback-transaction failures now emit `oxmysql:error` while resolving `false`.
- Added functional lifecycle/store/start-transaction `_async` and `Sync` aliases, `mysql_resultset_warning`, `namedPlaceholders=false`, and validated `flags`/`dateStrings` connection options.
- No mysql2 or named-placeholder dependency patch is required for these compatibility behaviors.

## 0.3.1 - 2026-07-24

- Fixed sparse one-based CFX parameter records so optional `nil` values remain SQL `NULL` instead of duplicating the preceding argument.
- Fixed `TINYINT(1)` and `BIT` result casting so mysql2 packets are consumed exactly once, including legacy non-boolean values.
- Merged the oxmysql, mysql-async, and ghmattimysql providers into the single qbxsql resource. The manifest exposes oxmysql `version '2.14.1'` for dependency checks and `qbxsql_version '0.3.1'` for the native release identity.
- Added CFX resource-tick scheduling and reduced prepared-batch, parameter parsing, result serialization, and field-metadata overhead; a same-machine smoke run reached oxmysql 2.14.1 throughput and latency parity.
- The required local MariaDB 10.11/11.4/11.8 and MySQL 8.0/8.4 integration runs pass.
- A local one-hour, 100-worker reconnect soak and ten-minute same-hardware oxmysql 2.14.1 comparison pass every reliability, transaction, pool, memory, median, and p95 gate.
- Stock Linux FXServer build 25770 passes the pinned containerized release gate, including restart and connector-conflict coverage.
- Added sanitized runtime evidence archives and a monitor/validator for continuous seven-day canary evidence.
- Added a strict, release-bound evidence template and validator for the 21 real-client Qbox certification checks.

## 0.3.0 - 2026-07-22

- Added safe `auto`, no-DDL `plan`, and disabled `off` schema modes.
- Enforced online DDL algorithms without blocking fallback.
- Added structured constraints/table options, ownership release, drift detection, scoped introspection, separate schema credentials, and resumable adoption.
- Added deterministic releases, verified development installation, database/FXServer CI definitions, and benchmark/soak gates.

## 0.2.0 - 2026-07-22

- Added a client-visible oxmysql 2.14.1 compatibility provider (merged into the core resource in the next release).
- Added oxmysql/mysql-async/ghmattimysql callback, promise, transaction, stored-query, and Lua wrapper compatibility.
- Added resilient connection states, bounded outage queues, retry/backoff, health checks, reconnect events, status reporting, and callback-transaction timeouts.
