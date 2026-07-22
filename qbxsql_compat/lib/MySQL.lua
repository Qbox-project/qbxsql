local source = LoadResourceFile('qbxsql', 'lib/MySQL.lua')

assert(source, 'qbxsql_compat could not load qbxsql/lib/MySQL.lua; ensure qbxsql starts first')

local chunk, loadError = load(source, '@@qbxsql/lib/MySQL.lua', 't', _ENV)

assert(chunk, loadError)

return chunk()
