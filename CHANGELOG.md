# Changelog

All notable changes are recorded here. qbxsql follows semantic versioning after `1.0.0`; `0.x` releases may still change prerelease APIs.

## Unreleased

- Added CFX resource-tick scheduling and reduced prepared-batch, parameter parsing, result serialization, and field-metadata overhead; a same-machine smoke run reached oxmysql 2.14.1 throughput and latency parity.
- The required local MariaDB 10.11/11.4/11.8 and MySQL 8.0/8.4 integration runs pass.
- A local one-hour, 100-worker reconnect soak and ten-minute same-hardware oxmysql 2.14.1 comparison pass every reliability, transaction, pool, memory, median, and p95 gate.
- Stock Linux FXServer build 25770 passes the pinned containerized release gate, including restart and connector-conflict coverage.
- Added sanitized runtime evidence archives and a monitor/validator for continuous seven-day canary evidence.
- Hosted release workflow evidence, completed real-client Qbox certification, and the seven-day canary are still required before `1.0.0`.

## 0.3.0 - 2026-07-22

- Added safe `auto`, no-DDL `plan`, and disabled `off` schema modes.
- Enforced online DDL algorithms without blocking fallback.
- Added structured constraints/table options, ownership release, drift detection, scoped introspection, separate schema credentials, and resumable adoption.
- Added deterministic releases, verified development installation, database/FXServer CI definitions, and benchmark/soak gates.

## 0.2.0 - 2026-07-22

- Split legacy aliases into the client-visible `qbxsql_compat` resource targeting oxmysql 2.14.1.
- Added oxmysql/mysql-async/ghmattimysql callback, promise, transaction, stored-query, and Lua wrapper compatibility.
- Added resilient connection states, bounded outage queues, retry/backoff, health checks, reconnect events, status reporting, and callback-transaction timeouts.
