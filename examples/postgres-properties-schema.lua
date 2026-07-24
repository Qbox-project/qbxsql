local schema = {
    version = 1,
    tables = {
        properties = {
            columns = {
                id = {
                    type = 'bigint',
                    identity = 'byDefault',
                    primary = true
                },
                owner = { type = 'uuid', nullable = true },
                label = { type = 'varchar', length = 100 },
                price = { type = 'numeric', precision = 12, scale = 2, default = 0 },
                metadata = { type = 'jsonb', default = {} },
                created_at = {
                    type = 'timestamptz',
                    defaultExpression = 'CURRENT_TIMESTAMP'
                }
            },
            checks = {
                { name = 'properties_price_check', expression = 'price >= 0' }
            },
            indexes = {
                {
                    name = 'properties_owner_idx',
                    columns = { 'owner' },
                    include = { 'label' }
                },
                {
                    name = 'properties_available_idx',
                    columns = { 'price' },
                    where = 'owner IS NULL'
                }
            }
        }
    }
}

local plan = Postgres.Schema.plan.await(schema)
print(('PostgreSQL schema plan contains %d action(s)'):format(#plan.actions))

Postgres.Schema.ensure.await(schema)
