import { validateBuiltRelease } from './release-lib.mjs';

const release = await validateBuiltRelease();
console.log(
  `[qbxsql] validated ${release.zipName} (${release.entries.length} files, SHA-256 ${release.sha256})`,
);
