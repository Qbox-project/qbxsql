import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..', '..');

describe('containerized Linux FXServer gate', () => {
  test('provides a self-contained, cached local test without credential arguments', async () => {
    const [script, localRunner, keyStore, fxserverGate, packageJson, gitignore] = await Promise.all([
      readFile(path.join(root, 'scripts', 'run-containerized-linux-gate.mjs'), 'utf8'),
      readFile(path.join(root, 'scripts', 'run-local-linux-gate.mjs'), 'utf8'),
      readFile(path.join(root, 'scripts', 'local-cfx-key.mjs'), 'utf8'),
      readFile(path.join(root, 'scripts', 'run-fxserver-gate.mjs'), 'utf8'),
      readFile(path.join(root, 'package.json'), 'utf8'),
      readFile(path.join(root, '.gitignore'), 'utf8'),
    ]);

    expect(script).toContain('25770-8ddccd4e4dfd6a760ce18651656463f961cc4761');
    expect(script).toContain('node:22-bookworm-slim@sha256:');
    expect(script).toContain('host.docker.internal:host-gateway');
    expect(script).toContain("'--artifact-path'");
    expect(script).toContain("'--docker-network'");
    expect(script).toContain("'--env',\n  'CFX_LICENSE_KEY'");
    expect(script).toContain("'--env',\n  'QBXSQL_TEST_CONNECTION_STRING'");
    expect(script).toContain("'--env',\n  'QBXSQL_TEST_POSTGRES_CONNECTION_STRING'");
    expect(script).not.toContain('--license-key');
    // The URL path must verify the download rather than piping curl into tar.
    expect(script).toContain('sha256sum --check --strict --status');
    expect(script).not.toContain('| tar -xJ -C /fxserver');
    expect(script).toContain(
      '4d55acd1306651aecf8457699485c736d08aae37b075c493a66dacd623402631',
    );
    expect(script).toContain("'--env',\n  'CFX_LINUX_ARTIFACT_SHA256'");
    expect(localRunner).toContain(
      '4d55acd1306651aecf8457699485c736d08aae37b075c493a66dacd623402631',
    );
    expect(localRunner).toContain("'.cache',\n    'fxserver'");
    expect(localRunner).toContain("const DATABASE_IMAGE = 'mariadb:11.4';");
    expect(localRunner).toContain(
      "const POSTGRES_IMAGE = 'pgvector/pgvector:0.8.5-pg16-bookworm';",
    );
    expect(localRunner).toContain("'CREATE EXTENSION IF NOT EXISTS vector'");
    expect(localRunner).toContain("'POSTGRES_PASSWORD=root'");
    expect(localRunner).toContain("'network', 'create'");
    expect(localRunner).toContain('await readLocalCfxKey(repositoryRoot)');
    expect(localRunner).toContain('await promptCfxKey()');
    expect(localRunner).toContain("delete process.env.CFX_LICENSE_KEY");
    expect(localRunner).not.toContain('--license-key');
    expect(keyStore).toContain("'cfx-license-key'");
    expect(keyStore).toContain('CFX license key (hidden):');
    expect(keyStore).toContain('mode: 0o600');
    expect(fxserverGate).toContain('const licenseKey = process.env.CFX_LICENSE_KEY;');
    expect(fxserverGate).toContain('process.env.QBXSQL_TEST_POSTGRES_CONNECTION_STRING');
    expect(fxserverGate).toContain('createSecretSafeWriter');
    expect(fxserverGate).not.toContain("option('--license-key'");
    expect(JSON.parse(packageJson).scripts['test:fxserver']).toBe(
      'node scripts/run-local-linux-gate.mjs',
    );
    expect(JSON.parse(packageJson).scripts['cfx-key:save']).toBe(
      'node scripts/save-local-cfx-key.mjs',
    );
    expect(gitignore).toContain('.cache/');
  });
});
