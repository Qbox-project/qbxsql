# Contributing

Thanks for helping out. The short version:

Follow the [Qbox contribution guidelines](https://github.com/Qbox-project/.github/blob/main/.github/contributing.md),
including Conventional Commits. The instructions below cover qbxsql's setup,
database tests, and release process.

1. Use the setup and test instructions below. Run commands from the repository
   root with Node.js 22 and Bun 1.3.5 installed.
2. Before opening a PR, make sure these pass:

   ```sh
   bun run typecheck
   bun run test:unit
   bun run test:contract
   bun run build
   ```

   `dist/` is committed and CI fails if it doesn't match a fresh build, so
   commit the rebuilt bundle with your change.
3. Run `bun run test:integration` when you touch anything that talks to a
   database (drivers, parameters, schema managers) — the two Docker commands
   below are all it needs. CI runs it either way.
4. Keep changes focused, and describe *why* in the commit message.
   Bug fixes should come with a test that fails without them.

Behavioral ground rules worth knowing before you propose a change:

- The oxmysql compatibility surface is pinned to 2.14.1; deviations are
  documented and deliberate. Don't change contract behavior casually.
- The schema manager never trades safety for convenience: no silent blocking
  DDL, no destructive reconciliation, no unjournaled migrations.
- Nothing may ever log credentials or connection strings. Query text and
  bound values appear only where oxmysql prints them too — query errors and
  debug mode — and never in status output.

## Layout

```
src/
  index.ts            entry point: config, lane wiring, exports, console commands
  config.ts           convar parsing and validation
  core/               connection pools, lifecycle, queueing, parameter/result handling
  drivers/            mysql2 and pg drivers
  api/                CFX-facing exports: oxmysql compat, Postgres facade, schema APIs
  schema/             MySQL/MariaDB schema manager (planner, introspection, SQL, journal)
  postgres-schema/    PostgreSQL schema manager
lib/                  Lua facades resources import (@qbxsql/lib/MySQL|Postgres|Schema.lua)
dist/                 built server bundle, committed and verified by CI
tests/
  unit/               no database required
  contract/           oxmysql 2.14.1 behavior fixtures
  integration/        run against live MariaDB and PostgreSQL
  fxserver/           resources used by the packaged FXServer gate
  load/               benchmark workload resource
scripts/              build, release, gate, and benchmark tooling
examples/             copy-paste schema declarations
```

## Everyday commands

```sh
bun install
bun run typecheck
bun run test:unit
bun run test:contract
bun run build          # rebuild dist/ — commit the result, CI verifies it
```

`dist/` is tracked so that cloning the repository yields a working resource;
CI fails if the committed bundle doesn't match a fresh build.

## Integration tests

`bun run test:integration` needs a MariaDB and a PostgreSQL to point at:

```sh
docker run -d --name qbxsql-mariadb -e MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1 -p 13306:3306 mariadb:11.4
docker run -d --name qbxsql-postgres -e POSTGRES_PASSWORD=root -p 15432:5432 pgvector/pgvector:0.8.5-pg16-bookworm
```

```sh
QBXSQL_TEST_ADMIN_URL=mysql://root@127.0.0.1:13306 \
QBXSQL_TEST_POSTGRES_ADMIN_URL=postgresql://postgres:root@127.0.0.1:15432/postgres \
bun run test:integration
```

The suite creates and drops its own scratch databases. CI runs it on every
push with the same images.

## FXServer gate

With Docker available, the packaged resource can be tested on the pinned
official stock-Linux FXServer artifact:

```sh
bun run cfx-key:save     # once; prompts for a CFX license key, stored gitignored
bun run test:fxserver
```

This rebuilds the release, downloads and verifies the server artifact once
(cached under `.cache/`), starts disposable MariaDB and PostgreSQL
containers, boots a real FXServer with the packaged resource plus the
fixtures in `tests/fxserver/` (runtime behavior, resource restart, oxmysql
conflict handling, mysql-async imports), and cleans everything up. The key is
kept out of process arguments and logs; see [SECURITY.md](SECURITY.md).

FXServer execution stays local because it needs each contributor's own CFX
key — CI covers everything else.

## Benchmarks

`tests/load/qbxsql_benchmark` is a deterministic mixed workload (reads,
mutations, prepared batches, two-statement transactions) for comparing qbxsql
against oxmysql 2.14.1 on the same machine, artifact, database, seed, and
duration:

```sh
node scripts/run-benchmark.mjs --binary /path/to/FXServer --provider qbxsql --duration 3600000 --workers 100 --output qbxsql.json
node scripts/run-benchmark.mjs --binary /path/to/FXServer --provider oxmysql --oxmysql-path /path/to/oxmysql --duration 3600000 --workers 100 --output oxmysql.json
node scripts/compare-benchmarks.mjs --qbxsql qbxsql.json --oxmysql oxmysql.json
```

A run passes when there are zero unexplained failures, zero
transaction-invariant violations after forced reconnects, no leaked
connections at the end, less than 10% memory growth in the final half, and
median/p95 latency within 120% of oxmysql on the same workload. A dedicated
transaction balance must stay zero across database restarts, proving
interrupted transactions never left a partial first statement.

Short runs only validate the harness — don't quote them as performance
numbers, and don't compare results from different hardware.

`scripts/run-contract-probe.mjs` and `compare-contract-probes.mjs` run the
same live differential probe against real oxmysql for compatibility work.

## Releases

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test:unit
bun run test:contract
# Run the integration suite with the database environment variables above.
bun run test:integration
bun run release
bun run release:validate
```

`release/` gets `qbxsql/`, `qbxsql-<version>.zip`, and a SHA-256 checksum.
The validator checks manifest versions, provider declarations, exact packaged
contents, bundled licenses, and local documentation links. It also compares
the archive against an independently regenerated deterministic ZIP.
Development servers can consume the verified artifact through a
guarded junction:

```sh
bun run install:dev -- --resources /path/to/server/resources
```

Versioning: the public manifest `version` is the greater of `qbxsql_version`
and the oxmysql compatibility target, so dependency checks in other resources
see `2.14.1` until qbxsql's own version surpasses it. Never bump the
compatibility target just to satisfy a check — only after the newer upstream
contract has actually been reviewed and tested.

### Preparing a GitHub release

qbxsql uses Qbox's Lua lint action alongside its TypeScript, database, and
package checks. The lint step runs inside CI with a read-only token so fork
pull requests work without the shared workflow's check-report permissions.

The release workflow is specific to qbxsql. The organization's shared
[version workflow](https://github.com/Qbox-project/.github/blob/main/.github/workflows/release.yml)
updates the public manifest version, which qbxsql reserves for compatibility.
Its shared [archive workflow](https://github.com/Qbox-project/.github/blob/main/.github/workflows/release-action.yml)
packages the repository from the default branch. qbxsql instead builds and
validates its explicit runtime file list from the tag, preserving both version
fields and leaving development files out of the download.

1. Update `package.json` and `qbxsql_version` in `fxmanifest.lua`, move the
   changelog's unreleased entries into the dated version, and rebuild `dist/`.
2. Run the checks above and the local FXServer gate. Commit the source and
   generated bundle together, then push a matching `v<version>` tag.
3. The release workflow runs CI and prepares a **draft prerelease** with the
   installable ZIP and SHA-256 file. Review its notes and assets on GitHub,
   then publish it when ready. A tag/version mismatch fails the workflow.

The ZIP contains runtime files, user guides, examples, and license notices.
Contributor instructions, test harnesses, source files, dependency manifests,
and local audit notes stay out of it. Add public files explicitly to the
allowlist in `scripts/release-lib.mjs` when needed.
