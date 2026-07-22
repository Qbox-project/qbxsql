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

_ENV.QBXSQL = QBXSQL

