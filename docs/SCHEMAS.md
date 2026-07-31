# Declarative schema operations

qbxsql has separate dialect-native schema facades:

- `QBXSQL.Schema` manages MySQL/MariaDB declarations.
- `Postgres.Schema` manages PostgreSQL declarations.

They share the policy model, ownership concepts, adoption workflow, and structured plan fields, but never translate definitions across dialects. PostgreSQL resources must load `@qbxsql/lib/Postgres.lua`; MySQL resources load `@qbxsql/lib/Schema.lua`.

## Modes

- `auto` applies only actions that are both data-safe and database-enforced online, plus explicitly authorized migrations.
- `plan` performs no resource DDL and makes `ensure` return a structured pending-change error.
- `off` rejects `ensure`; explicit planning remains available.

Plans preserve the original fields and add `dataSafe`, `onlineSafe`, `automatic`, `risk`, and selected `algorithm` on every action.

In `plan` mode, callback callers receive `nil, { code = 'QBXSQL_SCHEMA_PENDING_CHANGES', message = ..., result = plan }`; `.await` rejects with the same structured table. DDL that requires an explicit migration similarly returns `QBXSQL_SCHEMA_MIGRATION_REQUIRED` with its plan. Call the explicit planning APIs when normal control flow should return a plan instead of rejecting.

qbxsql requests `ALGORITHM=INSTANT` or `ALGORITHM=INPLACE, LOCK=NONE` based on database/version capability. A server rejection becomes a migration-required plan. There is no automatic fallback to blocking DDL.

For PostgreSQL, ordinary safe DDL is transactional. Indexes on existing tables are built with `CREATE INDEX CONCURRENTLY`; checks and foreign keys are added `NOT VALID` and validated separately. Lock timeout, statement failure, or an invalid interrupted concurrent index becomes a migration-required result and can be safely reconciled on the next ensure.

## Migrations

Structured operations include:

- `renameTable`, `renameColumn`, `addColumn`, `alterColumn`, `dropColumn`, and `dropTable`
- `addIndex` and `dropIndex`
- `addForeignKey` and `dropForeignKey`
- `setPrimaryKey` and `dropPrimaryKey`
- `setTableOptions`
- `releaseTable`
- reviewed raw `sql`

Data-loss operations require `allowDataLoss = true`. Blocking or unknown DDL requires both migration-level `allowBlocking = true` and operator convar `qbxsql_schema_allow_blocking true`.

DDL is journaled because MySQL/MariaDB implicitly commits many schema statements. Successful idempotent operations can resume after interruption; failed raw SQL requires manual inspection.

PostgreSQL migrations additionally support `addCheck`, `dropConstraint`, and `validateConstraint`. Table/index/check/foreign-key definitions support PostgreSQL-native identity columns, JSONB, UUID, partial and included-column indexes, index methods, deferrable foreign keys, and comments. MySQL-only options are rejected. See [POSTGRESQL.md](POSTGRESQL.md).

## Ownership

Only one resource can own a table. Ownership follows a successful rename and is removed only after a successful drop. A declaration cannot silently abandon a table; use `releaseTable` with `allowOwnershipTransfer = true`.

Ownership is bound to the calling resource: qbxsql resolves it from
`GetInvokingResource()`, and the resource name the Lua shim passes is accepted
only when it agrees with the runtime. A resource that tries to manage schemas
under another resource's name is refused with `QBXSQL_SCHEMA_RESOURCE_MISMATCH`.

**Ownership governs DDL, not data access.** It decides which resource may apply
schema changes to a table. It places no restriction on which resource may
`SELECT`, `INSERT`, or `UPDATE` through the ordinary query exports, where the
invoking resource is recorded for logging and attribution only. Do not read
`qbxsql_schema_tables` or `qbxsql_internal.owned_tables` as an access-control
boundary between resources.

Introspection is limited to declared, owned, and migration-source tables. Drift detection covers columns (including enums and `ON UPDATE CURRENT_TIMESTAMP`), primary keys, indexes, foreign keys, engine, charset, and collation. Undeclared columns/indexes/foreign keys are reported but never silently removed.

PostgreSQL introspection is likewise scoped and covers formatted column types, nullability, defaults, identity mode, comments, primary keys, index definition/validity, checks, and foreign keys. Managed application tables are in `public`; internal state is isolated in `qbxsql_internal`.

## Adoption

Use:

```lua
local plan = QBXSQL.Schema.planAdoption.await(schema, baselineVersion)
local adopted = QBXSQL.Schema.adopt.await(schema, baselineVersion)
```

Callback forms take the same schema/baseline followed by a callback. Adoption refuses already-owned/conflicting tables and invalid baselines. The baseline is recorded before migrations above it, allowing a failed adoption to resume safely. qbxsql reconciles the final declaration and claims final tables only after convergence.

The PostgreSQL equivalents are:

```lua
local plan = Postgres.Schema.planAdoption.await(schema, baselineVersion)
local adopted = Postgres.Schema.adopt.await(schema, baselineVersion)
```
