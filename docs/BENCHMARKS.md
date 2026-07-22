# Benchmark and soak gates

## Workload

`tests/load/qbxsql_benchmark` runs a deterministic mixed workload containing scalar reads, row reads, mutations, four-item prepared batches, and two-statement transactions. Defaults are 100 concurrent workers, a fixed seed, a 10-connection pool, and one hour.

Run qbxsql and oxmysql 2.14.1 separately on the same idle machine, FXServer artifact, database, worker count, seed, and duration:

```sh
node scripts/run-benchmark.mjs --binary /path/to/FXServer --provider qbxsql --duration 3600000 --workers 100 --output qbxsql.json
node scripts/run-benchmark.mjs --binary /path/to/FXServer --provider oxmysql --oxmysql-path /path/to/oxmysql --duration 3600000 --workers 100 --output oxmysql.json
node scripts/compare-benchmarks.mjs --qbxsql qbxsql.json --oxmysql oxmysql.json
```

The release workflow records CPU, memory, OS, and kernel before testing. Do not compare results from different hardware or active workloads. Short smoke runs validate the harness only and are not performance evidence.

## Required gates

- zero unexplained query/transaction failures;
- zero acquired or queued connections at completion;
- less than 10% heap growth during the final half;
- median and p95 qbxsql latency no more than 120% of oxmysql on the same workload;
- at least one observed reconnect in the reconnect soak.

The RC workflow restarts an isolated MariaDB container every ten minutes during the one-hour qbxsql soak. Failures observed while `qbxsql:disconnected` is active are recorded separately as expected reconnect failures; every other failure fails the gate. Separate steady qbxsql/oxmysql runs enforce latency comparability.
