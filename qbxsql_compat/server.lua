local currentResource = GetCurrentResourceName()
local adapter = exports.qbxsql
local unpack = table.unpack

local function forward(target, resourceArgument)
    return function(...)
        local arguments = table.pack(...)

        if resourceArgument and (type(arguments[resourceArgument]) ~= 'string' or arguments[resourceArgument] == '') then
            arguments[resourceArgument] = GetInvokingResource() or 'unknown'
            arguments.n = math.max(arguments.n, resourceArgument)
        end

        return adapter[target](nil, unpack(arguments, 1, arguments.n))
    end
end

local function provideExport(resource, name, target, resourceArgument)
    AddEventHandler(('__cfx_export_%s_%s'):format(resource, name), function(setCallback)
        setCallback(forward(target, resourceArgument))
    end)
end

local function registerProviders()
    local queryMethods = {
        query = 'query',
        single = 'single',
        scalar = 'scalar',
        insert = 'insert',
        update = 'update',
        prepare = 'prepare',
        rawExecute = 'rawExecute',
        transaction = 'transaction',
        execute = 'execute',
        fetch = 'fetch'
    }

    provideExport('oxmysql', 'isReady', 'isReady')
    provideExport('oxmysql', 'awaitConnection', 'awaitConnection')
    provideExport('oxmysql', 'store', 'store')
    provideExport('oxmysql', 'startTransaction', 'startTransaction', 2)

    for name, target in pairs(queryMethods) do
        provideExport('oxmysql', name, target, 4)
        provideExport('oxmysql', name .. '_async', target .. '_async', 3)
        provideExport('oxmysql', name .. 'Sync', target .. 'Sync', 3)
    end

    for name, target in pairs({
        mysql_fetch_all = 'query',
        mysql_fetch_scalar = 'scalar',
        mysql_execute = 'update',
        mysql_insert = 'insert',
        mysql_transaction = 'transaction',
        mysql_store = 'store'
    }) do
        provideExport('mysql-async', name, target, target == 'store' and nil or 4)
    end

    for name, target in pairs({
        execute = 'query',
        scalar = 'scalar',
        transaction = 'transaction',
        store = 'store'
    }) do
        provideExport('ghmattimysql', name, target, target == 'store' and nil or 4)
        provideExport(
            'ghmattimysql',
            name .. 'Sync',
            target == 'store' and 'store' or target .. 'Sync',
            target == 'store' and nil or 3
        )
    end
end

local function stopForConflict(resource)
    local state = GetResourceState(resource)

    if state ~= 'started' and state ~= 'starting' then return false end

    print(('^1[qbxsql_compat] Refusing to run while the real %s resource is active. Stop and remove the legacy connector before starting qbxsql_compat.^0'):format(resource))

    -- Some runtimes cannot safely stop a resource from its own startup path.
    -- In that case this function still rejects the shim by returning before
    -- registerProviders. Runtime conflicts can be stopped normally.
    if GetResourceState(currentResource) == 'started' then
        CreateThread(function()
            Wait(0)
            StopResource(currentResource)
        end)
    end

    return true
end

local function isInstalled(resource)
    for index = 0, GetNumResources() - 1 do
        if GetResourceByFindIndex(index) == resource then return true end
    end

    return false
end

local function detectInstalledOxmysql()
    return isInstalled('oxmysql') and stopForConflict('oxmysql')
end

if not detectInstalledOxmysql() then
    registerProviders()
    AddEventHandler('onResourceStart', function(resource)
        if resource == 'oxmysql' then stopForConflict(resource) end
    end)
    AddEventHandler('onResourceStop', function(resource)
        -- FXServer stops a providing resource before it starts the concrete
        -- resource with the same name, so onResourceStart is too late to emit
        -- our own actionable diagnostic in that transition.
        if resource == currentResource and isInstalled('oxmysql') then
            print('^1[qbxsql_compat] Refusing to run while the real oxmysql resource is active. Stop and remove the legacy connector before starting qbxsql_compat.^0')
        end
    end)
end
