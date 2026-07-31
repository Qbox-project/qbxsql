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

--- Turns any callback-style helper into a blocking call.
---
--- `start` receives the completion callback and is responsible for passing it
--- on; every await form below is one line of this, which keeps the promise
--- plumbing in a single place.
local function awaitCall(start)
    local settled = promise.new()

    start(function(result, err)
        if err then
            settled:reject(err)
        else
            settled:resolve(result)
        end
    end)

    return Await(settled)
end

local function call(method, query, parameters, callback)
    query, parameters, callback = safeArgs(query, parameters, callback)
    return adapter[method](nil, query, parameters, callback, resourceName)
end

-- Connector exports are named postgresQuery, postgresIsReady, and so on.
local function postgresExport(name)
    return 'postgres' .. name:sub(1, 1):upper() .. name:sub(2)
end

local Postgres = setmetatable(Postgres or {}, {
    -- Names not defined below fall through to the matching connector export, so
    -- Postgres.isReady() and anything added later are reachable from the facade
    -- instead of only through exports.qbxsql.
    __index = function(_, name)
        local export = postgresExport(name)

        return function(...)
            return adapter[export](nil, ...)
        end
    end
})

for name, exportName in pairs({
    query = 'postgresQuery',
    single = 'postgresSingle',
    scalar = 'postgresScalar',
    execute = 'postgresExecute'
}) do
    local method = exportName
    Postgres[name] = setmetatable({
        await = function(query, parameters)
            return awaitCall(function(done) return call(method, query, parameters, done) end)
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
        return awaitCall(function(done) return transactionCall(statements, done) end)
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

local function finiteNumber(value, label)
    if type(value) ~= 'number' or value ~= value or value == math.huge or value == -math.huge then
        error(("%s must contain finite numbers"):format(label))
    end
    return value
end

function Postgres.vector(values)
    assert(type(values) == 'table', 'Postgres.vector expects an array')
    local length = #values
    assert(length > 0, 'Postgres.vector expects at least one value')
    local encoded = {}
    for key in pairs(values) do
        if type(key) ~= 'number' or key < 1 or key > length or key % 1 ~= 0 then
            error('Postgres.vector expects a dense numeric array')
        end
    end
    for index = 1, length do
        encoded[index] = tostring(finiteNumber(values[index], 'Postgres.vector'))
    end
    return ('[%s]'):format(table.concat(encoded, ','))
end

Postgres.halfvec = Postgres.vector

function Postgres.sparsevec(dimensions, values)
    assert(type(dimensions) == 'number' and dimensions % 1 == 0 and dimensions > 0,
        'Postgres.sparsevec dimensions must be a positive integer')
    assert(type(values) == 'table', 'Postgres.sparsevec values must be an index/value table')
    local entries = {}
    for index, value in pairs(values) do
        assert(type(index) == 'number' and index % 1 == 0 and index >= 1 and index <= dimensions,
            'Postgres.sparsevec indexes must be integers within dimensions')
        entries[#entries + 1] = { index = index, value = finiteNumber(value, 'Postgres.sparsevec') }
    end
    table.sort(entries, function(left, right)
        return left.index < right.index
    end)
    local encoded = {}
    for index, entry in ipairs(entries) do
        encoded[index] = ('%d:%s'):format(entry.index, tostring(entry.value))
    end
    return ('{%s}/%d'):format(table.concat(encoded, ','), dimensions)
end

local function extensionsCall(callback)
    if callback and not isCallback(callback) then
        error(("First argument expected function, received '%s'"):format(type(callback)))
    end
    return adapter.postgresGetExtensions(nil, callback)
end

Postgres.extensions = setmetatable({
    await = function()
        return awaitCall(extensionsCall)
    end
}, {
    __call = function(_, callback)
        return extensionsCall(callback)
    end
})

local function schemaCall(method, schema, callback)
    assert(type(schema) == 'table', 'Schema must be a table')
    return adapter[method](nil, schema, callback, resourceName)
end

local function schemaAwait(method, schema)
    return awaitCall(function(done) return schemaCall(method, schema, done) end)
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
    return awaitCall(function(done)
        return adoptionCall(method, schema, baselineVersion, done)
    end)
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
