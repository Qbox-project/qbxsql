local Await = Citizen.Await
local resourceName = GetCurrentResourceName()
local queryStore = {}
local options = {
    return_callback_errors = false
}

for index = 1, GetNumResourceMetadata(resourceName, 'mysql_option') do
    local option = GetResourceMetadata(resourceName, 'mysql_option', index - 1)

    if option then options[option] = true end
end

local function isCallback(value)
    local valueType = type(value)

    return valueType == 'function'
        or (valueType == 'table' and value.__cfx_functionReference ~= nil)
end

local function resolveStoredQuery(query)
    if type(query) ~= 'number' then return query end

    local stored = queryStore[query]
    assert(stored, 'First argument received invalid query store reference')

    return stored
end

local function safeArgs(query, parameters, callback, transaction)
    query = resolveStoredQuery(query)

    local queryType = type(query)

    if transaction then
        if queryType ~= 'table' then
            error(("First argument expected table, received '%s'"):format(queryType))
        end
    elseif queryType ~= 'string' then
        error(("First argument expected string, received '%s'"):format(queryType))
    end

    if parameters then
        local parametersType = type(parameters)

        if parametersType ~= 'table' and parametersType ~= 'function' then
            error(("Second argument expected table or function, received '%s'"):format(parametersType))
        end

        if isCallback(parameters) then
            callback = parameters
            parameters = nil
        end
    end

    if callback and not isCallback(callback) then
        error(("Third argument expected function, received '%s'"):format(type(callback)))
    end

    return query, parameters, callback
end

local qbxsql = exports.qbxsql

local function await(method, query, parameters)
    local response = promise.new()

    qbxsql[method](nil, query, parameters, function(result, error)
        if error then return response:reject(error) end

        response:resolve(result)
    end, resourceName, true)

    return Await(response)
end

local methodMetatable = {
    __call = function(self, query, parameters, callback)
        query, parameters, callback = safeArgs(
            query,
            parameters,
            callback,
            self.method == 'transaction'
        )

        return qbxsql[self.method](
            nil,
            query,
            parameters,
            callback,
            resourceName,
            options.return_callback_errors
        )
    end
}

local MySQL = setmetatable(MySQL or {}, {
    __index = function(_, method)
        return function(...)
            return qbxsql[method](nil, ...)
        end
    end
})

for _, method in pairs({
    'scalar',
    'single',
    'query',
    'insert',
    'update',
    'prepare',
    'transaction',
    'rawExecute'
}) do
    local methodName = method

    MySQL[methodName] = setmetatable({
        method = methodName,
        await = function(query, parameters)
            query, parameters = safeArgs(
                query,
                parameters,
                nil,
                methodName == 'transaction'
            )

            return await(methodName, query, parameters)
        end
    }, methodMetatable)
end

local aliases = {
    fetchAll = 'query',
    fetchScalar = 'scalar',
    fetchSingle = 'single',
    insert = 'insert',
    execute = 'update',
    transaction = 'transaction',
    prepare = 'prepare'
}

local aliasMetatable = {
    __index = function(self, key)
        local alias = aliases[key]

        if alias then
            local method = MySQL[alias]
            MySQL.Async[key] = method
            MySQL.Sync[key] = method.await
            aliases[key] = nil
        end

        return rawget(self, key)
    end
}

local function store(query, callback)
    assert(type(query) == 'string', 'The SQL Query must be a string')

    local id = #queryStore + 1
    queryStore[id] = query

    -- `callback(id) or id` would swallow a callback that legitimately returns
    -- false or nil and hand back the id instead.
    if callback then return callback(id) end

    return id
end

MySQL.Sync = setmetatable({ store = store }, aliasMetatable)
MySQL.Async = setmetatable({ store = store }, aliasMetatable)

local function onReady(callback)
    qbxsql.awaitConnection()

    if callback then return callback() end

    return true
end

MySQL.ready = setmetatable({ await = onReady }, {
    __call = function(_, callback)
        Citizen.CreateThreadNow(function()
            onReady(callback)
        end)
    end
})

local function startTransaction(callback)
    assert(isCallback(callback), 'Transaction callback must be a function')

    -- CFX awaits a Promise returned across the runtime boundary before handing
    -- control back to Lua, so the direct call already blocks. `.await` is
    -- offered for symmetry with the other methods and with Postgres.lua, and
    -- resolves to the same thing.
    return qbxsql:startTransaction(callback, resourceName)
end

MySQL.startTransaction = setmetatable({ await = startTransaction }, {
    __call = function(_, callback)
        return startTransaction(callback)
    end
})

_ENV.MySQL = MySQL
