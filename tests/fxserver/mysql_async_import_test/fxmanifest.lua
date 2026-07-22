fx_version 'cerulean'
game 'common'

dependency 'mysql-async'

server_scripts {
    '@mysql-async/lib/MySQL.lua',
    'server.lua'
}
