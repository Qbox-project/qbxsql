# Release and rollout policy

## Version progression

1. `0.2.x`: compatibility shim, failure semantics, configuration, and reconnect lifecycle.
2. `0.3.x`: schema safety, adoption, online DDL, and separate credentials.
3. `1.0.0-rc.x`: lean CI, stock-Linux FXServer, Qbox, and release-artifact validation.
4. `1.0.0`: only after those practical gates are green on the release candidate.

Never change the oxmysql compatibility target from `2.14.1` merely to satisfy a dependency check. Change it only after verifying a newer upstream contract.

The single resource's public manifest `version` is the greater of `qbxsql_version` and the verified oxmysql compatibility target. Until qbxsql surpasses `2.14.1`, dependency checks therefore see `2.14.1`; release artifacts and native tooling continue to use `qbxsql_version`.

## Release construction

Run:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run release
bun run release:validate
```

The output contains `qbxsql/`, `qbxsql-<qbxsql_version>.zip`, and `qbxsql-<qbxsql_version>.zip.sha256`. The validator compares the package and `qbxsql_version`, the compatibility-facing manifest `version`, provider declarations, allowlisted contents, built server output, unpacked resource, ZIP CRCs, and SHA-256. A second build must produce the same checksum.

Required evidence before an RC can become stable:

- green `CI`, including MariaDB 11.4 integration coverage;
- a local stock-Linux FXServer smoke test for the exact candidate;
- `bun run release:validate` for the generated artifact;
- focused MySQL or additional MariaDB checks when database-specific code changed;
- relevant real-client Qbox checks for compatibility-affecting changes.

Run `bun run cfx-key:save` once, then `bun run test:fxserver` locally. The saved key lives only in the gitignored `.cache/qbxsql/cfx-license-key`; `CFX_LICENSE_KEY` can override it for one process. The test verifies a pinned cached artifact, creates a disposable MariaDB service and Docker network, and cleans up after the packaged gate. The key is never a command argument or repository secret.

The broader database matrix, benchmarks, reconnect soak, Windows checks, and seven-day canary remain available as targeted local assurance. Run them when a risky connector, lifecycle, schema, or performance change justifies their cost; they are not routine CI requirements. Enhanced CFX coverage is deferred until that runtime leaves early access.

## Canary

Before deploying, verify a backup, set schema mode to `plan`, and review every action. Install the release resource, remove real oxmysql, and run the Qbox checklist.

Run one Qbox canary for seven days using the monitor and validator in [CANARY.md](CANARY.md). Monitor state, error/query/slow-query totals, reconnects, queue depth, pool acquisition, process memory, and every schema result. Stop the canary for unexplained data loss, partial transactions, persistent dependency failure, a connection leak, credential exposure, or an unreviewed blocking/destructive plan.

## Rollback

Stop database consumers and qbxsql. Restore real oxmysql, then restart consumers. Retain forward-compatible schema changes. Never run an automatic down-migration; restore the verified backup when reversing an explicitly destructive migration.
