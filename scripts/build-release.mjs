import { buildRelease, validateBuiltRelease } from './release-lib.mjs';

const built = await buildRelease();
const validated = await validateBuiltRelease();
if (built.sha256 !== validated.sha256) throw new Error('Post-build checksum validation failed.');
if (built.oxmysqlSha256 !== validated.oxmysqlSha256) {
  throw new Error('Exact-identity post-build checksum validation failed.');
}

console.log(
  `[qbxsql] built ${validated.zipName} (SHA-256 ${validated.sha256}) and ${validated.oxmysqlZipName} (SHA-256 ${validated.oxmysqlSha256}); ${validated.entries.length} files each`,
);
