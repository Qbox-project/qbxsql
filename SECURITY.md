# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately to the repository maintainer or through the repository's private security-advisory channel. Do not include credentials, production connection strings, player data, or an exploitable proof in a public issue.

Include the affected qbxsql core version, `qbxsql_compat` version, FXServer artifact, database family/version, a minimal reproduction, and the security impact. The maintainer should acknowledge the report, reproduce it on a supported matrix entry, prepare a coordinated fix, and publish remediation guidance before public disclosure.

## Supported versions

The newest prerelease receives security fixes while qbxsql remains `0.x`. After `1.0.0`, the latest stable minor line is supported. The oxmysql compatibility version remains pinned to `2.14.1` until a newer upstream contract has been reviewed and gated.

## Operational security

- Use a least-privilege application account and a separate schema account where practical.
- Never paste connection strings into logs or bug reports.
- Keep `multipleStatements` disabled unless a reviewed resource strictly requires it.
- Restrict destructive/blocking schema authorization to controlled maintenance windows.
- Take and verify a database backup before schema adoption, destructive migrations, or a connector canary.
