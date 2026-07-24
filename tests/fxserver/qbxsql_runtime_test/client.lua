CreateThread(function()
    local version = GetResourceMetadata('oxmysql', 'version', 0)
    local qbxsqlVersion = GetResourceMetadata('qbxsql', 'qbxsql_version', 0)

    if version ~= '2.14.1' then
        print(('QBXSQL_CLIENT_VISIBILITY_FAIL: expected oxmysql 2.14.1, received %s'):format(tostring(version)))
        return
    end
    if qbxsqlVersion ~= '0.3.1' then
        print(('QBXSQL_CLIENT_VISIBILITY_FAIL: expected qbxsql 0.3.1, received %s'):format(tostring(qbxsqlVersion)))
        return
    end

    print('QBXSQL_CLIENT_VISIBILITY_PASS')
end)
