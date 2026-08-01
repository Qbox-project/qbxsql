import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { releaseRoot, repositoryRoot, validateBuiltRelease } from './release-lib.mjs';
import { configValue, createSecretSafeWriter } from './secret-safe-writer.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

// Connection strings carry database passwords; like the license key, they are
// visible in process listings and shell history when passed as arguments.
function secretOption(name, environmentName) {
  const fromArgv = option(name);
  if (fromArgv !== undefined) {
    console.warn(
      `${name} is visible in process listings and shell history; prefer the ${environmentName} environment variable.`,
    );
    return fromArgv;
  }
  return process.env[environmentName];
}

const binary = option('--binary');
const connectionString = secretOption('--connection-string', 'QBXSQL_TEST_CONNECTION_STRING');
// Read from the environment only: a command argument is visible in process
// listings and shell history.
const licenseKey = process.env.CFX_LICENSE_KEY;
const provider = option('--provider', 'qbxsql');
const oxmysqlPath = option('--oxmysql-path');
const outputPath = option('--output');
const duration = Number(option('--duration', '3600000'));
const workers = Number(option('--workers', '100'));
const seed = Number(option('--seed', '81473'));
const timeout = duration + 120_000;

if (!binary || !connectionString || !licenseKey || !['qbxsql', 'oxmysql'].includes(provider)) {
  throw new Error(
    'Usage: CFX_LICENSE_KEY=<secret> node scripts/run-benchmark.mjs --binary <FXServer> --provider qbxsql|oxmysql --connection-string <url> [--oxmysql-path <dir>] [--duration 3600000] [--workers 100] [--output result.json]',
  );
}
for (const [name, value, minimum] of [
  ['duration', duration, 1_000],
  ['workers', workers, 1],
  ['seed', seed, 0],
]) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`--${name} is invalid.`);
}
if (provider === 'oxmysql' && !(await stat(path.resolve(oxmysqlPath ?? '')).catch(() => null))?.isDirectory()) {
  throw new Error('--oxmysql-path must reference an extracted oxmysql 2.14.1 resource.');
}

const release = provider === 'qbxsql' ? await validateBuiltRelease() : null;
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'qbxsql-benchmark-'));
const resources = path.join(temporaryRoot, 'resources');
const port = 33_000 + (process.pid % 1_000);
let output = '';
const sensitiveValues = [licenseKey, connectionString];
const safeStdout = createSecretSafeWriter(process.stdout, sensitiveValues);

async function cleanup() {
  const relative = path.relative(os.tmpdir(), temporaryRoot);
  if (relative.startsWith('qbxsql-benchmark-') && !relative.includes(path.sep)) {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

try {
  await mkdir(resources, { recursive: true });
  if (provider === 'qbxsql') {
    await cp(path.join(releaseRoot, 'qbxsql'), path.join(resources, 'qbxsql'), { recursive: true });
  } else {
    await cp(path.resolve(oxmysqlPath), path.join(resources, 'oxmysql'), { recursive: true });
  }
  await cp(
    path.join(repositoryRoot, 'tests', 'load', 'qbxsql_benchmark'),
    path.join(resources, 'qbxsql_benchmark'),
    { recursive: true },
  );

  const config = [
    `sv_licenseKey "${configValue(licenseKey, 'the license key')}"`,
    'sv_hostname "qbxsql benchmark"',
    'sv_maxclients 1',
    `endpoint_add_tcp "127.0.0.1:${port}"`,
    `endpoint_add_udp "127.0.0.1:${port}"`,
    'sv_master1 ""',
    `set mysql_connection_string "${configValue(connectionString, 'the MySQL connection string')}"`,
    `set mysql_slow_query_warning ${provider === 'oxmysql' ? 2_147_483_647 : 0}`,
    'set qbxsql_slow_query_warning 0',
    'set qbxsql_schema_mode off',
    `set qbxsql_benchmark_provider "${provider}"`,
    `set qbxsql_benchmark_duration ${duration}`,
    `set qbxsql_benchmark_workers ${workers}`,
    `set qbxsql_benchmark_seed ${seed}`,
    `ensure ${provider}`,
    'ensure qbxsql_benchmark',
  ].join('\n');
  await writeFile(path.join(temporaryRoot, 'server.cfg'), `${config}\n`, { mode: 0o600 });

  const server = spawn(path.resolve(binary), ['+exec', 'server.cfg'], {
    cwd: temporaryRoot,
    env: { ...process.env, TXHOST_DATA_PATH: temporaryRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let result;
  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Benchmark timed out after ${timeout}ms.`)), timeout);
    const consume = (chunk) => {
      const text = chunk.toString();
      output += text;
      safeStdout.push(chunk);
      if (!output.includes('QBXSQL_BENCHMARK_RESULT_END')) return;
      try {
        const chunks = [...output.matchAll(/QBXSQL_BENCHMARK_CHUNK:(.*?):QBXSQL_BENCHMARK_CHUNK_END/g)]
          .map((match) => match[1]);
        result = JSON.parse(chunks.join(''));
        clearTimeout(timer);
        resolve();
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    };
    server.stdout.on('data', consume);
    server.stderr.on('data', consume);
    server.on('error', reject);
    server.on('exit', (code) => {
      if (!result) reject(new Error(`FXServer exited with code ${code} before reporting a result.`));
    });
  });

  try {
    await finished;
    if (outputPath) await writeFile(path.resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`);
    console.log(
      `[qbxsql] ${provider} benchmark completed: ${result.operations} operations, median ${result.latency.median}ms, p95 ${result.latency.p95}ms.`,
    );
  } finally {
    if (server.exitCode === null) {
      const closed = once(server, 'close');
      if (server.stdin.writable) server.stdin.write('quit\n');
      const graceful = await Promise.race([
        closed.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
      ]);
      if (!graceful) {
        server.kill('SIGKILL');
        await closed;
      }
    }
  }
} finally {
  safeStdout.flush();
  await cleanup();
}
