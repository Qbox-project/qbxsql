local resourceName = GetCurrentResourceName()
local evidenceFile = 'canary.jsonl'
local interval = math.max(GetConvarInt('qbxsql_canary_interval', 600000), 60000)

local function status()
    local ok, result = pcall(function()
        return exports.qbxsql:getStatus()
    end)

    if ok then return result end
    return { state = 'unavailable', error = tostring(result) }
end

local function append(recordType, fields)
    local record = fields or {}
    record.type = recordType
    record.recordedAt = os.date('!%Y-%m-%dT%H:%M:%SZ')

    local existing = LoadResourceFile(resourceName, evidenceFile) or ''
    local encoded = json.encode(record)
    SaveResourceFile(resourceName, evidenceFile, existing .. encoded .. '\n', -1)
end

append('start', {
    qbxsqlVersion = GetResourceMetadata('qbxsql', 'version', 0),
    compatibilityTarget = GetResourceMetadata('qbxsql_compat', 'version', 0),
    intervalMs = interval,
    status = status()
})

for _, event in ipairs({ 'ready', 'disconnected', 'reconnected' }) do
    AddEventHandler(('qbxsql:%s'):format(event), function(eventStatus)
        append('lifecycle', { event = event, status = eventStatus })
    end)
end

RegisterCommand('qbxsql_canary_checkpoint', function(source, arguments)
    if source ~= 0 then return end

    local label = table.concat(arguments, ' '):match('^%s*(.-)%s*$')
    if label == '' or #label > 120 then
        print('[qbxsql_canary] Usage: qbxsql_canary_checkpoint <1-120 character label>')
        return
    end

    append('checkpoint', { label = label, status = status() })
    print(('[qbxsql_canary] Recorded checkpoint: %s'):format(label))
end, false)

RegisterCommand('qbxsql_canary_finish', function(source)
    if source ~= 0 then return end

    append('finish', { status = status() })
    print(('[qbxsql_canary] Finalized %s/%s; validate it before promotion.'):format(resourceName, evidenceFile))
end, false)

CreateThread(function()
    while true do
        append('sample', { status = status() })
        Wait(interval)
    end
end)
