import path from 'node:path';

import {
  localCfxKeyPath,
  promptCfxKey,
  saveLocalCfxKey,
} from './local-cfx-key.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const key = await promptCfxKey();
await saveLocalCfxKey(repositoryRoot, key);
console.log(
  `[qbxsql] saved the local CFX key to ${path.relative(
    repositoryRoot,
    localCfxKeyPath(repositoryRoot),
  )} (gitignored).`,
);
