import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateBuiltRelease } from './release-lib.mjs';

const REQUIRED_CHECKS = [
  'backup_restore_rehearsed',
  'real_oxmysql_absent',
  'release_resources_verified',
  'dependencies_visible',
  'initial_status_healthy',
  'character_persistence',
  'inventory_persistence',
  'banking_persistence',
  'vehicle_persistence',
  'property_persistence',
  'resource_restarts',
  'compatibility_restart',
  'idle_database_outage',
  'active_database_outage',
  'queue_errors_sanitized',
  'scheduled_shutdown_startup',
  'no_unexplained_failures',
  'no_dependency_failures',
  'no_connection_leaks',
  'schema_results_reviewed',
  'release_evidence_linked',
];

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requiredText(metadata, name) {
  const value = metadata?.[name];
  if (typeof value !== 'string' || value.trim().length < 2 || value.length > 300) {
    throw new Error(`Certification metadata '${name}' is missing or invalid.`);
  }
  return value.trim();
}

const input = option('--input');
const output = option('--output');
if (!input) {
  throw new Error(
    'Usage: node scripts/validate-qbox-certification.mjs --input certification.json [--output summary.json]',
  );
}

const raw = await readFile(path.resolve(input), 'utf8');
if (/(?:mysql|mariadb|postgres(?:ql)?):\/\/|(?:password|pwd)\s*=|sv_licensekey|cfx_license_key|cfxk_[A-Za-z0-9_-]{16,}/i.test(raw)) {
  throw new Error('Qbox certification appears to contain credentials or a connection string.');
}
const certification = JSON.parse(raw);
if (certification.schemaVersion !== 1) throw new Error('Unsupported certification schemaVersion.');
const release = await validateBuiltRelease();
const metadata = certification.metadata;
const normalizedMetadata = {
  operator: requiredText(metadata, 'operator'),
  testedAt: requiredText(metadata, 'testedAt'),
  serverArtifact: requiredText(metadata, 'serverArtifact'),
  clientArtifact: requiredText(metadata, 'clientArtifact'),
  qboxVersion: requiredText(metadata, 'qboxVersion'),
  databaseVersion: requiredText(metadata, 'databaseVersion'),
  qbxsqlVersion: requiredText(metadata, 'qbxsqlVersion'),
  compatibilityTarget: requiredText(metadata, 'compatibilityTarget'),
  qbxsqlSha256: requiredText(metadata, 'qbxsqlSha256').toLowerCase(),
  evidenceBundle: requiredText(metadata, 'evidenceBundle'),
};
if (!Number.isFinite(Date.parse(normalizedMetadata.testedAt))) {
  throw new Error("Certification metadata 'testedAt' is not an ISO date/time.");
}
if (normalizedMetadata.qbxsqlVersion !== release.coreVersion) {
  throw new Error('Certification qbxsqlVersion does not match the built release.');
}
if (normalizedMetadata.compatibilityTarget !== release.compatibilityVersion) {
  throw new Error('Certification compatibilityTarget does not match the built release.');
}
if (normalizedMetadata.qbxsqlSha256 !== release.sha256) {
  throw new Error('Certification qbxsqlSha256 does not match the built release.');
}

const checks = certification.checks;
if (!checks || typeof checks !== 'object' || Array.isArray(checks)) {
  throw new Error('Certification checks must be an object.');
}
const unknownChecks = Object.keys(checks).filter((name) => !REQUIRED_CHECKS.includes(name));
if (unknownChecks.length > 0) {
  throw new Error(`Certification contains unknown checks: ${unknownChecks.join(', ')}.`);
}
for (const name of REQUIRED_CHECKS) {
  const check = checks[name];
  if (check?.passed !== true) throw new Error(`Certification check '${name}' has not passed.`);
  if (!Array.isArray(check.evidence) || check.evidence.length === 0) {
    throw new Error(`Certification check '${name}' has no evidence reference.`);
  }
  for (const reference of check.evidence) {
    if (
      typeof reference !== 'string' ||
      reference.trim().length < 3 ||
      reference.length > 500 ||
      /^[a-z]+:\/\//i.test(reference) && !/^https:\/\//i.test(reference)
    ) {
      throw new Error(`Certification check '${name}' has an invalid evidence reference.`);
    }
  }
}

const summary = {
  schemaVersion: 1,
  validatedAt: new Date().toISOString(),
  release: {
    version: release.coreVersion,
    compatibilityTarget: release.compatibilityVersion,
    archive: release.zipName,
    sha256: release.sha256,
  },
  metadata: normalizedMetadata,
  passedChecks: REQUIRED_CHECKS,
  evidenceReferences: Object.fromEntries(
    REQUIRED_CHECKS.map((name) => [name, checks[name].evidence]),
  ),
};
if (output) {
  await writeFile(path.resolve(output), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
}
console.log(
  `[qbxsql] Qbox certification passed ${REQUIRED_CHECKS.length} checks for ${release.zipName}.`,
);
