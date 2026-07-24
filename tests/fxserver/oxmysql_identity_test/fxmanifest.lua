fx_version 'cerulean'
game 'common'

dependency 'oxmysql'

server_scripts {
    '@oxmysql/lib/MySQL.lua',
    'server.lua'
}
