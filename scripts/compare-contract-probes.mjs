import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function probe(name, expectedProvider) {
  const filename = option(`--${name}`);
  if (!filename) throw new Error(`--${name} <result.json> is required.`);
  const result = JSON.parse(await readFile(path.resolve(filename), 'utf8'));
  if (result.provider !== expectedProvider) {
    throw new Error(`${name} result reports provider '${result.provider}', expected '${expectedProvider}'.`);
  }
  if (result.success !== true) throw new Error(`${name} probe failed: ${result.error ?? 'unknown error'}`);
  for (const required of [
    'query',
    'single',
    'scalar',
    'zeroInsert',
    'zeroPreparedInsert',
    'prepareOne',
    'prepareMany',
    'prepareBatch',
    'rawOne',
    'rawMany',
    'rawBatch',
    'failedQuery',
    'failedPrepare',
    'failedTransaction',
  ]) {
    if (!(required in result.result)) throw new Error(`${name} probe omitted '${required}'.`);
  }
  return result.result;
}

const qbxsql = await probe('qbxsql', 'qbxsql');
const oxmysql = await probe('oxmysql', 'oxmysql');

try {
  assert.deepStrictEqual(qbxsql, oxmysql);
} catch (error) {
  throw new Error(`oxmysql 2.14.1 differential contract failed:\n${error.message}`);
}

console.log('[qbxsql] oxmysql 2.14.1 differential contract passed.');
