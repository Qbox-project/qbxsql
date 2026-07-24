local running = false

RegisterCommand('qbxsql_restart_probe_begin', function()
    if running then return end
    running = true

    exports.qbxsql:query('SELECT SLEEP(1) AS waited', {}, function(result, err)
        if err then
            print(('QBXSQL_INFLIGHT_QUERY_INTERRUPTED:%s'):format(tostring(err)))
        else
            print('QBXSQL_INFLIGHT_QUERY_COMPLETED')
        end
    end, GetCurrentResourceName(), true)
    print('QBXSQL_INFLIGHT_QUERY_STARTED')

    CreateThread(function()
        while GetResourceState('qbxsql') == 'started' do Wait(0) end
        while GetResourceState('qbxsql') ~= 'started' do Wait(10) end
        Wait(250)

        local bridgeDeadline = GetGameTimer() + 5000
        while GetResourceState('oxmysql') ~= 'started' and GetGameTimer() < bridgeDeadline do
            Wait(10)
        end
        if GetResourceState('oxmysql') ~= 'started' then
            print(('QBXSQL_RESOURCE_RESTART_FAIL:oxmysql state is %s'):format(GetResourceState('oxmysql')))
            return
        end

        local response = promise.new()
        exports.oxmysql:scalar('SELECT 50 AS value', {}, function(result, err)
            if err then response:reject(err) else response:resolve(result) end
        end)

        local success, value = pcall(Citizen.Await, response)
        if not success or value ~= 50 then
            print(('QBXSQL_RESOURCE_RESTART_FAIL:%s'):format(tostring(value)))
            return
        end

        print('QBXSQL_RESOURCE_RESTART_PASS')
    end)
end, true)
