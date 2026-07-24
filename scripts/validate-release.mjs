import { validateBuiltRelease } from './release-lib.mjs';

const release = await validateBuiltRelease();
console.log(
  `[qbxsql] validated ${release.zipName} (SHA-256 ${release.sha256}) and ${release.oxmysqlZipName} (SHA-256 ${release.oxmysqlSha256}); ${release.entries.length} files each`,
);
