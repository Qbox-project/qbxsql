# Compatibility matrix

## Query API target

The compatibility contract is pinned to [oxmysql 2.14.1](https://github.com/overextended/oxmysql/releases/tag/v2.14.1).

| Surface | Target | Gate |
| --- | --- | --- |
| oxmysql callbacks and promises | 2.14.1 result/error semantics | Static fixtures plus a live stock-FXServer differential probe through the packaged `qbxsql_compat` provider |
| `MySQL.*`, `.await`, `Async`, `Sync` | 2.14.1 Lua wrapper | Static fixture and stock FXServer |
| mysql-async aliases/import | oxmysql 2.14.1 mappings | Dedicated FXServer import fixture |
| ghmattimysql aliases | oxmysql 2.14.1 mappings | Contract and FXServer fixture |
| NUI profiling/UI commands | Excluded | Not shipped |
| External logger plugins | Excluded | Not shipped |

## Database release target

Required stable-release gates are MariaDB 10.11, 11.4, and 11.8 plus MySQL 8.0 and 8.4. The rolling MariaDB job is informative and non-blocking. A matrix definition or local run is not final release evidence: release notes must link the completed workflow before `1.0.0`.

Local development on 2026-07-22 passed the complete 35-test integration suite against each required line: MariaDB 10.11, 11.4, and 11.8 plus MySQL 8.0 and 8.4. MariaDB 12.0.2 also passed locally as rolling-release smoke coverage, but is not a guaranteed support line.

## FXServer target

- Minimum stock artifact: server build `12913`, matching the oxmysql 2.14.1 dependency floor.
- Release certification artifact: the explicitly recorded current Windows/Linux artifact in the release evidence.
- Local stock Windows evidence: build `32561` passed the packaged compatibility/runtime gate on 2026-07-22.
- The same build passed core/shim stop-and-restart recovery while a query was active.
- Linux evidence is required from the self-hosted release workflow.
- Enhanced CFX on Windows is covered separately because it is not a stock artifact.

The tested enhanced scanner rejects not-yet-started virtual providers during its initial parallel resource scan. The enhanced gate therefore starts `qbxsql_compat`, refreshes, and then starts compatibility consumers. Stock FXServer does not require this staging. Treat a future enhanced build as uncertified until its gate passes.

## Qbox

Qbox is accepted only through the real-client checklist in [QBOX-CERTIFICATION.md]. Unit tests and a headless FXServer pass do not replace character, inventory, banking, vehicle, property, restart, outage, and shutdown persistence checks.
