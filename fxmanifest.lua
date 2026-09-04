fx_version 'cerulean'
game 'common'

name 'qbxsql'
author 'ChatDisabled'
description 'Database connector and declarative schema manager for FiveM'
version '2.14.1'
qbxsql_version '0.6.0'
license 'MIT'

node_version '22'

server_script 'dist/index.js'

files {
    'lib/*.lua'
}

provide 'oxmysql'
provide 'mysql-async'
provide 'ghmattimysql'
