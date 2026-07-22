import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..', '..');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'qbxsql-canary-test-'));

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

function status(overrides: Record<string, unknown> = {}) {
  return {
    state: 'ready',
    databaseFamily: 'MariaDB',
    databaseVersion: '11.4.12-MariaDB',
    databaseName: 'qbox',
    pool: { total: 10, free: 10, acquired: 0, queued: 0 },
    queuedCalls: 0,
    memory: { rss: 100_000, heapUsed: 50_000, external: 1_000 },
    totals: { queries: 0, errors: 0, slowQueries: 0, reconnects: 0 },
    ...overrides,
  };
}

function runValidator(input: string, output: string, extra: string[] = []) {
  return Bun.spawnSync({
    cmd: [
      process.execPath,
      path.join(root, 'scripts', 'validate-canary.mjs'),
      '--input',
      input,
      '--output',
      output,
      '--minimum-duration',
      '20000',
      '--maximum-gap',
      '15000',
      ...extra,
    ],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('canary evidence gate', () => {
  test('ships an optional monitor outside the two release resources', async () => {
    const [manifest, server] = await Promise.all([
      readFile(path.join(root, 'tools', 'qbxsql_canary', 'fxmanifest.lua'), 'utf8'),
      readFile(path.join(root, 'tools', 'qbxsql_canary', 'server.lua'), 'utf8'),
    ]);

    expect(manifest).toContain("dependency 'qbxsql'");
    expect(server).toContain('exports.qbxsql:getStatus()');
    expect(server).toContain("{ 'ready', 'disconnected', 'reconnected' }");
    expect(server).toContain("('qbxsql:%s'):format(event)");
    expect(server).toContain("RegisterCommand('qbxsql_canary_checkpoint'");
    expect(server).toContain("RegisterCommand('qbxsql_canary_finish'");
    expect(server).not.toContain('mysql_connection_string');
  });

  test('summarizes continuous healthy evidence without leaking raw input details', async () => {
    const input = path.join(temporaryRoot, 'valid.jsonl');
    const output = path.join(temporaryRoot, 'summary.json');
    const records = [
      {
        type: 'start',
        recordedAt: '2026-01-01T00:00:00Z',
        qbxsqlVersion: '1.0.0-rc.1',
        compatibilityTarget: '2.14.1',
      },
      {
        type: 'sample',
        recordedAt: '2026-01-01T00:00:01Z',
        status: status({
          totals: { queries: 100, errors: 0, slowQueries: 0, reconnects: 0 },
        }),
      },
      {
        type: 'checkpoint',
        recordedAt: '2026-01-01T00:00:08Z',
        label: 'database outage recovered',
      },
      {
        type: 'sample',
        recordedAt: '2026-01-01T00:00:11Z',
        status: status({
          memory: { rss: 104_000, heapUsed: 52_000, external: 1_000 },
          totals: { queries: 25, errors: 0, slowQueries: 1, reconnects: 1 },
        }),
      },
      { type: 'finish', recordedAt: '2026-01-01T00:00:20Z', status: status() },
    ];
    await writeFile(input, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

    const result = runValidator(input, output);
    expect(result.exitCode).toBe(0);
    const summary = JSON.parse(await readFile(output, 'utf8'));
    expect(summary.durationMs).toBe(20_000);
    expect(summary.samples).toBe(2);
    expect(summary.deltas.queries).toBe(25);
    expect(summary.deltas.reconnects).toBe(1);
    expect(summary.checkpoints).toEqual(['database outage recovered']);
    expect(summary.endingStatus.pool.acquired).toBe(0);
  });

  test('rejects ending connection leaks', async () => {
    const leakingInput = path.join(temporaryRoot, 'leaking.jsonl');
    const output = path.join(temporaryRoot, 'rejected.json');
    const records = [
      {
        type: 'start',
        recordedAt: '2026-01-01T00:00:00Z',
        qbxsqlVersion: '1.0.0-rc.1',
        compatibilityTarget: '2.14.1',
      },
      { type: 'sample', recordedAt: '2026-01-01T00:00:01Z', status: status() },
      {
        type: 'sample',
        recordedAt: '2026-01-01T00:00:11Z',
        status: status({ totals: { queries: 1, errors: 1, slowQueries: 0, reconnects: 0 } }),
      },
      {
        type: 'finish',
        recordedAt: '2026-01-01T00:00:20Z',
        status: status({ pool: { total: 10, free: 9, acquired: 1, queued: 0 } }),
      },
    ];
    await writeFile(leakingInput, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

    const result = runValidator(leakingInput, output);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('did not finish ready with an empty acquisition');
  });

  test('requires a bounded and justified error delta', async () => {
    const input = path.join(temporaryRoot, 'errors.jsonl');
    const output = path.join(temporaryRoot, 'errors-summary.json');
    const records = [
      {
        type: 'start',
        recordedAt: '2026-01-01T00:00:00Z',
        qbxsqlVersion: '1.0.0-rc.1',
        compatibilityTarget: '2.14.1',
      },
      { type: 'sample', recordedAt: '2026-01-01T00:00:01Z', status: status() },
      {
        type: 'sample',
        recordedAt: '2026-01-01T00:00:11Z',
        status: status({ totals: { queries: 1, errors: 1, slowQueries: 0, reconnects: 0 } }),
      },
      { type: 'finish', recordedAt: '2026-01-01T00:00:20Z', status: status() },
    ];
    await writeFile(input, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

    const rejected = runValidator(input, output);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr.toString()).toContain('error delta 1 exceeds the allowed 0');

    const accepted = runValidator(input, output, [
      '--allow-error-delta',
      '1',
      '--error-justification',
      'Expected outage write failure was reviewed',
    ]);
    expect(accepted.exitCode).toBe(0);
    const summary = JSON.parse(await readFile(output, 'utf8'));
    expect(summary.errorJustification).toContain('Expected outage write failure');
  });

  test('rejects evidence that does not cover the full canary interval', async () => {
    const input = path.join(temporaryRoot, 'coverage-gap.jsonl');
    const output = path.join(temporaryRoot, 'coverage-gap-summary.json');
    const records = [
      {
        type: 'start',
        recordedAt: '2026-01-01T00:00:00Z',
        qbxsqlVersion: '1.0.0-rc.1',
        compatibilityTarget: '2.14.1',
      },
      { type: 'sample', recordedAt: '2026-01-01T00:00:16Z', status: status() },
      { type: 'sample', recordedAt: '2026-01-01T00:00:20Z', status: status() },
      { type: 'finish', recordedAt: '2026-01-01T00:00:20Z', status: status() },
    ];
    await writeFile(input, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

    const result = runValidator(input, output);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('do not continuously cover');
  });

  test('rejects credential-shaped evidence', async () => {
    const input = path.join(temporaryRoot, 'secret.jsonl');
    const output = path.join(temporaryRoot, 'secret-summary.json');
    await writeFile(input, '{"type":"note","value":"mysql://user:password@database/qbox"}\n');

    const result = runValidator(input, output);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('credentials or a connection string');
  });
});
