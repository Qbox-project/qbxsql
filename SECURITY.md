# Security policy

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Qbox-project/qbxsql/security/advisories/new)
for anything exploitable. Do not include credentials, production connection
strings, player data, or a working exploit in a public issue.

Include the affected `qbxsql_version`, the FXServer artifact, the database
family and version, a minimal reproduction, and the impact.

## Supported versions

The newest prerelease receives security fixes while qbxsql remains `0.x`.
After `1.0.0`, the latest stable minor line is supported.

## Operational guidance

- Use a least-privilege application account, and a separate schema account
  where practical (`qbxsql_*_schema_connection_string`).
- Never paste connection strings into logs or bug reports; qbxsql redacts
  them from its own output, so a string you see came from somewhere else.
- Keep MySQL `multipleStatements` disabled unless a reviewed resource
  strictly requires it.
- Restrict `qbxsql_schema_allow_blocking` to maintenance windows, and take a
  verified backup before schema adoption or destructive migrations.

## Local test credentials

`bun run cfx-key:save` stores your CFX license key for the local FXServer
gate at `.cache/qbxsql/cfx-license-key` (gitignored, mode `0600` where the OS
supports it). The gate passes the key by environment, redacts it and both
database connection strings from streamed output, and deletes its generated
`server.cfg` after the run. Never commit the key or put it in a command
argument; rotate it if a tool ever prints an unmasked value.
