import { readFile } from 'node:fs/promises';
import path from 'node:path';

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function result(name) {
  const filename = option(`--${name}`);
  if (!filename) throw new Error(`--${name} <result.json> is required.`);
  return JSON.parse(await readFile(path.resolve(filename), 'utf8'));
}

const qbxsql = await result('qbxsql');
const oxmysql = await result('oxmysql');
const failures = [];

for (const result of [qbxsql, oxmysql]) {
  if (result.failures !== 0) failures.push(`${result.provider} reported ${result.failures} unexplained failures`);
  if ((result.transactionInvariantViolations ?? Number.POSITIVE_INFINITY) !== 0) {
    failures.push(
      `${result.provider} reported ${result.transactionInvariantViolations ?? 'unknown'} transaction invariant violations`,
    );
  }
}
if ((qbxsql.pool?.ending?.acquired ?? 0) !== 0) failures.push('qbxsql leaked acquired pool connections');
if ((qbxsql.pool?.ending?.queued ?? 0) !== 0 || (qbxsql.pool?.queuedCalls ?? 0) !== 0) {
  failures.push('qbxsql ended with queued database calls');
}
if ((qbxsql.pool?.maximum?.acquired ?? 0) < 10) {
  failures.push(`qbxsql did not saturate its 10-connection pool (maximum ${qbxsql.pool?.maximum?.acquired ?? 0})`);
}
if ((qbxsql.memory?.finalHalfGrowth ?? Number.POSITIVE_INFINITY) >= 0.10) {
  failures.push(
    `qbxsql memory grew ${(qbxsql.memory.finalHalfGrowth * 100).toFixed(2)}% during the final half`,
  );
}

for (const percentile of ['median', 'p95']) {
  const baseline = Math.max(1, Number(oxmysql.latency?.[percentile] ?? 0));
  const candidate = Number(qbxsql.latency?.[percentile] ?? Number.POSITIVE_INFINITY);
  if (candidate > baseline * 1.2) {
    failures.push(
      `qbxsql ${percentile} latency ${candidate}ms exceeds 120% of oxmysql ${baseline}ms`,
    );
  }
}

if (failures.length > 0) {
  throw new Error(`Benchmark gate failed:\n- ${failures.join('\n- ')}`);
}

console.log(
  `[qbxsql] benchmark gate passed: qbxsql median/p95 ${qbxsql.latency.median}/${qbxsql.latency.p95}ms; oxmysql ${oxmysql.latency.median}/${oxmysql.latency.p95}ms.`,
);
