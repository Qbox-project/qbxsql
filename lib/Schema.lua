local currentResource = GetCurrentResourceName()
local adapter = exports.qbxsql

local function call(method, schema, callback)
    assert(type(schema) == 'table', 'Schema must be a table')
    return adapter[method](nil, schema, callback, currentResource)
end

local function await(method, schema)
    local response = promise.new()

    call(method, schema, function(result, err)
        if err then
            response:reject(err)
        else
            response:resolve(result)
        end
    end)

    return Citizen.Await(response)
end

local QBXSQL = QBXSQL or {}
QBXSQL.Schema = QBXSQL.Schema or {}

for name, exportName in pairs({ ensure = 'ensureSchema', plan = 'planSchema' }) do
    local method = exportName
    QBXSQL.Schema[name] = setmetatable({
        await = function(schema)
            return await(method, schema)
        end
    }, {
        __call = function(_, schema, callback)
            return call(method, schema, callback)
        end
    })
end

local function adoptionCall(method, schema, baselineVersion, callback)
    assert(type(schema) == 'table', 'Schema must be a table')
    assert(type(baselineVersion) == 'number', 'Adoption baseline must be a number')
    return adapter[method](nil, schema, baselineVersion, callback, currentResource)
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

    return Citizen.Await(response)
end


for name, exportName in pairs({ adopt = 'adoptSchema', planAdoption = 'planSchemaAdoption' }) do
    local method = exportName
    QBXSQL.Schema[name] = setmetatable({
        await = function(schema, baselineVersion)
            return adoptionAwait(method, schema, baselineVersion)
        end
    }, {
        __call = function(_, schema, baselineVersion, callback)
            return adoptionCall(method, schema, baselineVersion, callback)
        end
    })
end

_ENV.QBXSQL = QBXSQL
