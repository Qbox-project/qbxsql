print('QBXSQL_REAL_OXMYSQL_STUB_STARTED')

AddEventHandler('onResourceStart', function(resource)
    if resource ~= 'qbxsql_compat' then return end

    CreateThread(function()
        Wait(250)
        local state = GetResourceState('qbxsql_compat')

        -- FXServer may refuse a resource's request to stop itself. Remaining
        -- started is safe here because the conflict path never registers the
        -- compatibility providers; the runner separately requires the loud
        -- diagnostic from qbxsql_compat.
        if state == 'stopped' or state == 'started' then
            print('QBXSQL_COMPAT_CONFLICT_PASS')
        else
            print(('QBXSQL_COMPAT_CONFLICT_FAIL:%s'):format(state))
        end
    end)
end)
