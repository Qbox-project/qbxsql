import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_ARTIFACT_URL =
  'https://runtime.fivem.net/artifacts/fivem/build_proot_linux/master/25770-8ddccd4e4dfd6a760ce18651656463f961cc4761/fx.tar.xz';
const NODE_IMAGE =
  'node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function dockerConnectionString(connectionString) {
  return connectionString
    .replace(/@(127\.0\.0\.1|localhost)(?=[:/]|$)/gi, '@host.docker.internal')
    .replace(
      /(^|;)\s*(server|host|data source)\s*=\s*(127\.0\.0\.1|localhost)(?=;|$)/gi,
      '$1$2=host.docker.internal',
    );
}

const artifactUrl = option(
  '--artifact-url',
  process.env.CFX_LINUX_ARTIFACT_URL ?? DEFAULT_ARTIFACT_URL,
);
const artifactPathOption = option(
  '--artifact-path',
  process.env.CFX_LINUX_ARTIFACT_PATH,
);
const dockerNetwork = option('--docker-network');
const timeout = Number(option('--timeout', '180000'));
const licenseKey = process.env.CFX_LICENSE_KEY;
const connectionString = process.env.QBXSQL_TEST_CONNECTION_STRING;

if (!licenseKey || !connectionString) {
  throw new Error('CFX_LICENSE_KEY and QBXSQL_TEST_CONNECTION_STRING are required.');
}
if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 600_000) {
  throw new Error('--timeout must be an integer from 1000 through 600000.');
}

let artifactPath;
let parsedArtifact;
if (artifactPathOption) {
  artifactPath = path.resolve(artifactPathOption);
  const artifact = await stat(artifactPath).catch(() => null);
  if (!artifact?.isFile()) {
    throw new Error(`--artifact-path is not a file: ${artifactPath}`);
  }
} else {
  parsedArtifact = new URL(artifactUrl);
  if (
    parsedArtifact.protocol !== 'https:' ||
    parsedArtifact.hostname !== 'runtime.fivem.net' ||
    !parsedArtifact.pathname.endsWith('/fx.tar.xz')
  ) {
    throw new Error('--artifact-url must be an official runtime.fivem.net Linux fx.tar.xz URL.');
  }
}

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const artifactSetup = artifactPath
  ? 'tar -xJf /qbxsql-artifact/fx.tar.xz -C /fxserver'
  : 'curl --fail --location --retry 3 --silent --show-error "$CFX_LINUX_ARTIFACT_URL" | tar -xJ -C /fxserver';
const containerScript = `
set -euo pipefail
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils libatomic1 >/dev/null
mkdir -p /fxserver
${artifactSetup}
node scripts/run-fxserver-gate.mjs --binary /fxserver/run.sh --flavor stock --timeout ${timeout}
`;

const dockerArguments = [
  'run',
  '--rm',
  '--add-host',
  'host.docker.internal:host-gateway',
  '--env',
  'CFX_LICENSE_KEY',
  '--env',
  'QBXSQL_TEST_CONNECTION_STRING',
  '--env',
  'CFX_LINUX_ARTIFACT_URL',
];
if (dockerNetwork) dockerArguments.push('--network', dockerNetwork);
if (artifactPath) {
  dockerArguments.push(
    '--volume',
    `${artifactPath}:/qbxsql-artifact/fx.tar.xz:ro`,
  );
}
dockerArguments.push(
  '--volume',
  `${repositoryRoot}:/repo:ro`,
  '--workdir',
  '/repo',
  NODE_IMAGE,
  'bash',
  '-lc',
  containerScript,
);

const docker = spawn(
  'docker',
  dockerArguments,
  {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      CFX_LICENSE_KEY: licenseKey,
      QBXSQL_TEST_CONNECTION_STRING: dockerConnectionString(connectionString),
      CFX_LINUX_ARTIFACT_URL: parsedArtifact?.href ?? '',
    },
  },
);

const [code, signal] = await new Promise((resolve, reject) => {
  docker.once('error', (error) =>
    reject(new Error(`Unable to start Docker: ${error.message}`, { cause: error })),
  );
  docker.once('exit', (...result) => resolve(result));
});
if (code !== 0) {
  throw new Error(`Containerized Linux FXServer gate failed (${signal ?? `exit ${code}`}).`);
}

console.log(
  artifactPath
    ? `[qbxsql] containerized Linux gate passed with cached artifact ${path.basename(path.dirname(artifactPath))}.`
    : `[qbxsql] containerized Linux gate passed with ${parsedArtifact.href}`,
);
