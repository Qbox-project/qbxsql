fx_version 'cerulean'
game 'common'

dependency 'qbxsql'
dependency 'oxmysql'
dependency 'mysql-async'
dependency 'ghmattimysql'

server_scripts {
    '@oxmysql/lib/MySQL.lua',
    '@qbxsql/lib/Schema.lua',
    'server.lua'
}

