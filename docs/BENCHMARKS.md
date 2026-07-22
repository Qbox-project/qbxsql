# Benchmark and soak gates

## Workload

`tests/load/qbxsql_benchmark` runs a deterministic mixed workload containing scalar reads, row reads, mutations, four-item prepared batches, and two-statement transactions. Defaults are 100 concurrent workers, a fixed seed, a 10-connection pool, and one hour. A dedicated transaction balance must remain zero across database restarts, proving interrupted transactions did not leave a partial first statement.

Run qbxsql and oxmysql 2.14.1 separately on the same idle machine, FXServer artifact, database, worker count, seed, and duration:

```sh
node scripts/run-benchmark.mjs --binary /path/to/FXServer --provider qbxsql --duration 3600000 --workers 100 --output qbxsql.json
node scripts/run-benchmark.mjs --binary /path/to/FXServer --provider oxmysql --oxmysql-path /path/to/oxmysql --duration 3600000 --workers 100 --output oxmysql.json
node scripts/compare-benchmarks.mjs --qbxsql qbxsql.json --oxmysql oxmysql.json
```

The release workflow records CPU, memory, OS, and kernel before testing. Do not compare results from different hardware or active workloads. Short smoke runs validate the harness only and are not performance evidence.

The benchmark runner disables connector slow-query console logging for both candidates. It uses qbxsql's native zero-disable setting and a very high legacy threshold for oxmysql 2.14.1, where zero means log every query. Slow-query detection is covered by the connector tests and production health counters; synchronous warning output would feed back into latency and make the fixed-workload comparison depend on terminal throughput.

On 2026-07-22, a local stock-Windows smoke comparison using 100 workers for 30 seconds produced 112,935 qbxsql operations at 24 ms median / 45 ms p95 and 112,610 oxmysql 2.14.1 operations at 24 ms median / 44 ms p95. This validates the workload and CFX scheduling path; its duration is too short for the memory or release-candidate gate. A separate live database-restart smoke completed 35,270 operations with zero unexplained failures, one observed reconnect, and no ending connection leak.

## Required gates

- zero unexplained query/transaction failures;
- zero transaction-invariant violations after reconnects;
- observed saturation of all 10 pool connections;
- zero acquired or queued connections at completion;
- less than 10% V8-heap and process-RSS growth during the final half, calculated from averaged early and late windows rather than GC-sensitive single snapshots;
- median and p95 qbxsql latency no more than 120% of oxmysql on the same workload;
- at least one observed reconnect in the reconnect soak.

The RC workflow restarts an isolated MariaDB container every ten minutes during the one-hour qbxsql soak. Failures observed while `qbxsql:disconnected` is active are recorded separately as expected reconnect failures; every other failure fails the gate. Separate steady qbxsql/oxmysql runs enforce latency comparability.
