import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dir, '../..');

async function fixture(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8');
}

describe('qbxsql compatibility resource', () => {
  test('keeps legacy provider declarations out of the honestly versioned core', async () => {
    const manifest = await fixture('fxmanifest.lua');

    expect(manifest).not.toContain("provide 'oxmysql'");
    expect(manifest).not.toContain("provide 'mysql-async'");
    expect(manifest).not.toContain("provide 'ghmattimysql'");
  });

  test('publishes the supported legacy aliases at the oxmysql compatibility version', async () => {
    const manifest = await fixture('qbxsql_compat/fxmanifest.lua');

    expect(manifest).toContain("version '2.14.1'");
    expect(manifest).toContain("dependency 'qbxsql'");
    expect(manifest).toContain("provide 'oxmysql'");
    expect(manifest).toContain("provide 'mysql-async'");
    expect(manifest).toContain("provide 'ghmattimysql'");
    expect(manifest).not.toContain('server_only');
  });

  test('loads the canonical qbxsql wrapper instead of maintaining a second implementation', async () => {
    const loader = await fixture('qbxsql_compat/lib/MySQL.lua');

    expect(loader).toContain("LoadResourceFile('qbxsql', 'lib/MySQL.lua')");
    expect(loader).toContain("load(source, '@@qbxsql/lib/MySQL.lua', 't', _ENV)");
  });

  test('implements the oxmysql Lua wrapper contract', async () => {
    const wrapper = await fixture('lib/MySQL.lua');

    expect(wrapper).toContain("GetNumResourceMetadata(resourceName, 'mysql_option')");
    expect(wrapper).toContain('value.__cfx_functionReference');
    expect(wrapper).toContain('options.return_callback_errors');
    expect(wrapper).toContain("'rawExecute'");
    expect(wrapper).toContain('MySQL.Sync = setmetatable');
    expect(wrapper).toContain('MySQL.Async = setmetatable');
    expect(wrapper).toContain('local MySQL = setmetatable');
    expect(wrapper).toContain('qbxsql.awaitConnection()');
  });

  test('exposes callback and await schema adoption helpers', async () => {
    const wrapper = await fixture('lib/Schema.lua');

    expect(wrapper).toContain("adopt = 'adoptSchema'");
    expect(wrapper).toContain("planAdoption = 'planSchemaAdoption'");
    expect(wrapper).toContain('adoptionAwait(method, schema, baselineVersion)');
  });

  test('rejects a concurrently active real oxmysql resource', async () => {
    const server = await fixture('qbxsql_compat/server.lua');

    expect(server).toContain("resource == 'oxmysql'");
    expect(server).toContain('StopResource(currentResource)');
  });
});
