local Await = Citizen.Await
local resourceName = GetCurrentResourceName()
local adapter = exports.qbxsql

local function isCallback(value)
    local valueType = type(value)

    return valueType == 'function'
        or (valueType == 'table' and value.__cfx_functionReference ~= nil)
end

local function safeArgs(query, parameters, callback)
    if type(query) ~= 'string' then
        error(("First argument expected string, received '%s'"):format(type(query)))
    end

    if parameters ~= nil then
        if isCallback(parameters) then
            callback = parameters
            parameters = nil
        elseif type(parameters) ~= 'table' then
            error(("Second argument expected table or function, received '%s'"):format(type(parameters)))
        end
    end

    if callback and not isCallback(callback) then
        error(("Third argument expected function, received '%s'"):format(type(callback)))
    end

    return query, parameters, callback
end

local function call(method, query, parameters, callback)
    query, parameters, callback = safeArgs(query, parameters, callback)
    return adapter[method](nil, query, parameters, callback, resourceName)
end

local function awaitQuery(method, query, parameters)
    local response = promise.new()

    call(method, query, parameters, function(result, err)
        if err then
            response:reject(err)
        else
            response:resolve(result)
        end
    end)

    return Await(response)
end

local Postgres = Postgres or {}

for name, exportName in pairs({
    query = 'postgresQuery',
    single = 'postgresSingle',
    scalar = 'postgresScalar',
    execute = 'postgresExecute'
}) do
    local method = exportName
    Postgres[name] = setmetatable({
        await = function(query, parameters)
            return awaitQuery(method, query, parameters)
        end
    }, {
        __call = function(_, query, parameters, callback)
            return call(method, query, parameters, callback)
        end
    })
end

local function transactionCall(statements, callback)
    assert(type(statements) == 'table', 'Transaction statements must be a table')
    if callback and not isCallback(callback) then
        error(("Second argument expected function, received '%s'"):format(type(callback)))
    end
    return adapter.postgresTransaction(nil, statements, callback, resourceName)
end

Postgres.transaction = setmetatable({
    await = function(statements)
        local response = promise.new()
        transactionCall(statements, function(result, err)
            if err then
                response:reject(err)
            else
                response:resolve(result)
            end
        end)
        return Await(response)
    end
}, {
    __call = function(_, statements, callback)
        return transactionCall(statements, callback)
    end
})

local function startTransaction(callback)
    assert(isCallback(callback), 'Transaction callback must be a function')
    -- CFX awaits a Promise returned by a cross-runtime export before returning
    -- to Lua, matching oxmysql's callback-transaction behavior.
    return adapter.postgresStartTransaction(nil, callback, resourceName)
end

Postgres.startTransaction = setmetatable({ await = startTransaction }, {
    __call = function(_, callback)
        return startTransaction(callback)
    end
})

local function onReady(callback)
    adapter.postgresAwaitConnection()
    return callback and callback() or true
end

Postgres.ready = setmetatable({ await = onReady }, {
    __call = function(_, callback)
        Citizen.CreateThreadNow(function()
            onReady(callback)
        end)
    end
})

local function schemaCall(method, schema, callback)
    assert(type(schema) == 'table', 'Schema must be a table')
    return adapter[method](nil, schema, callback, resourceName)
end

local function schemaAwait(method, schema)
    local response = promise.new()
    schemaCall(method, schema, function(result, err)
        if err then
            response:reject(err)
        else
            response:resolve(result)
        end
    end)
    return Await(response)
end

Postgres.Schema = Postgres.Schema or {}

for name, exportName in pairs({
    ensure = 'postgresEnsureSchema',
    plan = 'postgresPlanSchema'
}) do
    local method = exportName
    Postgres.Schema[name] = setmetatable({
        await = function(schema)
            return schemaAwait(method, schema)
        end
    }, {
        __call = function(_, schema, callback)
            return schemaCall(method, schema, callback)
        end
    })
end

local function adoptionCall(method, schema, baselineVersion, callback)
    assert(type(schema) == 'table', 'Schema must be a table')
    assert(type(baselineVersion) == 'number', 'Adoption baseline must be a number')
    return adapter[method](nil, schema, baselineVersion, callback, resourceName)
end

local function adoptionAwait(method, schema, baselineVersion)
    local response = promise.new()
    adoptionCall(method, schema, baselineVersion, function(result, err)
        if err then
            response:reject(err)
        else
            response:resolve(result)
        end
    end)
    return Await(response)
end

for name, exportName in pairs({
    adopt = 'postgresAdoptSchema',
    planAdoption = 'postgresPlanSchemaAdoption'
}) do
    local method = exportName
    Postgres.Schema[name] = setmetatable({
        await = function(schema, baselineVersion)
            return adoptionAwait(method, schema, baselineVersion)
        end
    }, {
        __call = function(_, schema, baselineVersion, callback)
            return adoptionCall(method, schema, baselineVersion, callback)
        end
    })
end

_ENV.Postgres = Postgres
