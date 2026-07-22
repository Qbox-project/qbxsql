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
                enabled = { type = 'boolean', default = true }
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
    QBXSQL.Schema.ensure.await(schema)
    MySQL.update.await('DELETE FROM fxsql_values')

    local insertId = MySQL.insert.await(
        'INSERT INTO fxsql_values (name, enabled) VALUES (@name, @enabled)',
        { name = 'modern', enabled = true }
    )
    assert(type(insertId) == 'number', 'modern insert did not return an id')

    local modern = MySQL.single.await('SELECT name, enabled FROM fxsql_values WHERE id = ?', { insertId })
    assertEqual(modern.name, 'modern', 'modern query')
    assertEqual(modern.enabled, true, 'boolean type conversion')

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

    local prepared = MySQL.prepare.await('SELECT name FROM fxsql_values WHERE id = ?', { insertId })
    assertEqual(prepared, 'modern', 'prepared query')

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
