local currentResource = GetCurrentResourceName()

local function stopForConflict(resource)
    local state = GetResourceState(resource)

    if state ~= 'started' and state ~= 'starting' then return false end

    print(('^1[qbxsql_compat] Refusing to run while the real %s resource is active. Stop and remove the legacy connector before starting qbxsql_compat.^0'):format(resource))

    CreateThread(function()
        Wait(0)
        StopResource(currentResource)
    end)

    return true
end

local function detectInstalledOxmysql()
    for index = 0, GetNumResources() - 1 do
        local resource = GetResourceByFindIndex(index)

        if resource == 'oxmysql' then
            return stopForConflict(resource)
        end
    end

    return false
end

if not detectInstalledOxmysql() then
    AddEventHandler('onResourceStart', function(resource)
        if resource == 'oxmysql' then stopForConflict(resource) end
    end)
end
