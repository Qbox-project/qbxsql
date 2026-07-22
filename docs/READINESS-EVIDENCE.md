# Production-readiness evidence

This file is the release traceability index for the production-readiness program. A local pass proves the implementation and harness on the recorded machine; gates marked external still require archived release evidence before `1.0.0`.

## Implemented surfaces

| Program area | Evidence |
| --- | --- |
| Split core and compatibility resources | Manifest, release-validator, unit, packaged stock/enhanced-FXServer, import-path, provider-resolution, concrete-oxmysql conflict, restart, and live differential gates |
| oxmysql 2.14.1 behavior | Static tagged contract plus exact live differential through packaged `qbxsql_compat`, covering results, errors, prepared batches, raw execution, zero insert IDs, serialization, and failed transactions |
| mysql-async and ghmattimysql | Contract aliases plus packaged FXServer callback/synchronous/import fixtures |
| Lifecycle and health | Unit failure matrix, live active-resource restart, database-restart rehearsal, and one-hour reconnect soak |
| Declarative schemas | Planner/unit coverage plus 26 schema-manager integration cases for modes, drift, ownership, adoption, online refusal, blocking approval, recovery, scoped introspection, and separate credentials |
| Qbox certification evidence | Deliberately incomplete 21-check template plus strict release-identity, evidence-reference, completeness, and credential-safety validation |
| Canary evidence | Optional non-release monitor, sanitized JSONL lifecycle/status capture, continuity and duration validation, ending-pool checks, and bounded justified error deltas |
| Release engineering | Actionlint-clean workflows, deterministic release builder/validator, SHA-256 output, guarded development installer, operations/security/migration/release documentation |

## Local gate record — 2026-07-22

| Gate | Result |
| --- | --- |
| Unit, contract, and local integration suite | Pass; 123 tests and 462 assertions across 19 files |
| Required database matrix | Pass; 35 integration tests each on MariaDB 10.11/11.4/11.8 and MySQL 8.0/8.4 |
| Rolling MariaDB smoke | Pass on MariaDB 12.0.2; informative only |
| Packaged FXServer | Pass on stock Windows build 32561, stock Linux build 25770 in the pinned container gate, and enhanced CFX; coverage includes compatibility metadata/imports/aliases, structured schema callback and await errors, callback transactions, core/shim restart during an active query, and loud/inert refusal when concrete oxmysql is active |
| Exact oxmysql live differential | Pass against local oxmysql 2.14.1 through packaged `qbxsql_compat` |
| Workflow syntax | Pass with actionlint 1.7.12 |
| Dependency audit | Pass at high severity threshold |
| One-hour reconnect soak | Pass; 12,388,297 operations, 100 workers, five MariaDB 11.4.12 restarts, zero unexplained failures, zero transaction violations, no ending leak/queue, full pool saturation, -0.22% final-half memory growth |
| Same-hardware comparison | Pass; qbxsql 28/40 ms median/p95 versus oxmysql 2.14.1 at 27/41 ms |

Local benchmark hardware was Windows 11 Pro 10.0.26100, AMD Ryzen 9 7900X (12 cores/24 threads), and 31.09 GiB RAM. See [BENCHMARKS.md](BENCHMARKS.md) for the detailed figures and gate definitions.

## External gates still required

- Archive green GitHub Actions quality, security, deterministic artifact, and all five database jobs.
- Archive the self-hosted stock Windows/Linux and enhanced release jobs with the release-candidate artifact; all three variants pass locally.
- Complete every item in [QBOX-CERTIFICATION.md](QBOX-CERTIFICATION.md) with a real client. The existing normal-Qbox smoke is useful evidence but is not the full checklist.
- Run the seven-day Qbox canary with the documented monitoring and rollback procedure.
- Link all artifacts, versions, checksums, operators, dates, and canary results from the release candidate before promoting `1.0.0`.
