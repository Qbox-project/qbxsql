-- Load @qbxsql/lib/Schema.lua before this file in your resource manifest.
QBXSQL.Schema.ensure.await({
    version = 2,
    tables = {
        properties = {
            columns = {
                id = {
                    type = 'bigint',
                    unsigned = true,
                    autoIncrement = true,
                    primary = true
                },
                owner = { type = 'varchar', length = 64 },
                label = { type = 'varchar', length = 100 },
                price = { type = 'int', unsigned = true, default = 0 },
                created_at = {
                    type = 'timestamp',
                    defaultExpression = 'CURRENT_TIMESTAMP'
                }
            },
            indexes = {
                { name = 'properties_owner_idx', columns = { 'owner' } }
            }
        }
    },
    migrations = {
        {
            version = 2,
            name = 'rename property title',
            operations = {
                {
                    type = 'renameColumn',
                    table = 'properties',
                    from = 'title',
                    to = 'label'
                }
            }
        }
    }
})

