# Declarative schema operations

## Modes

- `auto` applies only actions that are both data-safe and database-enforced online, plus explicitly authorized migrations.
- `plan` performs no resource DDL and makes `ensure` return a structured pending-change error.
- `off` rejects `ensure`; explicit planning remains available.

Plans preserve the original fields and add `dataSafe`, `onlineSafe`, `automatic`, `risk`, and selected `algorithm` on every action.

qbxsql requests `ALGORITHM=INSTANT` or `ALGORITHM=INPLACE, LOCK=NONE` based on database/version capability. A server rejection becomes a migration-required plan. There is no automatic fallback to blocking DDL.

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

## Ownership

Only one resource can own a table. Ownership follows a successful rename and is removed only after a successful drop. A declaration cannot silently abandon a table; use `releaseTable` with `allowOwnershipTransfer = true`.

Introspection is limited to declared, owned, and migration-source tables. Drift detection covers columns (including enums and `ON UPDATE CURRENT_TIMESTAMP`), primary keys, indexes, foreign keys, engine, charset, and collation. Undeclared columns/indexes/foreign keys are reported but never silently removed.

## Adoption

Use:

```lua
local plan = QBXSQL.Schema.planAdoption.await(schema, baselineVersion)
local adopted = QBXSQL.Schema.adopt.await(schema, baselineVersion)
```

Callback forms take the same schema/baseline followed by a callback. Adoption refuses already-owned/conflicting tables and invalid baselines. The baseline is recorded before migrations above it, allowing a failed adoption to resume safely. qbxsql reconciles the final declaration and claims final tables only after convergence.
