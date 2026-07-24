import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dir, '../..');

async function fixture(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8');
}

describe('qbxsql compatibility metadata and providers', () => {
  test('publishes legacy aliases and both version identities from one resource', async () => {
    const manifest = await fixture('fxmanifest.lua');

    expect(manifest).toContain("version '2.14.1'");
    expect(manifest).toContain("qbxsql_version '0.3.1'");
    expect(manifest).toContain("provide 'oxmysql'");
    expect(manifest).toContain("provide 'mysql-async'");
    expect(manifest).toContain("provide 'ghmattimysql'");
    expect(manifest).not.toContain('server_only');
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
    const core = await fixture('src/index.ts');
    const probe = await fixture('tests/fxserver/oxmysql_conflict/server.lua');
    const runner = await fixture('scripts/run-fxserver-gate.mjs');

    expect(core).toContain('isConcreteOxmysqlActive()');
    expect(core).toContain('reportOxmysqlConflict()');
    expect(core).toContain('StopResource(resourceName)');
    expect(probe).toContain('QBXSQL_COMPAT_CONFLICT_PASS');
    expect(runner).toContain('async function runConflictGate()');
    expect(runner).toContain("conflictServer.stdin.write('refresh\\nensure qbxsql\\n')");
    expect(runner).toContain("conflictOutput.includes('QBXSQL_COMPAT_CONFLICT_PASS')");
  });

  test('registers all legacy export routing directly from qbxsql', async () => {
    const core = await fixture('src/index.ts');
    const compatibility = await fixture('src/api/compatibility.ts');

    expect(core).toContain(
      'registerCompatibilityExports(database, undefined, { legacyProviders: true })',
    );
    expect(compatibility).toContain("runtime.addProviderExport('oxmysql'");
    expect(compatibility).toContain("runtime.addProviderExport('mysql-async'");
    expect(compatibility).toContain("runtime.addProviderExport('ghmattimysql'");
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
    expect(server).toContain("GetResourceMetadata('qbxsql', 'qbxsql_version', 0)");
    expect(server).toContain("LoadResourceFile('oxmysql', 'lib/MySQL.lua')");
    expect(server).toContain("LoadResourceFile('mysql-async', 'lib/MySQL.lua')");
    expect(server).toContain('exports.oxmysql:scalar');
    expect(server).toContain("exports['mysql-async']:mysql_fetch_scalar");
    expect(server).toContain('exports.ghmattimysql:execute');
    expect(server).toContain('QBXSQL_SCHEMA_MIGRATION_REQUIRED');
    expect(client).toContain('QBXSQL_CLIENT_VISIBILITY_PASS');
    expect(mysqlAsyncManifest).toContain("'@mysql-async/lib/MySQL.lua'");
  });

  test('gates a qbxsql restart while a query is active', async () => {
    const probe = await fixture('tests/fxserver/qbxsql_restart_probe/server.lua');
    const runner = await fixture('scripts/run-fxserver-gate.mjs');

    expect(probe).toContain("exports.qbxsql:query('SELECT SLEEP(1) AS waited'");
    expect(probe).toContain('QBXSQL_RESOURCE_RESTART_PASS');
    expect(runner).toContain("'stop qbxsql\\nensure qbxsql\\n'");
    expect(runner).toContain("output.includes('QBXSQL_RESOURCE_RESTART_PASS')");
  });
});
