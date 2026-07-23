import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
} from 'node:fs';
import {
  mkdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  promptCfxKey,
  readLocalCfxKey,
} from './local-cfx-key.mjs';

const DEFAULT_ARTIFACT_URL =
  'https://runtime.fivem.net/artifacts/fivem/build_proot_linux/master/25770-8ddccd4e4dfd6a760ce18651656463f961cc4761/fx.tar.xz';
const DEFAULT_ARTIFACT_SHA256 =
  '4d55acd1306651aecf8457699485c736d08aae37b075c493a66dacd623402631';
const DATABASE_IMAGE = 'mariadb:11.4';
const DATABASE_NAME = 'qbxsql_fxserver';

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function publicEnvironment() {
  const environment = { ...process.env };
  delete environment.CFX_LICENSE_KEY;
  delete environment.QBXSQL_TEST_CONNECTION_STRING;
  return environment;
}

function validateArtifact(url, checksum) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'runtime.fivem.net' ||
    !parsed.pathname.endsWith('/fx.tar.xz')
  ) {
    throw new Error('The artifact must be an official runtime.fivem.net Linux fx.tar.xz URL.');
  }
  if (!/^[a-f0-9]{64}$/i.test(checksum)) {
    throw new Error('The artifact SHA-256 must contain exactly 64 hexadecimal characters.');
  }
  return { url: parsed.href, checksum: checksum.toLowerCase() };
}

async function run(command, arguments_, options = {}) {
  const child = spawn(command, arguments_, {
    env: options.env ?? publicEnvironment(),
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  if (options.capture) {
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
  }
  const [code, signal] = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (...result) => resolve(result));
  });
  if (code !== 0 && !options.allowFailure) {
    const detail = options.capture && stderr.trim() ? `: ${stderr.trim()}` : '';
    throw new Error(`${command} failed (${signal ?? `exit ${code}`})${detail}`);
  }
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifiedArtifact(repositoryRoot, artifact) {
  const cacheRoot = path.join(
    repositoryRoot,
    '.cache',
    'fxserver',
    'linux',
    artifact.checksum.slice(0, 16),
  );
  const archive = path.join(cacheRoot, 'fx.tar.xz');
  const partial = path.join(cacheRoot, `fx.tar.xz.part-${process.pid}`);
  await mkdir(cacheRoot, { recursive: true });

  const cached = await stat(archive).catch(() => null);
  if (cached?.isFile()) {
    if ((await sha256(archive)) === artifact.checksum) {
      console.log(`[qbxsql] using verified cached FXServer artifact (${cached.size} bytes).`);
      return archive;
    }
    await rm(archive, { force: true });
    console.warn('[qbxsql] discarded a cached FXServer artifact with the wrong checksum.');
  }

  console.log(`[qbxsql] downloading ${artifact.url}`);
  try {
    const response = await fetch(artifact.url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new Error(`Artifact download failed with HTTP ${response.status}.`);
    }
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(partial, { flags: 'wx' }),
    );
    const actual = await sha256(partial);
    if (actual !== artifact.checksum) {
      throw new Error(
        `Artifact checksum mismatch: expected ${artifact.checksum}, received ${actual}.`,
      );
    }
    await rename(partial, archive);
  } finally {
    await rm(partial, { force: true });
  }

  const downloaded = await stat(archive);
  console.log(`[qbxsql] cached verified FXServer artifact (${downloaded.size} bytes).`);
  return archive;
}

async function waitForDatabase(container) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const inspected = await run(
      'docker',
      ['inspect', '--format', '{{.State.Status}} {{.State.Health.Status}}', container],
      { capture: true, allowFailure: true },
    );
    if (inspected.code === 0) {
      if (inspected.stdout === 'running healthy') return;
      if (inspected.stdout.startsWith('exited ')) {
        await run('docker', ['logs', container], { allowFailure: true });
        throw new Error('The disposable MariaDB container exited during startup.');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  await run('docker', ['logs', container], { allowFailure: true });
  throw new Error('The disposable MariaDB container did not become healthy within 120 seconds.');
}

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const overrideUrl = option('--artifact-url') ?? process.env.CFX_LINUX_ARTIFACT_URL;
const overrideChecksum =
  option('--artifact-sha256') ?? process.env.CFX_LINUX_ARTIFACT_SHA256;
if (overrideUrl && !overrideChecksum) {
  throw new Error('A custom artifact URL requires --artifact-sha256 or CFX_LINUX_ARTIFACT_SHA256.');
}
if (!overrideUrl && overrideChecksum) {
  throw new Error('A custom artifact SHA-256 requires --artifact-url or CFX_LINUX_ARTIFACT_URL.');
}
const artifact = validateArtifact(
  overrideUrl ?? DEFAULT_ARTIFACT_URL,
  overrideChecksum ?? DEFAULT_ARTIFACT_SHA256,
);
let licenseKey =
  process.env.CFX_LICENSE_KEY ?? (await readLocalCfxKey(repositoryRoot));
delete process.env.CFX_LICENSE_KEY;
delete process.env.QBXSQL_TEST_CONNECTION_STRING;

const identifier = `${process.pid}-${Date.now().toString(36)}`;
const network = `qbxsql-gate-${identifier}`;
const database = `qbxsql-gate-db-${identifier}`;
let networkCreated = false;
let databaseStarted = false;

try {
  await run('docker', ['version'], { capture: true });
  await run(process.platform === 'win32' ? 'bun.exe' : 'bun', ['run', 'release']);
  const archive = await verifiedArtifact(repositoryRoot, artifact);

  await run('docker', ['network', 'create', network], { capture: true });
  networkCreated = true;
  await run(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      database,
      '--network',
      network,
      '--env',
      'MARIADB_ROOT_PASSWORD=root',
      '--env',
      `MARIADB_DATABASE=${DATABASE_NAME}`,
      '--health-cmd',
      'healthcheck.sh --connect --innodb_initialized',
      '--health-interval',
      '2s',
      '--health-timeout',
      '5s',
      '--health-retries',
      '60',
      DATABASE_IMAGE,
    ],
    { capture: true },
  );
  databaseStarted = true;
  await waitForDatabase(database);

  licenseKey ??= await promptCfxKey();
  await run(
    process.execPath,
    [
      'scripts/run-containerized-linux-gate.mjs',
      '--artifact-path',
      archive,
      '--docker-network',
      network,
    ],
    {
      env: {
        ...publicEnvironment(),
        CFX_LICENSE_KEY: licenseKey,
        QBXSQL_TEST_CONNECTION_STRING:
          `mysql://root:root@${database}:3306/${DATABASE_NAME}`,
      },
    },
  );
  console.log('[qbxsql] local stock-Linux FXServer test passed.');
} finally {
  licenseKey = undefined;
  if (databaseStarted) {
    await run('docker', ['rm', '--force', database], {
      capture: true,
      allowFailure: true,
    });
  }
  if (networkCreated) {
    await run('docker', ['network', 'rm', network], {
      capture: true,
      allowFailure: true,
    });
  }
}
