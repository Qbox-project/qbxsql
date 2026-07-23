# Seven-day canary evidence

The canary is an operated Qbox deployment, not a synthetic test. The optional monitor under `tools/qbxsql_canary` records sanitized `getStatus()` snapshots, lifecycle events, and operator checkpoints without adding a third resource to the release ZIP.

## Start

1. Complete and archive the backup rehearsal and schema-plan review.
2. Install the verified `qbxsql` release resource.
3. Copy `tools/qbxsql_canary` into the canary server's resources directory.
4. Add the monitor after the release resources:

   ```cfg
   set qbxsql_canary_interval 600000
   ensure qbxsql
   ensure qbxsql_canary
   ```

The interval is clamped to at least one minute. The release gate assumes the default ten-minute interval and rejects gaps longer than fifteen minutes. Archive an old `canary.jsonl` before beginning a new run; never combine evidence from different release candidates.

## Operate

Use the server console to record concise milestones:

```text
qbxsql_canary_checkpoint backup and schema plan reviewed
qbxsql_canary_checkpoint character inventory banking vehicle and property persistence passed
qbxsql_canary_checkpoint planned database outage recovered
qbxsql_canary_checkpoint scheduled shutdown and startup persistence passed
```

Continue the real-client checklist in [QBOX-CERTIFICATION.md](QBOX-CERTIFICATION.md). The monitor does not certify gameplay behavior. Investigate every increase in error totals and preserve the incident, expected-failure classification, and database/server logs.

At the end of at least seven continuous days, with the database ready and no acquired or queued connections, run:

```text
qbxsql_canary_finish
```

Stop the canary for unexplained data loss, partial transactions, persistent dependency failure, connection leakage, credential exposure, or an unreviewed blocking/destructive schema plan.

## Validate and archive

Copy `canary.jsonl` out of the monitor resource and validate it from the matching source checkout:

```sh
bun run canary:validate -- --input canary.jsonl --output canary-summary.json
```

By default the validator requires:

- at least seven days between the first start and final explicit finish;
- samples covering the entire interval with no gap over fifteen minutes;
- one unchanged qbxsql version and compatibility target;
- a final `ready` state with no acquired connections or queued work;
- zero unexplained error growth;
- no credential-shaped content.

Expected errors may be admitted only with a bounded count and an archived justification:

```sh
bun run canary:validate -- \
  --input canary.jsonl \
  --output canary-summary.json \
  --allow-error-delta 2 \
  --error-justification "Two expected in-flight failures during reviewed outage rehearsal"
```

Archive the raw JSONL, validated summary, runtime evidence JSON, release ZIP/checksum, completed Qbox checklist, incident references, and relevant sanitized logs together. Link that immutable evidence bundle from the release candidate before promotion.
