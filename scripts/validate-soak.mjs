import { readFile } from 'node:fs/promises';
import path from 'node:path';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const resultPath = option('--result');
const minimumDuration = Number(option('--minimum-duration', '3600000'));
const minimumReconnects = Number(option('--minimum-reconnects', '1'));
const minimumPoolAcquired = Number(option('--minimum-pool-acquired', '10'));
if (!resultPath) throw new Error('--result <qbxsql-soak.json> is required.');
if (!Number.isSafeInteger(minimumDuration) || minimumDuration < 1_000) {
  throw new Error('--minimum-duration is invalid.');
}
if (!Number.isSafeInteger(minimumReconnects) || minimumReconnects < 0) {
  throw new Error('--minimum-reconnects is invalid.');
}
if (!Number.isSafeInteger(minimumPoolAcquired) || minimumPoolAcquired < 1) {
  throw new Error('--minimum-pool-acquired is invalid.');
}

const result = JSON.parse(await readFile(path.resolve(resultPath), 'utf8'));
const failures = [];
if (result.provider !== 'qbxsql') failures.push(`expected qbxsql result, received ${result.provider}`);
if (result.durationMs < minimumDuration) {
  failures.push(`duration ${result.durationMs}ms is below ${minimumDuration}ms`);
}
if (result.operations <= 0) failures.push('no operations completed');
if (result.failures !== 0) failures.push(`${result.failures} unexplained operations failed`);
if ((result.transactionInvariantViolations ?? Number.POSITIVE_INFINITY) !== 0) {
  failures.push(`${result.transactionInvariantViolations ?? 'unknown'} transaction invariants failed`);
}
if (result.state !== 'ready') failures.push(`connector ended in state ${result.state}`);
if ((result.pool?.ending?.acquired ?? 0) !== 0) failures.push('an acquired connection leaked');
if ((result.pool?.ending?.queued ?? 0) !== 0 || (result.pool?.queuedCalls ?? 0) !== 0) {
  failures.push('database calls remained queued');
}
if ((result.pool?.maximum?.acquired ?? 0) < minimumPoolAcquired) {
  failures.push(
    `pool acquired at most ${result.pool?.maximum?.acquired ?? 0} connections; expected saturation at ${minimumPoolAcquired}`,
  );
}
const growth = Number(result.memory?.finalHalfGrowth ?? Number.POSITIVE_INFINITY);
if (!Number.isFinite(growth) || growth >= 0.10) {
  failures.push(`final-half memory growth ${(growth * 100).toFixed(2)}% is not below 10%`);
}
const reconnects = Number(result.totals?.reconnects ?? 0);
if (reconnects < minimumReconnects) {
  failures.push(`observed ${reconnects} reconnects; expected at least ${minimumReconnects}`);
}

if (failures.length > 0) throw new Error(`Soak gate failed:\n- ${failures.join('\n- ')}`);
console.log(
  `[qbxsql] soak gate passed: ${result.operations} operations, ${reconnects} reconnects, ${(growth * 100).toFixed(2)}% final-half memory growth.`,
);
