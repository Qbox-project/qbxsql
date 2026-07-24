local source = LoadResourceFile('qbxsql', 'lib/MySQL.lua')

assert(source, 'Unable to load qbxsql/lib/MySQL.lua')

local chunk, errorMessage = load(source, '@qbxsql/lib/MySQL.lua', 't', _ENV)

assert(chunk, errorMessage)

return chunk()
