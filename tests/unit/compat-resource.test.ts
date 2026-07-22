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

  test('gates compatibility metadata, import paths, aliases, and client visibility in FXServer', async () => {
    const manifest = await fixture('tests/fxserver/qbxsql_runtime_test/fxmanifest.lua');
    const server = await fixture('tests/fxserver/qbxsql_runtime_test/server.lua');
    const client = await fixture('tests/fxserver/qbxsql_runtime_test/client.lua');
    const mysqlAsyncManifest = await fixture(
      'tests/fxserver/mysql_async_import_test/fxmanifest.lua',
    );

    expect(manifest).toContain("dependency 'oxmysql'");
    expect(manifest).toContain("dependency 'mysql-async'");
    expect(manifest).toContain("dependency 'ghmattimysql'");
    expect(manifest).toContain("client_script 'client.lua'");
    expect(server).toContain("GetResourceMetadata('oxmysql', 'version', 0)");
    expect(server).toContain("LoadResourceFile('oxmysql', 'lib/MySQL.lua')");
    expect(server).toContain("LoadResourceFile('mysql-async', 'lib/MySQL.lua')");
    expect(server).toContain('exports.oxmysql:scalar');
    expect(server).toContain("exports['mysql-async']:mysql_fetch_scalar");
    expect(server).toContain('exports.ghmattimysql:execute');
    expect(client).toContain('QBXSQL_CLIENT_VISIBILITY_PASS');
    expect(mysqlAsyncManifest).toContain("'@mysql-async/lib/MySQL.lua'");
  });

  test('gates a core and shim restart while a query is active', async () => {
    const probe = await fixture('tests/fxserver/qbxsql_restart_probe/server.lua');
    const runner = await fixture('scripts/run-fxserver-gate.mjs');

    expect(probe).toContain("exports.qbxsql:query('SELECT SLEEP(1) AS waited'");
    expect(probe).toContain('QBXSQL_RESOURCE_RESTART_PASS');
    expect(runner).toContain("'stop qbxsql_compat\\nstop qbxsql\\nensure qbxsql\\nensure qbxsql_compat\\n'");
    expect(runner).toContain("output.includes('QBXSQL_RESOURCE_RESTART_PASS')");
  });
});
