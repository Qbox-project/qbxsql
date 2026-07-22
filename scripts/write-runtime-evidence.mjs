import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { validateBuiltRelease } from './release-lib.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

const binaryArgument = option('--binary');
const flavor = option('--flavor');
const outputArgument = option('--output');
if (!binaryArgument || !outputArgument || !['stock', 'enhanced'].includes(flavor)) {
  throw new Error(
    'Usage: node scripts/write-runtime-evidence.mjs --binary <FXServer> --flavor stock|enhanced --output <evidence.json>',
  );
}

const binary = path.resolve(binaryArgument);
const binaryStat = await stat(binary);
if (!binaryStat.isFile()) throw new Error('--binary must reference a file.');
const release = await validateBuiltRelease();
const cpus = os.cpus();
const evidence = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  runtime: {
    flavor,
    platform: os.platform(),
    release: os.release(),
    architecture: os.arch(),
    cpuModel: cpus[0]?.model ?? 'unknown',
    logicalCpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    nodeVersion: process.version,
  },
  fxserver: {
    filename: path.basename(binary),
    sizeBytes: binaryStat.size,
    sha256: await sha256(binary),
  },
  qbxsql: {
    version: release.coreVersion,
    compatibilityTarget: release.compatibilityVersion,
    archive: release.zipName,
    sha256: release.sha256,
  },
  ci: {
    commit: process.env.GITHUB_SHA || null,
    ref: process.env.GITHUB_REF_NAME || null,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    runnerOs: process.env.RUNNER_OS || null,
    runnerArchitecture: process.env.RUNNER_ARCH || null,
  },
};

await writeFile(path.resolve(outputArgument), `${JSON.stringify(evidence, null, 2)}\n`, {
  mode: 0o600,
});
console.log(
  `[qbxsql] wrote sanitized ${flavor} runtime evidence for ${release.zipName} to ${path.basename(outputArgument)}.`,
);
