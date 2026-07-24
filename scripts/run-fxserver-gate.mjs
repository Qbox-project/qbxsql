import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { releaseRoot, repositoryRoot, validateBuiltRelease } from './release-lib.mjs';
import { createSecretSafeWriter } from './secret-safe-writer.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const binary = option('--binary');
const connectionString = option('--connection-string', process.env.QBXSQL_TEST_CONNECTION_STRING);
const licenseKey = process.env.CFX_LICENSE_KEY;
const flavor = option('--flavor', 'stock');
const timeout = Number(option('--timeout', '120000'));
if (!binary || !connectionString || !licenseKey) {
  throw new Error(
    'Usage: CFX_LICENSE_KEY=<secret> QBXSQL_TEST_CONNECTION_STRING=<url> node scripts/run-fxserver-gate.mjs --binary <FXServer> [--flavor stock|enhanced]',
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

const sensitiveValues = [licenseKey, connectionString];

async function cleanup() {
  const relative = path.relative(os.tmpdir(), temporaryRoot);
  if (relative.startsWith('qbxsql-fxserver-') && !relative.includes(path.sep)) {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

async function closeServer(server) {
  const exited = () => server.exitCode !== null || server.signalCode !== null;
  if (exited()) return;

  const waitForClose = (timeout) =>
    new Promise((resolve) => {
      if (exited()) {
        resolve(true);
        return;
      }
      const onClose = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        server.off('close', onClose);
        resolve(false);
      }, timeout);
      server.once('close', onClose);
    });

  if (server.stdin.writable) server.stdin.write('quit\n');
  if (await waitForClose(5_000)) return;

  if (!exited()) server.kill('SIGKILL');
  await waitForClose(2_000);
}

async function runConflictGate() {
  const conflictRoot = path.join(temporaryRoot, 'conflict');
  const conflictResources = path.join(conflictRoot, 'resources');
  await mkdir(conflictResources, { recursive: true });
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
  const safeConflictStdout = createSecretSafeWriter(process.stdout, sensitiveValues);
  const safeConflictStderr = createSecretSafeWriter(process.stderr, sensitiveValues);
  let conflictOutput = '';
  let qbxsqlInstalled = false;
  const conflictFinished = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`FXServer conflict gate timed out after ${timeout}ms.`)),
      timeout,
    );
    const consume = (chunk, safeWriter) => {
      const text = chunk.toString();
      conflictOutput += text;
      safeWriter.push(text);
      if (conflictOutput.includes('QBXSQL_COMPAT_CONFLICT_FAIL')) {
        clearTimeout(timer);
        reject(new Error('The qbxsql compatibility conflict probe reported a failure.'));
      }
      if (conflictOutput.includes('QBXSQL_REAL_OXMYSQL_STUB_STARTED') && !qbxsqlInstalled) {
        qbxsqlInstalled = true;
        void cp(path.join(releaseRoot, 'qbxsql'), path.join(conflictResources, 'qbxsql'), {
          recursive: true,
        })
          .then(() => conflictServer.stdin.write('refresh\nensure qbxsql\n'))
          .catch(reject);
      }
      if (
        conflictOutput.includes('QBXSQL_COMPAT_CONFLICT_PASS') &&
        conflictOutput.includes(
          '[qbxsql] Refusing to run while the real oxmysql resource is active',
        )
      ) {
        clearTimeout(timer);
        resolve();
      }
    };
    conflictServer.stdout.on('data', (chunk) => consume(chunk, safeConflictStdout));
    conflictServer.stderr.on('data', (chunk) => consume(chunk, safeConflictStderr));
    conflictServer.stdout.on('end', () => safeConflictStdout.flush());
    conflictServer.stderr.on('end', () => safeConflictStderr.flush());
    conflictServer.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    conflictServer.on('exit', (code, signal) => {
      if (!conflictOutput.includes('QBXSQL_COMPAT_CONFLICT_PASS')) {
        clearTimeout(timer);
        reject(
          new Error(
            `FXServer conflict gate exited with ${signal ?? `code ${code}`} before the fixture passed.`,
          ),
        );
      }
    });
  });

  try {
    await conflictFinished;
  } finally {
    await closeServer(conflictServer);
    safeConflictStdout.flush();
    safeConflictStderr.flush();
  }
}

try {
  await mkdir(resources, { recursive: true });
  await cp(path.join(releaseRoot, 'qbxsql'), path.join(resources, 'qbxsql'), {
    recursive: true,
  });
  const qbxsqlManifest = path.join(resources, 'qbxsql', 'fxmanifest.lua');
  const bridgeManifest = (await readFile(qbxsqlManifest, 'utf8')).replace(
    /^provide 'oxmysql'\r?\n/m,
    '',
  );
  await writeFile(qbxsqlManifest, bridgeManifest);
  const installFixtures = async () => {
    await cp(
      path.join(repositoryRoot, 'tests', 'fxserver', 'oxmysql_bridge'),
      path.join(resources, 'oxmysql'),
      { recursive: true },
    );
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
    ...(flavor === 'enhanced'
      ? []
      : [
          'ensure oxmysql',
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
  const safeStdout = createSecretSafeWriter(process.stdout, sensitiveValues);
  const safeStderr = createSecretSafeWriter(process.stderr, sensitiveValues);
  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`FXServer gate timed out after ${timeout}ms.`)), timeout);
    let enhancedFixturesStarted = false;
    let restartProbeStarted = false;
    let restartCommandsSent = false;
    const consume = (chunk, safeWriter) => {
      const text = chunk.toString();
      output += text;
      safeWriter.push(text);
      if (
        flavor === 'enhanced' &&
        !enhancedFixturesStarted &&
        /Started resource qbxsql/i.test(output)
      ) {
        enhancedFixturesStarted = true;
        void installFixtures()
          .then(() => {
            server.stdin.write(
              'refresh\nensure oxmysql\nensure mysql_async_import_test\nensure qbxsql_runtime_test\nensure qbxsql_restart_probe\n',
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
        server.stdin.write('stop qbxsql\nensure qbxsql\n');
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
    server.stdout.on('data', (chunk) => consume(chunk, safeStdout));
    server.stderr.on('data', (chunk) => consume(chunk, safeStderr));
    server.stdout.on('end', () => safeStdout.flush());
    server.stderr.on('end', () => safeStderr.flush());
    server.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.on('exit', (code, signal) => {
      if (
        !output.includes('QBXSQL_RUNTIME_TEST_PASS') ||
        !output.includes('QBXSQL_MYSQL_ASYNC_IMPORT_PASS') ||
        !output.includes('QBXSQL_RESOURCE_RESTART_PASS')
      ) {
        clearTimeout(timer);
        reject(
          new Error(
            `FXServer exited with ${signal ?? `code ${code}`} before all fixtures passed.`,
          ),
        );
      }
    });
  });

  try {
    await finished;
  } finally {
    await closeServer(server);
    safeStdout.flush();
    safeStderr.flush();
  }

  await runConflictGate();
  console.log(`[qbxsql] ${flavor} FXServer gate passed with ${release.zipName}.`);
} finally {
  await cleanup();
}
