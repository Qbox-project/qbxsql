# Declarative schemas

Resources declare what their tables should look like; qbxsql makes the
database match, within strict safety rules. There are two dialect-native
facades that share the same policy model but never translate between dialects:

- `QBXSQL.Schema` for MySQL/MariaDB — load `@qbxsql/lib/Schema.lua`.
- `Postgres.Schema` for PostgreSQL — load `@qbxsql/lib/Postgres.lua`
  (see [postgresql.md](postgresql.md) for its native types).

A runnable walkthrough of everything on this page lives in
[qbxsql_example](https://github.com/Qbox-project/qbxsql_example); a compact
declaration to copy from is
[examples/properties-schema.lua](../examples/properties-schema.lua).

## Declaring and ensuring

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
        properties = {
            columns = {
                id = { type = 'bigint', unsigned = true, autoIncrement = true, primary = true },
                owner = { type = 'varchar', length = 64 },
                label = { type = 'varchar', length = 100 },
                price = { type = 'int', unsigned = true, default = 0 },
                created_at = { type = 'timestamp', defaultExpression = 'CURRENT_TIMESTAMP' }
            },
            indexes = {
                { name = 'properties_owner_idx', columns = { 'owner' } }
            }
        }
    }
})
```

On a fresh database this creates the table and records the resource as its
owner. On every later start, `ensure` compares the declaration against the
live database and is a no-op when nothing changed.

Declare an index on any foreign key's columns; otherwise InnoDB generates one
named after the constraint and it shows up as unmanaged drift.

## What applies automatically

In the default `auto` mode, `ensure` applies only changes that are both
**data-safe** and **enforced online** by the database — adding a nullable or
defaulted column, widening a varchar, adding or dropping an index. qbxsql
requests `ALGORITHM=INSTANT` or `ALGORITHM=INPLACE, LOCK=NONE` based on the
server's capabilities and never falls back to blocking DDL: if the server
rejects or cannot enforce the online algorithm, the change becomes a
migration-required error instead of a statement that might run as a locking
copy.

Two things worth knowing:

- Widening a `varchar` is only online while the byte length stays under 256 —
  with `utf8mb4` that means 63 characters. Wider than that needs a migration.
- On MariaDB, `json` columns are stored as `longtext`; declare `type = 'json'`
  normally and qbxsql converges.

For PostgreSQL, ordinary safe DDL is transactional, indexes on existing
tables build with `CREATE INDEX CONCURRENTLY`, and checks and foreign keys
roll out online as `NOT VALID` followed by `VALIDATE CONSTRAINT`. Declared
defaults and expressions are canonicalized through the server's own deparser
before drift comparison, so author text and catalog text always compare in
the same form. Expression fragments must be single balanced expressions
without SQL comments or dollar quoting.

## Modes

Set with `qbxsql_schema_mode`:

- `auto` (default) — apply safe changes and explicitly authorized migrations.
- `plan` — never apply resource DDL; `ensure` returns a structured
  `QBXSQL_SCHEMA_PENDING_CHANGES` error carrying the plan.
- `off` — reject `ensure` entirely; the planning APIs still work.

`QBXSQL.Schema.plan.await(schema)` dry-runs any declaration: every action in
the result carries `sql`, `algorithm`, `risk`, `dataSafe`, `onlineSafe`, and
`automatic`, so an operator can see exactly what would run before it runs.

## Migrations

Everything that is destructive, blocking, or data-dependent needs a versioned
migration. Bump the schema `version`, describe the change as structured
operations, and declare the final desired state in `tables`:

```lua
QBXSQL.Schema.ensure.await({
    version = 2,
    tables = { ... },  -- final state, with `label` instead of `title`
    migrations = {
        {
            version = 2,
            name = 'rename property title',
            operations = {
                { type = 'renameColumn', table = 'properties', from = 'title', to = 'label' }
            }
        }
    }
})
```

Operations: `renameTable`, `renameColumn`, `addColumn`, `alterColumn`,
`dropColumn`, `dropTable`, `addIndex`, `dropIndex`, `addForeignKey`,
`dropForeignKey`, `setPrimaryKey`, `dropPrimaryKey`, `setTableOptions`,
`releaseTable`, and reviewed raw `sql`. PostgreSQL adds `addCheck`,
`dropConstraint`, and `validateConstraint`.

The rules:

- Migrations with `registryVersion < version <= schema.version` run in order,
  once, and are journaled with a checksum.
- An applied migration can never be edited — the checksum mismatch is refused
  with "changed after it ran". Write a new version instead.
- Versions only move forward; an older declaration is refused as a downgrade.
- Fresh installs skip migrations and create the final declared state
  directly; migrations exist for upgrades.
- Raw `sql` operations may not reference qbxsql's own metadata tables, and a
  raw-SQL migration that failed — or crashed without recording completion —
  is never blindly re-run: inspect the database, then clear its journal row
  or supersede it with a new version.

### Two safety gates

- **Author gate:** operations that can lose data (`dropColumn`, `dropTable`,
  narrowing `alterColumn`, raw `sql`) require `allowDataLoss = true` on the
  operation.
- **Operator gate:** operations the server may execute as blocking DDL
  additionally require `allowBlocking = true` on the migration **and** the
  server owner setting `qbxsql_schema_allow_blocking true`. A resource can
  never lock or destroy a live database on restart without a human in the
  loop.

`setPrimaryKey` is data-dependent: adding a table's first primary key runs
online without operator signoff; replacing an existing one requires it.

`addForeignKey` runs online without blocking authorization: qbxsql verifies
no orphaned rows exist, adds the constraint with `ALGORITHM=INPLACE,
LOCK=NONE` on a dedicated session with `foreign_key_checks` disabled (new
writes are enforced from that moment), and re-verifies afterwards — the MySQL
analogue of PostgreSQL's `NOT VALID` rollout. With blocking authorization the
fully validating ALTER runs instead.

## Ownership

One resource owns each managed table. Ownership follows a successful rename
and is removed only after a successful drop. Removing a table from a
declaration without saying what happens to it is refused — use `dropTable`,
`renameTable`, or `releaseTable` with `allowOwnershipTransfer = true`.

Ownership is bound to the calling resource (resolved from
`GetInvokingResource()`; the shim-supplied name is accepted when it agrees
with the runtime or when the runtime cannot attribute the call). A resource
that tries to manage schemas under another resource's name is refused with
`QBXSQL_SCHEMA_RESOURCE_MISMATCH`.

**Ownership governs DDL, not data access.** Any resource may still `SELECT`,
`INSERT`, or `UPDATE` through the ordinary query exports; the invoking
resource is recorded there for logging only.

Drift detection covers columns (including enums and
`ON UPDATE CURRENT_TIMESTAMP`), primary keys, indexes, foreign keys, engine,
charset, and collation. Undeclared columns, indexes, and foreign keys are
reported as warnings but never dropped automatically.

## Adopting existing tables

Servers migrating from `.sql` imports already have the tables. `ensure`
deliberately refuses to absorb an existing unmanaged table; adoption brings
it under management explicitly, without touching data:

```lua
local plan = QBXSQL.Schema.planAdoption.await(schema, baselineVersion)
-- review plan.actions and plan.warnings
local result = QBXSQL.Schema.adopt.await(schema, baselineVersion)
```

The baseline says which schema version the legacy shape corresponds to
(an integer from `0` through `schema.version - 1`); migrations above it run
during adoption. The baseline is recorded first, so a failed adoption resumes
safely on the next attempt. Adoption is one-time per resource: once a
resource has a managed schema, further adoptions are refused.

## Errors

Refusals reject (or call back) with structured tables: `err.code`
(`QBXSQL_SCHEMA_MIGRATION_REQUIRED`, `QBXSQL_SCHEMA_PENDING_CHANGES`,
`QBXSQL_SCHEMA_DISABLED`, `QBXSQL_SCHEMA_RESOURCE_MISMATCH`,
`QBXSQL_SCHEMA_ERROR`), `err.message`, and — where applicable — `err.plan`
with the exact actions that were blocked. The PostgreSQL codes use a
`QBXSQL_POSTGRES_` prefix. Every API has both callback and `.await` forms.
