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

for _, method in ipairs(callbackMethods) do
    local exportName = method

    exports(exportName, function(query, parameters, callback)
        local resource = invokingResource()

        return qbxsql[exportName](
            nil,
            query,
            parameters,
            callback,
            resource,
            returnsCallbackErrors(resource)
        )
    end)

    for _, suffix in ipairs({ '_async', 'Sync' }) do
        local promiseExport = exportName .. suffix

        exports(promiseExport, function(query, parameters)
            return qbxsql[promiseExport](nil, query, parameters, invokingResource())
        end)
    end
end

exports('isReady', function()
    return qbxsql.isReady()
end)

exports('awaitConnection', function()
    return qbxsql.awaitConnection()
end)

exports('getStatus', function()
    return qbxsql.getStatus()
end)

exports('store', function(query, callback)
    return qbxsql.store(nil, query, callback)
end)

exports('startTransaction', function(callback)
    return qbxsql.startTransaction(nil, callback, invokingResource())
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
