import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..', '..');

describe('containerized Linux FXServer gate', () => {
  test('pins its runtime inputs and keeps credentials out of command arguments', async () => {
    const [script, packageJson] = await Promise.all([
      readFile(path.join(root, 'scripts', 'run-containerized-linux-gate.mjs'), 'utf8'),
      readFile(path.join(root, 'package.json'), 'utf8'),
    ]);

    expect(script).toContain('25770-8ddccd4e4dfd6a760ce18651656463f961cc4761');
    expect(script).toContain('node:22-bookworm-slim@sha256:');
    expect(script).toContain('host.docker.internal:host-gateway');
    expect(script).toContain("'--env',\n    'CFX_LICENSE_KEY'");
    expect(script).toContain("'--env',\n    'QBXSQL_TEST_CONNECTION_STRING'");
    expect(script).not.toContain('--license-key');
    expect(JSON.parse(packageJson).scripts['gate:linux']).toBe(
      'bun run release && node scripts/run-containerized-linux-gate.mjs',
    );
  });
});
