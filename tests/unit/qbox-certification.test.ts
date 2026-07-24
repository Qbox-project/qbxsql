import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..', '..');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'qbxsql-qbox-certification-test-'));

beforeAll(() => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, 'run', 'release'],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`Unable to build the certification fixture:\n${result.stderr.toString()}`);
  }
});

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

async function completedCertification() {
  const certification = JSON.parse(
    await readFile(path.join(root, 'docs', 'qbox-certification.template.json'), 'utf8'),
  );
  const checksum = (
    await readFile(path.join(root, 'release', 'qbxsql-0.3.1.zip.sha256'), 'utf8')
  ).split(/\s+/)[0];
  certification.metadata = {
    operator: 'Release operator',
    testedAt: '2026-07-22T22:00:00Z',
    serverArtifact: 'FXServer build 32561',
    clientArtifact: 'FiveM production client 2026-07-22',
    qboxVersion: 'Qbox commit 0123456789abcdef',
    databaseVersion: 'MariaDB 11.4.12',
    qbxsqlVersion: '0.3.1',
    compatibilityTarget: '2.14.1',
    qbxsqlSha256: checksum,
    evidenceBundle: 'evidence/qbox-certification/',
  };
  for (const [name, check] of Object.entries(certification.checks) as Array<
    [string, { passed: boolean; evidence: string[] }]
  >) {
    check.passed = true;
    check.evidence = [`evidence/${name}.txt`];
  }
  return certification;
}

function validate(input: string, output: string) {
  return Bun.spawnSync({
    cmd: [
      process.execPath,
      path.join(root, 'scripts', 'validate-qbox-certification.mjs'),
      '--input',
      input,
      '--output',
      output,
    ],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('Qbox real-client certification gate', () => {
  test('accepts every named check only with exact release identity and evidence', async () => {
    const input = path.join(temporaryRoot, 'complete.json');
    const output = path.join(temporaryRoot, 'summary.json');
    await writeFile(input, `${JSON.stringify(await completedCertification(), null, 2)}\n`);

    const result = validate(input, output);
    expect(result.exitCode).toBe(0);
    const summary = JSON.parse(await readFile(output, 'utf8'));
    expect(summary.passedChecks).toHaveLength(21);
    expect(summary.release.version).toBe('0.3.1');
    expect(summary.release.compatibilityTarget).toBe('2.14.1');
    expect(summary.release.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('rejects unchecked, unreferenced, and wrong-release certifications', async () => {
    const output = path.join(temporaryRoot, 'rejected-summary.json');
    const certification = await completedCertification();
    certification.checks.property_persistence.passed = false;
    const unchecked = path.join(temporaryRoot, 'unchecked.json');
    await writeFile(unchecked, JSON.stringify(certification));
    let result = validate(unchecked, output);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("'property_persistence' has not passed");

    certification.checks.property_persistence.passed = true;
    certification.checks.property_persistence.evidence = [];
    const unreferenced = path.join(temporaryRoot, 'unreferenced.json');
    await writeFile(unreferenced, JSON.stringify(certification));
    result = validate(unreferenced, output);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("'property_persistence' has no evidence");

    certification.checks.property_persistence.evidence = ['evidence/property.txt'];
    certification.metadata.qbxsqlSha256 = '0'.repeat(64);
    const wrongRelease = path.join(temporaryRoot, 'wrong-release.json');
    await writeFile(wrongRelease, JSON.stringify(certification));
    result = validate(wrongRelease, output);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('does not match the built release');
  });

  test('rejects credential-shaped certification evidence', async () => {
    const input = path.join(temporaryRoot, 'secret.json');
    const output = path.join(temporaryRoot, 'secret-summary.json');
    const certification = await completedCertification();
    certification.metadata.evidenceBundle = 'mysql://user:password@database/qbox';
    await writeFile(input, JSON.stringify(certification));

    const result = validate(input, output);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('credentials or a connection string');
  });
});
