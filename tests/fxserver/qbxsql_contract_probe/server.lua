local provider = GetConvar('qbxsql_contract_provider', 'qbxsql')
local connector = exports[provider]
local resourceName = GetCurrentResourceName()

local function awaitCall(method, query, parameters)
    local response = promise.new()

    connector[method](nil, query, parameters or {}, function(result, err)
        if err then response:reject(err) else response:resolve(result) end
    end, resourceName, true)

    return Citizen.Await(response)
end

local function normalizedError(method, query, parameters)
    local success, err = pcall(awaitCall, method, query, parameters)
    return {
        rejected = not success,
        mentionsProbe = not success and tostring(err):find('qbxsql_contract_missing', 1, true) ~= nil
    }
end

CreateThread(function()
    local success, result = pcall(function()
        awaitCall('query', [[
            CREATE TABLE IF NOT EXISTS qbxsql_contract_values (
                id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
                value INT NOT NULL,
                enabled TINYINT(1) NOT NULL,
                payload BLOB NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ]])
        awaitCall('update', 'TRUNCATE TABLE qbxsql_contract_values')
        local firstId = awaitCall(
            'insert',
            'INSERT INTO qbxsql_contract_values (value, enabled, payload) VALUES (?, ?, ?)',
            { 11, true, string.char(0, 127, 255) }
        )
        awaitCall(
            'insert',
            'INSERT INTO qbxsql_contract_values (value, enabled, payload) VALUES (?, ?, ?)',
            { 22, false, nil }
        )

        return {
            query = awaitCall(
                'query',
                'SELECT value, enabled FROM qbxsql_contract_values ORDER BY id'
            ),
            single = awaitCall(
                'single',
                'SELECT value, enabled FROM qbxsql_contract_values WHERE id = ?',
                { firstId }
            ),
            scalar = awaitCall('scalar', 'SELECT 42 AS value'),
            prepareOne = awaitCall('prepare', 'SELECT 43 AS value'),
            prepareMany = awaitCall(
                'prepare',
                'SELECT value FROM qbxsql_contract_values ORDER BY id'
            ),
            prepareBatch = awaitCall('prepare', 'SELECT ? AS value', {
                { 51 },
                { 52 }
            }),
            rawOne = awaitCall('rawExecute', 'SELECT 53 AS value'),
            rawMany = awaitCall(
                'rawExecute',
                'SELECT value FROM qbxsql_contract_values ORDER BY id'
            ),
            rawBatch = awaitCall('rawExecute', 'SELECT ? AS value', {
                { 61 },
                { 62 }
            }),
            binary = awaitCall(
                'scalar',
                'SELECT payload FROM qbxsql_contract_values WHERE id = ?',
                { firstId }
            ),
            bigint = awaitCall(
                'scalar',
                "SELECT CAST('9007199254740993' AS UNSIGNED) AS value"
            ),
            failedQuery = normalizedError(
                'query',
                'SELECT * FROM qbxsql_contract_missing'
            ),
            failedTransaction = awaitCall('transaction', {
                { query = 'UPDATE qbxsql_contract_values SET value = value + 1 WHERE id = ?', values = { firstId } },
                { query = 'INSERT INTO qbxsql_contract_missing (id) VALUES (1)' }
            })
        }
    end)

    local envelope = {
        provider = provider,
        success = success,
        result = success and result or nil
    }
    if not success then envelope.error = tostring(result) end
    local payload = json.encode(envelope)
    print('QBXSQL_CONTRACT_RESULT_START')
    for index = 1, #payload, 120 do
        print(('QBXSQL_CONTRACT_CHUNK:%s:QBXSQL_CONTRACT_CHUNK_END'):format(
            payload:sub(index, index + 119)
        ))
    end
    print('QBXSQL_CONTRACT_RESULT_END')
end)
