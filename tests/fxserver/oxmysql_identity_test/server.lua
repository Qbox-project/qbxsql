CreateThread(function()
    Wait(250)

    local success, err = pcall(function()
        assert(GetResourceState('oxmysql') == 'started', 'literal oxmysql resource state is not started')
        assert(
            GetResourceMetadata('oxmysql', 'qbxsql_version', 0) == '0.3.2',
            'exact-identity resource omitted qbxsql_version'
        )
        assert(MySQL.scalar.await('SELECT 50 AS value') == 50, '@oxmysql import failed')
        assert(exports.oxmysql:scalarSync('SELECT 51 AS value') == 51, 'oxmysql export failed')
        assert(LoadResourceFile('qbxsql', 'lib/Schema.lua'), 'qbxsql provider file alias failed')
        assert(exports.qbxsql:getStatus().state == 'ready', 'qbxsql provider export alias failed')
    end)

    if not success then
        print(('QBXSQL_OXMYSQL_IDENTITY_FAIL: %s'):format(err))
        error(err)
    end

    print('QBXSQL_OXMYSQL_IDENTITY_PASS')
end)
