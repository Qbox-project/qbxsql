fx_version 'cerulean'
game 'common'

name 'oxmysql'
author 'qbxsql'
description 'Physical oxmysql compatibility bridge backed by qbxsql'
version '2.14.1'

qbxsql_bridge 'true'

dependency 'qbxsql'

files {
    'lib/MySQL.lua'
}

server_script 'server.lua'
