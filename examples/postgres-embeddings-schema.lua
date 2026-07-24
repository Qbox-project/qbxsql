local schema = {
    version = 1,
    extensions = {
        { name = 'vector', minimumVersion = '0.8.5' },
        { name = 'pg_trgm' }
    },
    tables = {
        property_embeddings = {
            columns = {
                id = {
                    type = 'bigint',
                    identity = 'byDefault',
                    primary = true
                },
                label = { type = 'text' },
                embedding = { type = 'vector', dimensions = 1536 },
                metadata = { type = 'jsonb', default = {} }
            },
            indexes = {
                {
                    name = 'property_embeddings_hnsw_idx',
                    method = 'hnsw',
                    columns = {
                        {
                            name = 'embedding',
                            operatorClass = 'vector_cosine_ops'
                        }
                    },
                    options = {
                        m = 16,
                        ef_construction = 64
                    }
                },
                {
                    name = 'property_embeddings_label_trgm_idx',
                    method = 'gin',
                    columns = {
                        {
                            name = 'label',
                            operatorClass = 'gin_trgm_ops'
                        }
                    }
                }
            }
        }
    }
}

Postgres.Schema.ensure.await(schema)

local embedding = Postgres.vector({ 0.12, -0.04, 0.98 })

-- A real resource must provide all 1536 values for this declaration.
-- Postgres.execute.await(
--     'INSERT INTO property_embeddings (label, embedding) VALUES ($1, $2::vector)',
--     { 'Example property', embedding }
-- )

return schema, embedding
