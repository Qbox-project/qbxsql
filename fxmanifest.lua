fx_version 'cerulean'
game 'common'

name 'qbxsql'
author 'ChatDisabled'
description 'Database adapter, compatibility layer, and schema manager for FiveM'
version '0.1.0'
license 'MIT'

server_only 'yes'
node_version '22'

server_script 'dist/index.js'

files {
    'lib/*.lua'
}

provide 'oxmysql'
provide 'mysql-async'
provide 'ghmattimysql'

convar_category 'qbxsql' {
    'Configuration',
    {
        { 'Connection string', 'mysql_connection_string', 'CV_STRING', 'mysql://root@127.0.0.1/qbxsql' },
        { 'Slow query warning (ms)', 'qbxsql_slow_query_warning', 'CV_INT', '200' },
        { 'Debug logging', 'qbxsql_debug', 'CV_BOOL', 'false' }
    }
}
