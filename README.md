# qbxsql

A database resource for FiveM. Use it with existing oxmysql scripts, or let new
scripts create and maintain their tables from Lua declarations.

[![CI](https://github.com/Qbox-project/qbxsql/actions/workflows/ci.yml/badge.svg)](https://github.com/Qbox-project/qbxsql/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

- **MySQL and MariaDB:** the oxmysql 2.14.1 query API, including legacy
  mysql-async and ghmattimysql exports.
- **Optional schema management:** creates missing tables and applies supported
  safe changes. Destructive changes need explicit migrations.
- **Optional PostgreSQL 16+:** a separate query and schema API. Existing MySQL
  scripts still need MySQL; SQL is never translated between databases.

qbxsql is a **0.x prerelease**. Test your resources on staging before moving a
live server. See [compatibility and limitations](docs/compatibility.md).

## Install

You need FXServer build **12913 or newer** with Node.js 22 resource support,
and an existing database. MariaDB 11.4 and PostgreSQL 16 are covered by CI.
You do not need Node.js, Bun, or npm installed separately to use the release.

1. Download **`qbxsql-<version>.zip`** from
   [Releases](https://github.com/Qbox-project/qbxsql/releases). Extract its
   `qbxsql` folder into your server's `resources` folder.
2. If replacing oxmysql, back up your database, stop the server, remove the old
   database connector resource, and replace its `ensure` line with `ensure qbxsql`.
   Do the same for a standalone mysql-async or ghmattimysql installation.
3. Put your connection string before `ensure qbxsql` in `server.cfg`. Start
   qbxsql before resources that use the database:

   ```cfg
   set mysql_connection_string "mysql://user:password@127.0.0.1/qbox"
   ensure qbxsql
   ensure qbx_core
   ```

4. Start the server and run **`qbxsql_status`** in its console. The configured
   database should report `ready`.

Keep the folder named `qbxsql`. Use the versioned release ZIP for a ready-to-run
installation; the GitHub source archives are intended for contributors.
Passwords with URL-reserved characters must be percent-encoded in a connection URI.

Existing `@oxmysql/lib/MySQL.lua` and `@mysql-async/lib/MySQL.lua` imports can
stay in place. You do not need to adopt schemas or rewrite SQL just to switch
connectors. For updates, restart the whole server: legacy export aliases may
remain cached if only qbxsql is restarted.

## Use it in a resource

Add the import to your resource's `fxmanifest.lua`:

```lua
server_scripts {
    '@qbxsql/lib/MySQL.lua',
    'server.lua'
}
```

Then query from `server.lua`:

```lua
local player = MySQL.single.await(
    'SELECT citizenid, charinfo FROM players WHERE citizenid = ?',
    { citizenid }
)
```

Callbacks, `.await`, prepared queries, and transactions are supported. See the
[compatibility guide](docs/compatibility.md) for supported aliases and differences.

## Optional features

**Let a resource manage its tables.** Import `@qbxsql/lib/Schema.lua` and declare
its desired schema. Start with the [schema guide](docs/schemas.md) and
[Lua example](examples/properties-schema.lua). Existing tables require explicit
adoption; ordinary query usage does not change their schema.

**Add PostgreSQL.** Set this before `ensure qbxsql`:

```cfg
set qbxsql_postgres_connection_string "postgresql://user:password@127.0.0.1/qbox"
```

Import `@qbxsql/lib/Postgres.lua` in resources using PostgreSQL. Both databases
can run together with independent pools and transactions. See the
[PostgreSQL guide](docs/postgresql.md) for queries, schemas, and extensions.

## Help and documentation

| I want to… | Read |
| --- | --- |
| Switch from oxmysql or check compatibility | [Compatibility](docs/compatibility.md) |
| Configure pools, diagnose errors, or monitor outages | [Operations](docs/operations.md) |
| Create tables, adopt an existing schema, or write migrations | [Schemas](docs/schemas.md) |
| Use PostgreSQL or pgvector | [PostgreSQL](docs/postgresql.md) |
| See what changed | [Changelog](CHANGELOG.md) |

Report bugs through [GitHub issues](https://github.com/Qbox-project/qbxsql/issues).
For security issues, use [private vulnerability reporting](https://github.com/Qbox-project/qbxsql/security/advisories/new).
Remove credentials and player data from reports.

Building from source or contributing? Read the
[contributor guide](https://github.com/Qbox-project/qbxsql/blob/main/.github/CONTRIBUTING.md).

## License

[MIT](LICENSE). Bundled dependency notices are in
[dist/THIRD_PARTY_NOTICES.txt](dist/THIRD_PARTY_NOTICES.txt).
