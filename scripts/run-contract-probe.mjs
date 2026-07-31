import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

const binary = option('--binary');
const connectionString = option('--connection-string', process.env.QBXSQL_TEST_CONNECTION_STRING);
// Read from the environment only: a command argument is visible in process
// listings and shell history.
const licenseKey = process.env.CFX_LICENSE_KEY;
const provider = option('--provider', 'qbxsql');
const oxmysqlPath = option('--oxmysql-path');
const outputPath = option('--output');
const timeout = Number(option('--timeout', '120000'));

if (!binary || !connectionString || !licenseKey || !['qbxsql', 'oxmysql'].includes(provider)) {
  throw new Error(
    'Usage: CFX_LICENSE_KEY=<secret> node scripts/run-contract-probe.mjs --binary <FXServer> --provider qbxsql|oxmysql --connection-string <url> [--oxmysql-path <dir>] [--output result.json]',
  );
}
if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 600_000) {
  throw new Error('--timeout must be an integer from 1000 through 600000.');
}
if (
  provider === 'oxmysql' &&
  !(await stat(path.resolve(oxmysqlPath ?? '')).catch(() => null))?.isDirectory()
) {
  throw new Error('--oxmysql-path must reference an extracted oxmysql 2.14.1 resource.');
}
if (provider === 'oxmysql') {
  const manifest = await readFile(path.join(path.resolve(oxmysqlPath), 'fxmanifest.lua'), 'utf8');
  if (!/^version\s+['"]2\.14\.1['"]/m.test(manifest)) {
    throw new Error('--oxmysql-path must contain oxmysql version 2.14.1.');
  }
}

const release = provider === 'qbxsql' ? await validateBuiltRelease() : null;
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'qbxsql-contract-'));
const resources = path.join(temporaryRoot, 'resources');
const port = 34_000 + (process.pid % 1_000);
let output = '';
const sensitiveValues = [licenseKey, connectionString];
const safeStdout = createSecretSafeWriter(process.stdout, sensitiveValues);

async function cleanup() {
  const relative = path.relative(os.tmpdir(), temporaryRoot);
  if (relative.startsWith('qbxsql-contract-') && !relative.includes(path.sep)) {
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
    path.join(repositoryRoot, 'tests', 'fxserver', 'qbxsql_contract_probe'),
    path.join(resources, 'qbxsql_contract_probe'),
    { recursive: true },
  );

  const config = [
    `sv_licenseKey "${configValue(licenseKey, 'the license key')}"`,
    'sv_hostname "qbxsql contract probe"',
    'sv_maxclients 1',
    `endpoint_add_tcp "127.0.0.1:${port}"`,
    `endpoint_add_udp "127.0.0.1:${port}"`,
    `set mysql_connection_string "${configValue(connectionString, 'the MySQL connection string')}"`,
    'set qbxsql_schema_mode off',
    'set qbxsql_contract_provider "oxmysql"',
    `set qbxsql_contract_result_provider "${provider}"`,
    ...(provider === 'qbxsql' ? ['ensure qbxsql'] : ['ensure oxmysql']),
    'ensure qbxsql_contract_probe',
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
    const timer = setTimeout(
      () => reject(new Error(`Contract probe timed out after ${timeout}ms.`)),
      timeout,
    );
    const consume = (chunk) => {
      const text = chunk.toString();
      output += text;
      safeStdout.push(chunk);
      if (!output.includes('QBXSQL_CONTRACT_RESULT_END')) return;
      try {
        const chunks = [...output.matchAll(/QBXSQL_CONTRACT_CHUNK:(.*?):QBXSQL_CONTRACT_CHUNK_END/g)]
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
    if (!result.success) throw new Error(`${provider} contract probe failed: ${result.error}`);
    if (outputPath) await writeFile(path.resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`[qbxsql] ${provider} contract probe completed.`);
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
