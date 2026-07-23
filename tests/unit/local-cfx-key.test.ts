import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  localCfxKeyPath,
  readLocalCfxKey,
  saveLocalCfxKey,
} from '../../scripts/local-cfx-key.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qbxsql-cfx-key-'));
  temporaryRoots.push(root);
  return root;
}

describe('local CFX key storage', () => {
  test('returns undefined when no local key exists', async () => {
    expect(await readLocalCfxKey(await temporaryRoot())).toBeUndefined();
  });

  test('saves and reads a valid key from the private cache path', async () => {
    const root = await temporaryRoot();
    const key = 'cfxk_example_local_test_key_1234';

    expect(await saveLocalCfxKey(root, key)).toBe(localCfxKeyPath(root));
    expect(await readLocalCfxKey(root)).toBe(key);
    expect(await readFile(localCfxKeyPath(root), 'utf8')).toBe(`${key}\n`);
  });

  test('rejects malformed values without creating a key file', async () => {
    const root = await temporaryRoot();

    await expect(saveLocalCfxKey(root, 'not-a-cfx-key')).rejects.toThrow(
      'invalid format',
    );
    expect(await readLocalCfxKey(root)).toBeUndefined();
  });
});
