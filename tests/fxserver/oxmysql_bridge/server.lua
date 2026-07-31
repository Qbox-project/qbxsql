local qbxsql = exports.qbxsql

local function invokingResource()
    return GetInvokingResource() or 'unknown'
end

local function returnsCallbackErrors(resource)
    for index = 0, GetNumResourceMetadata(resource, 'mysql_option') - 1 do
        if GetResourceMetadata(resource, 'mysql_option', index) == 'return_callback_errors' then
            return true
        end
    end

    return false
end

local callbackMethods = {
    'query',
    'single',
    'scalar',
    'insert',
    'update',
    'prepare',
    'transaction',
    'rawExecute',
    'execute',
    'fetch'
}

-- oxmysql's callback exports take (query, parameters, cb, resource, throwError).
-- Resources that vendor oxmysql's lib/MySQL.lua pass the last two themselves, so
-- dropping them would leave their callback uninvoked on error and hang the
-- awaiting coroutine forever.
local function resourceFor(explicitResource)
    if type(explicitResource) == 'string' and explicitResource ~= '' then
        return explicitResource
    end

    return invokingResource()
end

for _, method in ipairs(callbackMethods) do
    local exportName = method

    exports(exportName, function(query, parameters, callback, explicitResource, returnCallbackErrors)
        local resource = resourceFor(explicitResource)

        if returnCallbackErrors == nil then
            returnCallbackErrors = returnsCallbackErrors(resource)
        end

        return qbxsql[exportName](
            nil,
            query,
            parameters,
            callback,
            resource,
            returnCallbackErrors
        )
    end)

    for _, suffix in ipairs({ '_async', 'Sync' }) do
        local promiseExport = exportName .. suffix

        exports(promiseExport, function(query, parameters, explicitResource)
            return qbxsql[promiseExport](nil, query, parameters, resourceFor(explicitResource))
        end)
    end
end

exports('isReady', function()
    return qbxsql.isReady()
end)

exports('awaitConnection', function()
    return qbxsql.awaitConnection()
end)

exports('getStatus', function(dialect)
    return qbxsql.getStatus(nil, dialect)
end)

exports('getStatuses', function()
    return qbxsql.getStatuses()
end)

exports('store', function(query, callback)
    return qbxsql.store(nil, query, callback)
end)

exports('startTransaction', function(callback, explicitResource)
    return qbxsql.startTransaction(nil, callback, resourceFor(explicitResource))
end)

for _, method in ipairs({
    'isReady_async',
    'isReadySync',
    'awaitConnection_async',
    'awaitConnectionSync',
    'store_async',
    'storeSync',
    'startTransaction_async',
    'startTransactionSync'
}) do
    local exportName = method

    exports(exportName, function(...)
        return qbxsql[exportName](nil, ...)
    end)
end

print('[oxmysql] qbxsql compatibility bridge started')
