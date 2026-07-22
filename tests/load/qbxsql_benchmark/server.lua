local provider = GetConvar('qbxsql_benchmark_provider', 'qbxsql')
local duration = GetConvarInt('qbxsql_benchmark_duration', 3600000)
local workers = GetConvarInt('qbxsql_benchmark_workers', 100)
local seed = GetConvarInt('qbxsql_benchmark_seed', 81473)
local connector = exports[provider]
local resourceName = GetCurrentResourceName()
local histogram = {}
local operations = 0
local failures = 0
local expectedReconnectFailures = 0
local errorSamples = {}
local outage = false
local activeWorkers = workers
local maximumPool = { acquired = 0, queued = 0 }

if provider == 'qbxsql' then
    AddEventHandler('qbxsql:disconnected', function()
        outage = true
    end)
    AddEventHandler('qbxsql:reconnected', function()
        outage = false
    end)
end

local function awaitCall(method, query, parameters)
    local response = promise.new()

    connector[method](nil, query, parameters or {}, function(result, err)
        if err then response:reject(err) else response:resolve(result) end
    end, resourceName, true)

    return Citizen.Await(response)
end

local function snapshot()
    if provider == 'qbxsql' then
        local status = exports.qbxsql:getStatus()
        return {
            memory = status.memory,
            pool = status.pool,
            totals = status.totals,
            queuedCalls = status.queuedCalls,
            state = status.state
        }
    end

    return {
        memory = { heapUsed = math.floor(collectgarbage('count') * 1024) },
        pool = { acquired = 0, queued = 0 },
        totals = {},
        queuedCalls = 0,
        state = 'ready'
    }
end

local function observe(milliseconds)
    local bucket = math.min(60000, math.max(0, math.ceil(milliseconds)))
    histogram[bucket] = (histogram[bucket] or 0) + 1
end

local function percentile(percent)
    if operations == 0 then return 0 end
    local target = math.ceil(operations * percent)
    local cumulative = 0

    for bucket = 0, 60000 do
        cumulative = cumulative + (histogram[bucket] or 0)
        if cumulative >= target then return bucket end
    end

    return 60000
end

local function operation(worker, iteration)
    local choice = (seed + worker * 31 + iteration * 17) % 100

    if choice < 45 then
        return awaitCall('scalar', 'SELECT ? + ? AS value', { worker, iteration })
    elseif choice < 65 then
        return awaitCall(
            'query',
            'SELECT id, value FROM qbxsql_benchmark_values WHERE id = ?',
            { worker }
        )
    elseif choice < 80 then
        return awaitCall(
            'update',
            'UPDATE qbxsql_benchmark_values SET value = value + 1 WHERE id = ?',
            { worker }
        )
    elseif choice < 90 then
        return awaitCall('prepare', 'SELECT ? AS value', {
            { iteration },
            { iteration + 1 },
            { iteration + 2 },
            { iteration + 3 }
        })
    end

    local result = awaitCall('transaction', {
        {
            query = 'UPDATE qbxsql_benchmark_values SET value = value + 1 WHERE id = ?',
            values = { worker }
        },
        {
            query = 'UPDATE qbxsql_benchmark_values SET value = value - 1 WHERE id = ?',
            values = { worker }
        }
    }, {})
    if result ~= true then error('transaction resolved false') end
    return result
end

CreateThread(function()
    awaitCall('query', [[
        CREATE TABLE IF NOT EXISTS qbxsql_benchmark_values (
            id INT NOT NULL PRIMARY KEY,
            value BIGINT NOT NULL DEFAULT 0,
            payload VARCHAR(100) NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ]])
    awaitCall('update', 'TRUNCATE TABLE qbxsql_benchmark_values')
    local started = GetGameTimer()
    local deadline = started + duration
    local startSnapshot = snapshot()
    local midpointSnapshot
    local completion = promise.new()

    CreateThread(function()
        Wait(math.floor(duration / 2))
        midpointSnapshot = snapshot()
    end)

    CreateThread(function()
        while activeWorkers > 0 do
            Wait(1000)
            local current = snapshot()
            maximumPool.acquired = math.max(maximumPool.acquired, current.pool.acquired or 0)
            maximumPool.queued = math.max(maximumPool.queued, current.pool.queued or 0)
        end
    end)

    for worker = 1, workers do
        CreateThread(function()
            awaitCall(
                'insert',
                'INSERT INTO qbxsql_benchmark_values (id, value, payload) VALUES (?, 0, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload)',
                { worker, ('worker-%d'):format(worker) }
            )
            local iteration = 0

            while GetGameTimer() < deadline do
                iteration = iteration + 1
                local before = GetGameTimer()
                local success, err = pcall(operation, worker, iteration)
                observe(GetGameTimer() - before)
                operations = operations + 1

                if not success then
                    if outage then
                        expectedReconnectFailures = expectedReconnectFailures + 1
                    else
                        failures = failures + 1
                    end
                    if #errorSamples < 10 then errorSamples[#errorSamples + 1] = tostring(err) end
                end
            end

            activeWorkers = activeWorkers - 1
            if activeWorkers == 0 then completion:resolve() end
        end)
    end

    Citizen.Await(completion)
    Wait(100)
    local ending = snapshot()
    midpointSnapshot = midpointSnapshot or startSnapshot
    local midpointHeap = midpointSnapshot.memory.heapUsed or 0
    local finalHeap = ending.memory.heapUsed or 0
    local memoryGrowth = midpointHeap > 0 and ((finalHeap - midpointHeap) / midpointHeap) or 0
    local result = {
        provider = provider,
        durationMs = GetGameTimer() - started,
        workers = workers,
        seed = seed,
        operations = operations,
        failures = failures,
        expectedReconnectFailures = expectedReconnectFailures,
        errors = errorSamples,
        latency = {
            median = percentile(0.50),
            p95 = percentile(0.95),
            p99 = percentile(0.99)
        },
        memory = {
            start = startSnapshot.memory,
            midpoint = midpointSnapshot.memory,
            ending = ending.memory,
            finalHalfGrowth = memoryGrowth
        },
        pool = {
            maximum = maximumPool,
            ending = ending.pool,
            queuedCalls = ending.queuedCalls
        },
        totals = ending.totals,
        state = ending.state
    }

    local encoded = json.encode(result)
    print('QBXSQL_BENCHMARK_RESULT_START')
    for index = 1, #encoded, 120 do
        print(('QBXSQL_BENCHMARK_CHUNK:%s:QBXSQL_BENCHMARK_CHUNK_END'):format(
            encoded:sub(index, index + 119)
        ))
    end
    print('QBXSQL_BENCHMARK_RESULT_END')
end)
