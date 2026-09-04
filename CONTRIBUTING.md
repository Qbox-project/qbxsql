# Contributing

Thanks for helping out. The short version:

1. Read [docs/development.md](docs/development.md) for the repo layout, test
   tiers, and local database setup.
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
   in the development doc are all it needs. CI runs it either way.
4. Keep changes focused, and describe *why* in the commit message.
   Bug fixes should come with a test that fails without them.

Behavioral ground rules worth knowing before you propose a change:

- The oxmysql compatibility surface is pinned to 2.14.1; deviations are
  documented and deliberate. Don't change contract behavior casually.
- The schema manager never trades safety for convenience: no silent blocking
  DDL, no destructive reconciliation, no unjournaled migrations.
- Nothing may ever log credentials, connection strings, or query parameter
  values.
