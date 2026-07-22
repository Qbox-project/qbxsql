fx_version 'cerulean'
game 'common'

name 'qbxsql_compat'
author 'ChatDisabled'
description 'oxmysql, mysql-async, and ghmattimysql compatibility aliases for qbxsql'
version '2.14.1'
license 'MIT'

dependency 'qbxsql'

server_script 'server.lua'

files {
    'lib/MySQL.lua'
}

provide 'oxmysql'
provide 'mysql-async'
provide 'ghmattimysql'
