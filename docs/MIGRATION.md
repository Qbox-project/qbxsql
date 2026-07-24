# Migrating from oxmysql, mysql-async, or ghmattimysql

## Before changing the server

1. Record the current connector version, FXServer artifact, database version, and connection options.
2. Take a database backup and verify that it can be restored.
3. Build the release with `bun run release`, verify it with `bun run release:validate`, and review the SHA-256 checksum.
4. Search resources for oxmysql NUI/profiler commands or external logger plugins; those features are out of scope.
5. Run the complete [Qbox certification checklist](QBOX-CERTIFICATION.md) on a staging server.

## Resource layout

Install the qbxsql directory from the generated artifact:

```cfg
set mysql_connection_string "mysql://user:password@127.0.0.1/qbox"
ensure qbxsql
```

Remove or disable the real `oxmysql` directory. qbxsql deliberately diagnoses the conflict and leaves its connector inactive if a real resource named `oxmysql` is already running.

The resource reports manifest `version '2.14.1'` so dependency checks compare against the oxmysql contract it implements. Its independent prerelease identity is available as `qbxsql_version '0.3.2'`.

## Imports and calls

Existing imports remain valid through qbxsql's provider aliases:

```lua
server_script '@oxmysql/lib/MySQL.lua'
server_script '@mysql-async/lib/MySQL.lua'
```

Existing `MySQL.query`, `.await`, `MySQL.Async`, `MySQL.Sync`, mysql-async exports, and ghmattimysql exports should not need source changes. `mysql_option 'return_callback_errors'` remains resource-scoped.

Ordinary callback errors are logged and suppress the callback unless callback errors were requested. Await/promise calls reject. Failed statement-list transactions resolve `false` and emit `oxmysql:transaction-error`.

## Configuration precedence

qbxsql-native convars take precedence over their legacy names. In particular:

- `qbxsql_connection_string` overrides `mysql_connection_string`.
- `qbxsql_slow_query_warning` overrides `mysql_slow_query_warning`.
- `qbxsql_resultset_warning` overrides `mysql_resultset_warning`.
- `qbxsql_debug` overrides `mysql_debug`.
- `qbxsql_transaction_isolation_level` overrides `mysql_transaction_isolation_level`.

Connection-string options override connector defaults unless a qbxsql option was explicitly set. Unknown options are ignored with a warning; values and credentials are never printed.
`namedPlaceholders=false`, JSON `flags`, and JSON/boolean `dateStrings` retain their oxmysql meanings.

## Declarative schema adoption

Normal `ensure` refuses an unmanaged existing table when reconciliation could be destructive. Plan and adopt it explicitly:

```lua
local plan = QBXSQL.Schema.planAdoption.await(schema, 3)
-- review plan.actions and plan.warnings
local result = QBXSQL.Schema.adopt.await(schema, 3)
```

The baseline must be an integer from `0` through `schema.version - 1`. qbxsql records it before later migrations so interrupted adoption can resume. See [schema operations](SCHEMAS.md).

## Rollback

Stop consumers, stop qbxsql, restore the real oxmysql resource, and start consumers again. Keep forward-compatible schema changes. qbxsql never performs automatic down-migrations; restore the verified backup if an explicitly destructive migration must be reversed.
