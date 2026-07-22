import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { releaseRoot, repositoryRoot, validateBuiltRelease } from './release-lib.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const binary = option('--binary');
const connectionString = option('--connection-string', process.env.QBXSQL_TEST_CONNECTION_STRING);
const licenseKey = option('--license-key', process.env.CFX_LICENSE_KEY);
const flavor = option('--flavor', 'stock');
const timeout = Number(option('--timeout', '120000'));
if (!binary || !connectionString || !licenseKey) {
  throw new Error(
    'Usage: node scripts/run-fxserver-gate.mjs --binary <FXServer> --connection-string <url> --license-key <key> [--flavor stock|enhanced]',
  );
}
if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 600_000) {
  throw new Error('--timeout must be an integer from 1000 through 600000.');
}

const release = await validateBuiltRelease();
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'qbxsql-fxserver-'));
const resources = path.join(temporaryRoot, 'resources');
const port = 32_000 + (process.pid % 1_000);
let output = '';

async function cleanup() {
  const relative = path.relative(os.tmpdir(), temporaryRoot);
  if (relative.startsWith('qbxsql-fxserver-') && !relative.includes(path.sep)) {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

async function closeServer(server) {
  if (server.exitCode !== null) return;

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

async function runConflictGate() {
  const conflictRoot = path.join(temporaryRoot, 'conflict');
  const conflictResources = path.join(conflictRoot, 'resources');
  await mkdir(conflictResources, { recursive: true });
  await cp(path.join(releaseRoot, 'qbxsql'), path.join(conflictResources, 'qbxsql'), {
    recursive: true,
  });
  await cp(
    path.join(repositoryRoot, 'tests', 'fxserver', 'oxmysql_conflict'),
    path.join(conflictResources, 'oxmysql'),
    { recursive: true },
  );

  const conflictConfig = [
    `sv_licenseKey "${licenseKey.replaceAll('"', '')}"`,
    'sv_hostname "qbxsql conflict gate"',
    'sv_maxclients 1',
    `endpoint_add_tcp "127.0.0.1:${port + 1}"`,
    `endpoint_add_udp "127.0.0.1:${port + 1}"`,
    `set mysql_connection_string "${connectionString.replaceAll('"', '')}"`,
    'ensure qbxsql',
    'ensure oxmysql',
  ].join('\n');
  await writeFile(path.join(conflictRoot, 'server.cfg'), `${conflictConfig}\n`, { mode: 0o600 });

  const conflictServer = spawn(path.resolve(binary), ['+exec', 'server.cfg'], {
    cwd: conflictRoot,
    env: {
      ...process.env,
      TXHOST_DATA_PATH: conflictRoot,
      TXHOST_PROVIDER_NAME: 'qbxsql conflict gate',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let conflictOutput = '';
  let compatibilityInstalled = false;
  const conflictFinished = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`FXServer conflict gate timed out after ${timeout}ms.`)),
      timeout,
    );
    const consume = (chunk) => {
      const text = chunk.toString();
      conflictOutput += text;
      process.stdout.write(text);
      if (conflictOutput.includes('QBXSQL_COMPAT_CONFLICT_FAIL')) {
        clearTimeout(timer);
        reject(new Error('The qbxsql compatibility conflict probe reported a failure.'));
      }
      if (conflictOutput.includes('QBXSQL_REAL_OXMYSQL_STUB_STARTED') && !compatibilityInstalled) {
        compatibilityInstalled = true;
        void cp(path.join(releaseRoot, 'qbxsql_compat'), path.join(conflictResources, 'qbxsql_compat'), {
          recursive: true,
        })
          .then(() => conflictServer.stdin.write('refresh\nensure qbxsql_compat\n'))
          .catch(reject);
      }
      if (
        conflictOutput.includes('QBXSQL_COMPAT_CONFLICT_PASS') &&
        conflictOutput.includes(
          '[qbxsql_compat] Refusing to run while the real oxmysql resource is active',
        )
      ) {
        clearTimeout(timer);
        resolve();
      }
    };
    conflictServer.stdout.on('data', consume);
    conflictServer.stderr.on('data', consume);
    conflictServer.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    conflictServer.on('exit', (code) => {
      if (!conflictOutput.includes('QBXSQL_COMPAT_CONFLICT_PASS')) {
        clearTimeout(timer);
        reject(new Error(`FXServer conflict gate exited with code ${code} before the fixture passed.`));
      }
    });
  });

  try {
    await conflictFinished;
  } finally {
    await closeServer(conflictServer);
  }
}

try {
  await mkdir(resources, { recursive: true });
  for (const resource of ['qbxsql', 'qbxsql_compat']) {
    await cp(path.join(releaseRoot, resource), path.join(resources, resource), { recursive: true });
  }
  const installFixtures = async () => {
    for (const fixture of [
      'qbxsql_runtime_test',
      'mysql_async_import_test',
      'qbxsql_restart_probe',
    ]) {
      await cp(
        path.join(repositoryRoot, 'tests', 'fxserver', fixture),
        path.join(resources, fixture),
        { recursive: true },
      );
    }
  };
  if (flavor !== 'enhanced') await installFixtures();

  const config = [
    `sv_licenseKey "${licenseKey.replaceAll('"', '')}"`,
    'sv_hostname "qbxsql release gate"',
    'sv_maxclients 1',
    `endpoint_add_tcp "127.0.0.1:${port}"`,
    `endpoint_add_udp "127.0.0.1:${port}"`,
    `set mysql_connection_string "${connectionString.replaceAll('"', '')}"`,
    'set qbxsql_connection_wait_timeout 30000',
    'set qbxsql_schema_mode auto',
    'ensure qbxsql',
    'ensure qbxsql_compat',
    ...(flavor === 'enhanced'
      ? []
      : [
          'ensure mysql_async_import_test',
          'ensure qbxsql_runtime_test',
          'ensure qbxsql_restart_probe',
        ]),
  ].join('\n');
  await writeFile(path.join(temporaryRoot, 'server.cfg'), `${config}\n`, { mode: 0o600 });

  const server = spawn(path.resolve(binary), ['+exec', 'server.cfg'], {
    cwd: temporaryRoot,
    env: {
      ...process.env,
      TXHOST_DATA_PATH: temporaryRoot,
      TXHOST_PROVIDER_NAME: 'qbxsql release gate',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`FXServer gate timed out after ${timeout}ms.`)), timeout);
    let enhancedFixturesStarted = false;
    let restartProbeStarted = false;
    let restartCommandsSent = false;
    const consume = (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
      if (
        flavor === 'enhanced' &&
        !enhancedFixturesStarted &&
        /Started resource qbxsql_compat/i.test(output)
      ) {
        enhancedFixturesStarted = true;
        void installFixtures()
          .then(() => {
            server.stdin.write(
              'refresh\nensure mysql_async_import_test\nensure qbxsql_runtime_test\nensure qbxsql_restart_probe\n',
            );
          })
          .catch(reject);
      }
      if (output.includes('QBXSQL_RUNTIME_TEST_FAIL')) {
        clearTimeout(timer);
        reject(new Error('The qbxsql runtime fixture reported a failure.'));
      }
      if (output.includes('QBXSQL_RESOURCE_RESTART_FAIL')) {
        clearTimeout(timer);
        reject(new Error('The qbxsql resource restart probe reported a failure.'));
      }
      if (
        output.includes('QBXSQL_RUNTIME_TEST_PASS') &&
        output.includes('QBXSQL_MYSQL_ASYNC_IMPORT_PASS') &&
        !restartProbeStarted
      ) {
        restartProbeStarted = true;
        server.stdin.write('qbxsql_restart_probe_begin\n');
      }
      if (output.includes('QBXSQL_INFLIGHT_QUERY_STARTED') && !restartCommandsSent) {
        restartCommandsSent = true;
        server.stdin.write('stop qbxsql_compat\nstop qbxsql\nensure qbxsql\nensure qbxsql_compat\n');
      }
      if (
        output.includes('QBXSQL_RUNTIME_TEST_PASS') &&
        output.includes('QBXSQL_MYSQL_ASYNC_IMPORT_PASS') &&
        output.includes('QBXSQL_RESOURCE_RESTART_PASS')
      ) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout.on('data', consume);
    server.stderr.on('data', consume);
    server.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.on('exit', (code) => {
      if (
        !output.includes('QBXSQL_RUNTIME_TEST_PASS') ||
        !output.includes('QBXSQL_MYSQL_ASYNC_IMPORT_PASS') ||
        !output.includes('QBXSQL_RESOURCE_RESTART_PASS')
      ) {
        clearTimeout(timer);
        reject(new Error(`FXServer exited with code ${code} before all fixtures passed.`));
      }
    });
  });

  try {
    await finished;
  } finally {
    await closeServer(server);
  }

  await runConflictGate();
  console.log(`[qbxsql] ${flavor} FXServer gate passed with ${release.zipName}.`);
} finally {
  await cleanup();
}
