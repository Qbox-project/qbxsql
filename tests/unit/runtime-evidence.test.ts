import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..', '..');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'qbxsql-evidence-test-'));

beforeAll(() => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, 'run', 'release'],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`Unable to build the evidence fixture:\n${result.stderr.toString()}`);
  }
});

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('runtime release evidence', () => {
  test('records only sanitized machine, artifact, and release metadata', async () => {
    const output = path.join(temporaryRoot, 'runtime.json');
    const processResult = Bun.spawnSync({
      cmd: [
        process.execPath,
        path.join(root, 'scripts', 'write-runtime-evidence.mjs'),
        '--binary',
        process.execPath,
        '--flavor',
        'stock',
        '--output',
        output,
      ],
      cwd: root,
      env: {
        ...process.env,
        GITHUB_SHA: '0123456789abcdef',
        QBXSQL_TEST_CONNECTION_STRING: 'mysql://secret-user:secret-password@database/private',
        CFX_LICENSE_KEY: 'secret-license',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(processResult.exitCode).toBe(0);
    const raw = await readFile(output, 'utf8');
    const evidence = JSON.parse(raw);
    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.runtime.flavor).toBe('stock');
    expect(evidence.fxserver.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.qbxsql.version).toBe('0.4.0');
    expect(evidence.qbxsql.compatibilityTarget).toBe('2.14.1');
    expect(evidence.ci.commit).toBe('0123456789abcdef');
    expect(raw).not.toContain('secret-user');
    expect(raw).not.toContain('secret-password');
    expect(raw).not.toContain('secret-license');
    expect(raw).not.toContain(path.dirname(process.execPath));
  });
});
