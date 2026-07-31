import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_ARTIFACT_URL =
  'https://runtime.fivem.net/artifacts/fivem/build_proot_linux/master/25770-8ddccd4e4dfd6a760ce18651656463f961cc4761/fx.tar.xz';
// Must stay in step with scripts/run-local-linux-gate.mjs.
const DEFAULT_ARTIFACT_SHA256 =
  '4d55acd1306651aecf8457699485c736d08aae37b075c493a66dacd623402631';
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
const artifactChecksumOption =
  option('--artifact-sha256') ?? process.env.CFX_LINUX_ARTIFACT_SHA256;
const dockerNetwork = option('--docker-network');
const timeout = Number(option('--timeout', '180000'));
const licenseKey = process.env.CFX_LICENSE_KEY;
const connectionString = process.env.QBXSQL_TEST_CONNECTION_STRING;
const postgresConnectionString = process.env.QBXSQL_TEST_POSTGRES_CONNECTION_STRING;

if (!licenseKey || !connectionString || !postgresConnectionString) {
  throw new Error(
    'CFX_LICENSE_KEY, QBXSQL_TEST_CONNECTION_STRING, and QBXSQL_TEST_POSTGRES_CONNECTION_STRING are required.',
  );
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
  // An https host allowlist says where the bytes came from, not what they are.
  // The wrapper verifies a checksum before passing --artifact-path; invoking
  // this script directly with a URL must not skip that.
  if (artifactUrl !== DEFAULT_ARTIFACT_URL && !artifactChecksumOption) {
    throw new Error(
      'A custom --artifact-url requires --artifact-sha256 or CFX_LINUX_ARTIFACT_SHA256.',
    );
  }
}
const artifactChecksum = artifactChecksumOption ?? DEFAULT_ARTIFACT_SHA256;
if (!artifactPath && !/^[a-f0-9]{64}$/.test(artifactChecksum)) {
  throw new Error('--artifact-sha256 must be a 64 character hex SHA-256 digest.');
}

const repositoryRoot = path.resolve(import.meta.dirname, '..');
// Download to disk and verify before extracting: piping curl into tar would
// execute whatever a compromised CDN or redirect returned.
const artifactSetup = artifactPath
  ? 'tar -xJf /qbxsql-artifact/fx.tar.xz -C /fxserver'
  : [
      'curl --fail --location --retry 3 --silent --show-error "$CFX_LINUX_ARTIFACT_URL" -o /tmp/fx.tar.xz',
      'echo "$CFX_LINUX_ARTIFACT_SHA256  /tmp/fx.tar.xz" | sha256sum --check --strict --status',
      'tar -xJf /tmp/fx.tar.xz -C /fxserver',
      'rm -f /tmp/fx.tar.xz',
    ].join('\n');
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
  'QBXSQL_TEST_POSTGRES_CONNECTION_STRING',
  '--env',
  'CFX_LINUX_ARTIFACT_URL',
  '--env',
  'CFX_LINUX_ARTIFACT_SHA256',
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
      QBXSQL_TEST_POSTGRES_CONNECTION_STRING:
        dockerConnectionString(postgresConnectionString),
      CFX_LINUX_ARTIFACT_URL: parsedArtifact?.href ?? '',
      CFX_LINUX_ARTIFACT_SHA256: artifactPath ? '' : artifactChecksum,
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
