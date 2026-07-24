import { buildRelease, validateBuiltRelease } from './release-lib.mjs';

const built = await buildRelease();
const validated = await validateBuiltRelease();
if (built.sha256 !== validated.sha256) throw new Error('Post-build checksum validation failed.');

console.log(
  `[qbxsql] built ${validated.zipName} (${validated.entries.length} files, SHA-256 ${validated.sha256})`,
);
