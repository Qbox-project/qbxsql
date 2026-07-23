# Qbox release certification

This checklist requires a real FiveM client. Record server/client artifacts, Qbox commit/version, database version, qbxsql ZIP checksum, operator, date, and evidence for every item.

Copy [qbox-certification.template.json](qbox-certification.template.json) into the evidence bundle, complete every named check, and validate it against the exact built release:

```sh
bun run release
bun run certification:validate -- \
  --input qbox-certification.json \
  --output qbox-certification-summary.json
```

The validator rejects unchecked or unknown items, missing evidence references, credential-shaped content, and release version/checksum mismatches. A passing JSON file proves checklist completeness and release identity; it does not replace actually performing the client actions below.

## Installation

- [ ] A verified database backup exists and a restore was rehearsed.
- [ ] The real oxmysql resource is absent.
- [ ] `qbxsql` came from the verified release ZIP and exposes both expected version metadata values.
- [ ] No dependency, import, or ox_lib version check fails on server or client.
- [ ] `qbxsql_status` is ready with no queued calls or acquired-connection leak.

## Player persistence

- [ ] Create/load a character, change identity/state, disconnect, and load it again.
- [ ] Add/remove/move inventory items and confirm persistence after reconnect and resource restart.
- [ ] Deposit, withdraw, and transfer money; verify balances and ledger rows after reconnect.
- [ ] Store/retrieve/update a vehicle and verify garage/fuel/damage data.
- [ ] Create/update property ownership, keys, storage, and state.

## Lifecycle and failure

- [ ] Restart representative Qbox resources during idle and active database use.
- [ ] Restart qbxsql and confirm legacy consumers recover without a server restart.
- [ ] Interrupt the database during idle traffic, restore it, and observe disconnected/reconnected events.
- [ ] Interrupt the database during active writes; distinguish expected failed in-flight work and verify no partial transaction.
- [ ] Confirm queue timeout/overflow errors are ordinary compatibility errors and credentials never appear.
- [ ] Perform a scheduled shutdown with drained writes, then start the server and repeat persistence checks.

## Sign-off

- [ ] No unexplained query/transaction failures.
- [ ] No dependency/version/import failures.
- [ ] No leaked connections or sustained queue.
- [ ] Schema plan/migration/adoption results were reviewed and archived.
- [ ] The completed evidence is linked from the release candidate.
