local schema = {
    version = 1,
    tables = {
        fxsql_values = {
            columns = {
                id = {
                    type = 'bigint',
                    unsigned = true,
                    autoIncrement = true,
                    primary = true
                },
                name = { type = 'varchar', length = 100 },
                enabled = { type = 'boolean', default = true },
                payload = { type = 'blob', nullable = true }
            },
            indexes = {
                { name = 'fxsql_values_name_idx', columns = { 'name' } }
            }
        }
    }
}

local function callbackAwait(invoke)
    local response = promise.new()
    invoke(function(result, err)
        if err then response:reject(err) else response:resolve(result) end
    end)
    return Citizen.Await(response)
end

local function assertEqual(actual, expected, label)
    if actual ~= expected then
        error(('%s: expected %s, received %s'):format(label, tostring(expected), tostring(actual)))
    end
end

local function runTests()
    assertEqual(GetResourceState('qbxsql'), 'started', 'qbxsql resource state')
    assertEqual(GetResourceMetadata('oxmysql', 'version', 0), '2.14.1', 'oxmysql compatibility version')
    assertEqual(GetResourceMetadata('qbxsql', 'qbxsql_version', 0), '0.3.2', 'qbxsql version')
    assert(LoadResourceFile('oxmysql', 'lib/MySQL.lua'), '@oxmysql/lib/MySQL.lua did not resolve')
    assert(LoadResourceFile('mysql-async', 'lib/MySQL.lua'), '@mysql-async/lib/MySQL.lua did not resolve')

    local status = exports.qbxsql:getStatus()
    assertEqual(status.state, 'ready', 'native health state')
    assert(status.databaseVersion, 'native health status omitted database version')
    assert(status.totals and type(status.totals.queries) == 'number', 'native health totals are invalid')

    QBXSQL.Schema.ensure.await(schema)

    local narrowingSchema = json.decode(json.encode(schema))
    narrowingSchema.tables.fxsql_values.columns.name.length = 50
    local schemaFailure = promise.new()
    QBXSQL.Schema.ensure(narrowingSchema, function(result, err)
        schemaFailure:resolve({ result = result, err = err })
    end)
    local blockedSchema = Citizen.Await(schemaFailure)
    assertEqual(blockedSchema.result, nil, 'blocked schema result')
    assert(type(blockedSchema.err) == 'table', 'blocked schema error was not structured')
    assertEqual(
        blockedSchema.err.code,
        'QBXSQL_SCHEMA_MIGRATION_REQUIRED',
        'blocked schema error code'
    )
    assert(
        blockedSchema.err.plan and #blockedSchema.err.plan.actions > 0,
        'blocked schema error omitted its migration plan'
    )
    local awaitSuccess, awaitFailure = pcall(QBXSQL.Schema.ensure.await, narrowingSchema)
    assertEqual(awaitSuccess, false, 'blocked schema await success')
    assert(type(awaitFailure) == 'table', 'blocked schema await error was not structured')
    assertEqual(
        awaitFailure.code,
        'QBXSQL_SCHEMA_MIGRATION_REQUIRED',
        'blocked schema await error code'
    )
    assert(
        awaitFailure.plan and #awaitFailure.plan.actions > 0,
        'blocked schema await error omitted its migration plan'
    )

    MySQL.update.await('DELETE FROM fxsql_values')

    local insertId = MySQL.insert.await(
        'INSERT INTO fxsql_values (name, enabled, payload) VALUES (@name, @enabled, @payload)',
        { name = 'modern', enabled = true, payload = nil }
    )
    assert(type(insertId) == 'number', 'modern insert did not return an id')

    local modern = MySQL.single.await('SELECT name, enabled, payload FROM fxsql_values WHERE id = ?', { insertId })
    assertEqual(modern.name, 'modern', 'modern query')
    assertEqual(modern.enabled, true, 'boolean type conversion')
    assertEqual(type(modern.payload), 'table', 'NULL binary BLOB query conversion')

    MySQL.update.await('UPDATE fxsql_values SET enabled = 2 WHERE id = ?', { insertId })
    assertEqual(
        MySQL.scalar.await('SELECT enabled FROM fxsql_values WHERE id = ?', { insertId }),
        false,
        'legacy non-boolean query conversion'
    )
    local preparedTypes = MySQL.prepare.await(
        'SELECT enabled, payload FROM fxsql_values WHERE id = ?',
        { insertId }
    )
    assertEqual(preparedTypes.enabled, 2, 'prepared TINYINT native conversion')
    assertEqual(preparedTypes.payload, nil, 'prepared NULL BLOB conversion')

    local oxScalar = callbackAwait(function(callback)
        exports.oxmysql:scalar('SELECT 41 + 1 AS value', {}, callback)
    end)
    assertEqual(oxScalar, 42, 'oxmysql scalar export')

    local asyncScalar = callbackAwait(function(callback)
        exports['mysql-async']:mysql_fetch_scalar('SELECT @value AS value', { ['@value'] = 43 }, callback)
    end)
    assertEqual(asyncScalar, 43, 'mysql-async scalar export')

    local legacyAsyncScalar = callbackAwait(function(callback)
        MySQL.Async.fetchScalar('SELECT 45 AS value', {}, callback)
    end)
    assertEqual(legacyAsyncScalar, 45, 'MySQL.Async compatibility')
    assertEqual(MySQL.Sync.fetchScalar('SELECT 46 AS value'), 46, 'MySQL.Sync compatibility')
    assertEqual(MySQL.scalar.await('SELECT 49 AS value', { 999 }), 49, 'unused parameter compatibility')

    local ghmattiRows = callbackAwait(function(callback)
        exports.ghmattimysql:execute('SELECT 44 AS value', {}, callback)
    end)
    assertEqual(ghmattiRows[1].value, 44, 'ghmattimysql execute export')
    assertEqual(
        exports.ghmattimysql:scalarSync('SELECT 47 AS value', {}),
        47,
        'ghmattimysql synchronous export'
    )

    local transaction = MySQL.transaction.await({
        'INSERT INTO fxsql_values (name, enabled) VALUES (@name, true)',
        'UPDATE fxsql_values SET enabled = false WHERE name = @name'
    }, { name = 'transaction' })
    assertEqual(transaction, true, 'transaction result')
    assertEqual(
        MySQL.scalar.await('SELECT enabled FROM fxsql_values WHERE name = ?', { 'transaction' }),
        false,
        'transaction contents'
    )

    local tupleTransaction = MySQL.transaction.await({
        {
            'UPDATE fxsql_values SET enabled = ? WHERE name = ?',
            { true, 'transaction' }
        }
    })
    assertEqual(tupleTransaction, true, 'tuple transaction result')

    local prepared = MySQL.prepare.await('SELECT name FROM fxsql_values WHERE id = ?', { insertId })
    assertEqual(prepared, 'modern', 'prepared query')

    local batch = MySQL.rawExecute.await(
        'SELECT ? AS value UNION ALL SELECT ? AS value',
        { { 1, 2 }, { 3, 4 } }
    )
    assertEqual(#batch, 4, 'raw execute multi-row batch flattening')
    assertEqual(batch[4].value, 4, 'raw execute batch contents')

    local callbackTransaction = MySQL.startTransaction(function(query)
        local rows = query('SELECT 48 AS value')
        assertEqual(rows[1].value, 48, 'callback transaction query')
        query('INSERT INTO fxsql_values (name, enabled) VALUES (?, ?)', { 'callback transaction', true })
        return true
    end)
    assertEqual(callbackTransaction, true, 'callback transaction result')

    print('QBXSQL_RUNTIME_TEST_PASS')
end

RegisterCommand('qbxsql_runtime_test', function()
    local success, err = pcall(runTests)
    if not success then
        print(('QBXSQL_RUNTIME_TEST_FAIL: %s'):format(err))
        error(err)
    end
end, true)

CreateThread(function()
    Wait(250)
    ExecuteCommand('qbxsql_runtime_test')
end)
