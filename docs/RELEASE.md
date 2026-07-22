# Release and rollout policy

## Version progression

1. `0.2.x`: compatibility shim, failure semantics, configuration, and reconnect lifecycle.
2. `0.3.x`: schema safety, adoption, online DDL, and separate credentials.
3. `1.0.0-rc.x`: completed database/FXServer matrices, Qbox certification, artifacts, and soak evidence.
4. `1.0.0`: only after every required gate is linked and green.

Never change the shim from `2.14.1` merely to satisfy a dependency check. Change it only after verifying a newer upstream contract.

## Release construction

Run:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run release
bun run release:validate
```

The output contains `qbxsql/`, `qbxsql_compat/`, `qbxsql-<version>.zip`, and `qbxsql-<version>.zip.sha256`. The validator compares source/package/manifest versions, compatibility target, allowlisted contents, built server output, unpacked resources, ZIP CRCs, and SHA-256. A second build must produce the same checksum.

Required evidence before an RC can become stable:

- quality, security, and deterministic artifact workflows;
- MariaDB 10.11/11.4/11.8 and MySQL 8.0/8.4 integration matrix;
- stock Windows and Linux FXServer gates plus enhanced Windows coverage;
- completed real-client Qbox checklist;
- failure/restart evidence;
- one-hour 100-worker soak and same-hardware oxmysql comparison;
- seven-day canary report.

Self-hosted FXServer jobs use license/connection secrets and are triggered only by release tags or explicit dispatch, never untrusted fork pull requests.

## Canary

Before deploying, verify a backup, set schema mode to `plan`, and review every action. Install both release resources, remove real oxmysql, and run the Qbox checklist.

Run one Qbox canary for seven days using the monitor and validator in [CANARY.md](CANARY.md). Monitor state, error/query/slow-query totals, reconnects, queue depth, pool acquisition, process memory, and every schema result. Stop the canary for unexplained data loss, partial transactions, persistent dependency failure, a connection leak, credential exposure, or an unreviewed blocking/destructive plan.

## Rollback

Stop database consumers, `qbxsql_compat`, and qbxsql. Restore real oxmysql, then restart consumers. Retain forward-compatible schema changes. Never run an automatic down-migration; restore the verified backup when reversing an explicitly destructive migration.
