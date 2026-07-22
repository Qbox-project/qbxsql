local currentResource = GetCurrentResourceName()
local adapter = exports.qbxsql
local storedQueries = {}

local function resolveQuery(query)
    if type(query) == 'number' then
        local stored = storedQueries[query]
        assert(stored, ('Unknown stored query id %s'):format(query))
        return stored
    end

    assert(type(query) == 'string', ('Expected query to be a string, received %s'):format(type(query)))
    return query
end

local function arguments(method, query, parameters, callback)
    if method == 'transaction' then
        assert(type(query) == 'table', 'Transaction queries must be a table')
    else
        query = resolveQuery(query)
    end

    if type(parameters) == 'function' then
        callback = parameters
        parameters = nil
    end

    return query, parameters, callback
end

local function call(method, query, parameters, callback)
    query, parameters, callback = arguments(method, query, parameters, callback)
    return adapter[method](nil, query, parameters, callback, currentResource)
end

local function await(method, query, parameters)
    query, parameters = arguments(method, query, parameters)
    local response = promise.new()

    adapter[method](nil, query, parameters, function(result, err)
        if err then
            response:reject(err)
        else
            response:resolve(result)
        end
    end, currentResource, true)

    return Citizen.Await(response)
end

local MySQL = MySQL or {}

for _, method in ipairs({
    'query',
    'single',
    'scalar',
    'insert',
    'update',
    'prepare',
    'rawExecute',
    'transaction'
}) do
    local methodName = method
    MySQL[methodName] = setmetatable({
        await = function(query, parameters)
            return await(methodName, query, parameters)
        end
    }, {
        __call = function(_, query, parameters, callback)
            return call(methodName, query, parameters, callback)
        end
    })
end

local function store(query, callback)
    assert(type(query) == 'string', 'Stored query must be a string')
    local id = #storedQueries + 1
    storedQueries[id] = query
    if callback then callback(id) end
    return id
end

MySQL.Async = {
    fetchAll = MySQL.query,
    fetchScalar = MySQL.scalar,
    fetchSingle = MySQL.single,
    execute = MySQL.update,
    insert = MySQL.insert,
    transaction = MySQL.transaction,
    prepare = MySQL.prepare,
    store = store
}

MySQL.Sync = {
    fetchAll = MySQL.query.await,
    fetchScalar = MySQL.scalar.await,
    fetchSingle = MySQL.single.await,
    execute = MySQL.update.await,
    insert = MySQL.insert.await,
    transaction = MySQL.transaction.await,
    prepare = MySQL.prepare.await,
    store = store
}

MySQL.ready = setmetatable({
    await = function()
        while not adapter:isReady() do Wait(0) end
        return adapter:awaitConnection()
    end
}, {
    __call = function(_, callback)
        CreateThread(function()
            MySQL.ready.await()
            if callback then callback() end
        end)
    end
})

_ENV.MySQL = MySQL
