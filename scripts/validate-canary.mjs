import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function positiveInteger(name, fallback) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function timestamp(record, line) {
  const value = Date.parse(record.recordedAt);
  if (!Number.isFinite(value)) throw new Error(`Canary line ${line} has an invalid recordedAt.`);
  return value;
}

function validateStatus(status, context) {
  if (!status || typeof status !== 'object') throw new Error(`${context} omitted status.`);
  if (!status.pool || !status.memory || !status.totals) {
    throw new Error(`${context} does not contain a complete qbxsql status snapshot.`);
  }
  for (const [name, value] of Object.entries({
    acquired: status.pool.acquired,
    queued: status.pool.queued,
    queuedCalls: status.queuedCalls,
    rss: status.memory.rss,
    queries: status.totals.queries,
    errors: status.totals.errors,
    slowQueries: status.totals.slowQueries,
    reconnects: status.totals.reconnects,
  })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${context} has invalid ${name}.`);
  }
}

const input = option('--input');
const output = option('--output');
const minimumDuration = positiveInteger('--minimum-duration', 7 * 24 * 60 * 60 * 1000);
const maximumGap = positiveInteger('--maximum-gap', 15 * 60 * 1000);
const allowedErrorDelta = positiveInteger('--allow-error-delta', 0);
const errorJustification = option('--error-justification', '');
if (!input) {
  throw new Error(
    'Usage: node scripts/validate-canary.mjs --input canary.jsonl [--output summary.json] [--minimum-duration ms] [--maximum-gap ms] [--allow-error-delta count --error-justification text]',
  );
}
if (allowedErrorDelta > 0 && errorJustification.trim().length < 10) {
  throw new Error('--error-justification of at least 10 characters is required for an allowed error delta.');
}

const raw = await readFile(path.resolve(input), 'utf8');
if (/(?:mysql|mariadb|postgres(?:ql)?):\/\/|(?:password|pwd)\s*=|sv_licensekey|cfx_license_key|cfxk_[A-Za-z0-9_-]{16,}/i.test(raw)) {
  throw new Error('Canary evidence appears to contain credentials or a connection string.');
}
const records = raw
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Canary line ${index + 1} is not valid JSON: ${error.message}`);
    }
  });
const starts = records.filter((record) => record.type === 'start');
const finishes = records.filter((record) => record.type === 'finish');
const samples = records.filter((record) => record.type === 'sample');
if (starts.length === 0 || finishes.length === 0) {
  throw new Error('Canary evidence requires at least one start and an explicit finish record.');
}
if (samples.length < 2) throw new Error('Canary evidence requires at least two status samples.');

const versions = new Set(starts.map((record) => record.qbxsqlVersion));
const compatibilityTargets = new Set(starts.map((record) => record.compatibilityTarget));
if (versions.size !== 1 || versions.has(null) || versions.has(undefined)) {
  throw new Error('qbxsql version changed or was missing during the canary.');
}
if (
  compatibilityTargets.size !== 1 ||
  compatibilityTargets.has(null) ||
  compatibilityTargets.has(undefined)
) {
  throw new Error('Compatibility target changed or was missing during the canary.');
}

const startTime = timestamp(starts[0], records.indexOf(starts[0]) + 1);
const finish = finishes.at(-1);
const finishTime = timestamp(finish, records.indexOf(finish) + 1);
const durationMs = finishTime - startTime;
if (durationMs < minimumDuration) {
  throw new Error(`Canary duration ${durationMs}ms is below the required ${minimumDuration}ms.`);
}

const sampleTimes = samples.map((sample) => {
  const line = records.indexOf(sample) + 1;
  validateStatus(sample.status, `Canary sample line ${line}`);
  return timestamp(sample, line);
});
for (let index = 1; index < sampleTimes.length; index += 1) {
  const gap = sampleTimes[index] - sampleTimes[index - 1];
  if (gap < 0) throw new Error('Canary samples are not in chronological order.');
  if (gap > maximumGap) throw new Error(`Canary sample gap ${gap}ms exceeds ${maximumGap}ms.`);
}
if (sampleTimes[0] < startTime || sampleTimes.at(-1) > finishTime) {
  throw new Error('Canary samples must fall between the first start and final finish records.');
}
if (sampleTimes[0] - startTime > maximumGap || finishTime - sampleTimes.at(-1) > maximumGap) {
  throw new Error('Canary samples do not continuously cover the start-to-finish interval.');
}

validateStatus(finish.status, 'Canary finish record');
if (
  finish.status.state !== 'ready' ||
  finish.status.pool.acquired !== 0 ||
  finish.status.pool.queued !== 0 ||
  finish.status.queuedCalls !== 0
) {
  throw new Error('Canary did not finish ready with an empty acquisition and connection queue.');
}

const firstStatus = samples[0].status;
const lastStatus = samples.at(-1).status;
const counterDelta = (name) => {
  let total = 0;
  let previous = firstStatus.totals[name];
  for (const sample of samples.slice(1)) {
    const current = sample.status.totals[name];
    total += current >= previous ? current - previous : current;
    previous = current;
  }
  return total;
};
const errorDelta = counterDelta('errors');
if (errorDelta > allowedErrorDelta) {
  throw new Error(`Canary error delta ${errorDelta} exceeds the allowed ${allowedErrorDelta}.`);
}

const midpoint = startTime + durationMs / 2;
const finalHalf = samples.filter((_, index) => sampleTimes[index] >= midpoint);
const firstFinalRss = finalHalf[0]?.status.memory.rss ?? lastStatus.memory.rss;
const memoryGrowthPercent =
  firstFinalRss === 0 ? 0 : ((lastStatus.memory.rss - firstFinalRss) / firstFinalRss) * 100;
const summary = {
  schemaVersion: 1,
  validatedAt: new Date().toISOString(),
  qbxsqlVersion: [...versions][0],
  compatibilityTarget: [...compatibilityTargets][0],
  startedAt: starts[0].recordedAt,
  finishedAt: finish.recordedAt,
  durationMs,
  samples: samples.length,
  lifecycleEvents: records.filter((record) => record.type === 'lifecycle').length,
  checkpoints: records
    .filter((record) => record.type === 'checkpoint')
    .map((record) => record.label),
  maxima: {
    acquired: Math.max(...samples.map((sample) => sample.status.pool.acquired)),
    queued: Math.max(...samples.map((sample) => sample.status.pool.queued)),
    queuedCalls: Math.max(...samples.map((sample) => sample.status.queuedCalls)),
  },
  deltas: {
    queries: counterDelta('queries'),
    errors: errorDelta,
    slowQueries: counterDelta('slowQueries'),
    reconnects: counterDelta('reconnects'),
  },
  finalHalfMemoryGrowthPercent: Number(memoryGrowthPercent.toFixed(2)),
  errorJustification: errorDelta > 0 ? errorJustification.trim() : null,
  endingStatus: finish.status,
};

if (output) {
  await writeFile(path.resolve(output), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
}
console.log(
  `[qbxsql] canary passed: ${summary.samples} samples over ${summary.durationMs}ms, ${summary.deltas.errors} error delta.`,
);
