# qbxsql

`qbxsql` is a server-side database adapter for Cfx.re/FiveM. It targets MySQL
and MariaDB first, while keeping the driver boundary open for PostgreSQL.

The resource is being built around three layers:

- a database-driver-neutral query service;
- compatibility adapters for oxmysql, mysql-async, and ghmattimysql;
- declarative, resource-owned schemas with safe reconciliation and versioned
  migrations.

## Development

```sh
bun install
bun run typecheck
bun test
bun run build
```

Built output is written to `dist/index.cjs`, which FXServer loads through
`fxmanifest.lua`.

