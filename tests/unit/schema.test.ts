import { describe, expect, test } from 'bun:test';
import {
  columnSql,
  createTableSql,
  migrationOperationSql,
  onlineMigrationOperationSql,
} from '../../src/schema/sql.js';
import { migrationActions } from '../../src/schema/manager.js';
import { capabilitiesForVersion } from '../../src/schema/planner.js';
import { schemaChecksum, validateSchema } from '../../src/schema/validate.js';
import type { ResourceSchema } from '../../src/schema/types.js';

function exampleSchema(length = 100): ResourceSchema {
  return {
    version: 2,
    tables: {
      properties: {
        columns: {
          id: { type: 'bigint', unsigned: true, autoIncrement: true, primary: true },
          owner: { type: 'varchar', length: 64 },
          label: { type: 'varchar', length, default: 'Home' },
          enabled: { type: 'boolean', default: true },
        },
        indexes: [{ name: 'properties_owner_idx', columns: ['owner'] }],
      },
    },
    migrations: [
      {
        version: 2,
        name: 'rename property title',
        operations: [{ type: 'renameColumn', table: 'properties', from: 'title', to: 'label' }],
      },
    ],
  };
}

describe('schema validation and SQL generation', () => {
  test('validates a declarative resource schema', () => {
    expect(validateSchema(exampleSchema())).toEqual(exampleSchema());
  });

  test('rejects unsafe identifiers and invalid definitions', () => {
    const schema = exampleSchema();
    schema.tables['properties; DROP TABLE users'] = schema.tables.properties!;
    expect(() => validateSchema(schema)).toThrow('Invalid table name');

    expect(() =>
      validateSchema({
        version: 1,
        tables: { bad: { columns: { value: { type: 'varchar', length: 0 } } } },
      }),
    ).toThrow('requires a length');

    expect(() =>
      validateSchema({
        version: 1,
        tables: {
          bad: {
            columns: {
              value: { type: 'varchar', length: 10, default: { nested: true } as unknown as string },
            },
          },
        },
      }),
    ).toThrow('default must be a string, number, boolean, or null');
  });

  test('rejects DDL injection through table options and referential actions', () => {
    const withEngine = exampleSchema();
    withEngine.tables.properties!.engine = 'InnoDB, DROP COLUMN owner' as 'InnoDB';
    expect(() => validateSchema(withEngine)).toThrow('invalid engine');

    const withCharset = exampleSchema();
    withCharset.tables.properties!.charset = 'utf8mb4, DROP COLUMN owner' as 'utf8mb4';
    expect(() => validateSchema(withCharset)).toThrow('invalid charset');

    const withForeignKey = exampleSchema();
    withForeignKey.tables.properties!.foreignKeys = [
      {
        name: 'properties_owner_fk',
        columns: ['owner'],
        references: { table: 'users', columns: ['identifier'] },
        onDelete: 'CASCADE, ADD COLUMN backdoor TEXT' as 'CASCADE',
      },
    ];
    expect(() => validateSchema(withForeignKey)).toThrow('onDelete must be one of');

    const options = exampleSchema();
    options.migrations = [
      {
        version: 2,
        name: 'unsafe options',
        operations: [
          { type: 'setTableOptions', table: 'properties', engine: 'InnoDB, DROP COLUMN owner' as 'InnoDB' },
        ],
      },
    ];
    expect(() => validateSchema(options)).toThrow('invalid engine');
  });

  test('canonicalizes referential action casing so generated DDL is fixed text', () => {
    const schema = exampleSchema();
    schema.tables.properties!.foreignKeys = [
      {
        name: 'properties_owner_fk',
        columns: ['owner'],
        references: { table: 'users', columns: ['identifier'] },
        onDelete: 'cascade' as 'CASCADE',
        onUpdate: 'set  null' as 'SET NULL',
      },
    ];
    const validated = validateSchema(schema);
    expect(validated.tables.properties!.foreignKeys![0]!.onDelete).toBe('CASCADE');
    expect(validated.tables.properties!.foreignKeys![0]!.onUpdate).toBe('SET NULL');
  });

  test('produces stable checksums independent of object key order', () => {
    const first = exampleSchema();
    const second: ResourceSchema = {
      migrations: first.migrations!,
      tables: first.tables,
      version: first.version,
    };
    expect(schemaChecksum(first)).toBe(schemaChecksum(second));
    expect(schemaChecksum(exampleSchema(50))).not.toBe(schemaChecksum(first));
  });

  test('generates complete table and column SQL', () => {
    expect(columnSql('enabled', { type: 'boolean', default: true })).toBe(
      '`enabled` TINYINT(1) NOT NULL DEFAULT 1',
    );
    const sql = createTableSql('properties', exampleSchema().tables.properties!);
    expect(sql).toContain('CREATE TABLE `properties`');
    expect(sql).toContain('`label` VARCHAR(100) NOT NULL DEFAULT \'Home\'');
    expect(sql).toContain('PRIMARY KEY (`id`)');
    expect(sql).toContain('KEY `properties_owner_idx` (`owner`)');
  });

  test('generates explicit destructive migration SQL', () => {
    expect(
      migrationOperationSql({
        type: 'dropColumn',
        table: 'properties',
        column: 'legacy',
        allowDataLoss: true,
      }),
    ).toBe('ALTER TABLE `properties` DROP COLUMN `legacy`');
    expect(
      onlineMigrationOperationSql({
        type: 'addColumn',
        table: 'properties',
        column: 'notes',
        definition: { type: 'text', nullable: true },
      }),
    ).toBe('ALTER TABLE `properties` ADD COLUMN `notes` TEXT NULL, ALGORITHM=INSTANT');
  });

  test('generates structured constraint and table-option migrations', () => {
    expect(
      migrationOperationSql({
        type: 'addForeignKey',
        table: 'properties',
        definition: {
          name: 'properties_owner_fk',
          columns: ['owner_id'],
          references: { table: 'players', columns: ['id'] },
        },
      }),
    ).toContain('ADD CONSTRAINT `properties_owner_fk`');
    expect(
      migrationOperationSql({ type: 'setPrimaryKey', table: 'properties', columns: ['id'] }),
    ).toContain('DROP PRIMARY KEY, ADD PRIMARY KEY (`id`)');
    expect(
      migrationOperationSql({
        type: 'setTableOptions',
        table: 'properties',
        engine: 'InnoDB',
        charset: 'utf8mb4',
      }),
    ).toContain('ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4');
    expect(
      onlineMigrationOperationSql({
        type: 'addIndex',
        table: 'properties',
        definition: { name: 'properties_owner_idx', columns: ['owner_id'] },
      }),
    ).toContain('ALGORITHM=INPLACE, LOCK=NONE');
  });

  test('requires both migration and operator approval for opaque DDL', () => {
    const migration = {
      version: 2,
      name: 'opaque ddl',
      allowBlocking: true,
      operations: [
        {
          type: 'sql' as const,
          sql: 'OPTIMIZE TABLE `properties`',
          allowDataLoss: true as const,
        },
      ],
    };

    expect(migrationActions([migration], false)[0]).toMatchObject({
      automatic: false,
      onlineSafe: false,
      algorithm: 'MANUAL',
    });
    expect(migrationActions([migration], true)[0]).toMatchObject({
      automatic: true,
      onlineSafe: false,
      algorithm: 'MANUAL',
    });
  });

  test('requires blocking approval for table rename and deletion', () => {
    const migration = {
      version: 3,
      name: 'replace a legacy table',
      allowBlocking: true,
      operations: [
        { type: 'renameTable' as const, from: 'properties', to: 'properties_archive' },
        { type: 'dropTable' as const, table: 'properties_archive', allowDataLoss: true as const },
      ],
    };

    expect(migrationActions([migration], false)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'migration:renameTable', automatic: false }),
        expect.objectContaining({ kind: 'migration:dropTable', automatic: false }),
      ]),
    );
    expect(migrationActions([migration], true)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'migration:renameTable', automatic: true }),
        expect.objectContaining({ kind: 'migration:dropTable', automatic: true }),
      ]),
    );
  });

  test('emits only online-DDL hints InnoDB accepts', () => {
    // DROP COLUMN is instant only on MySQL 8.0.29+, and InnoDB has no online
    // path for dropping a primary key by itself.
    expect(
      onlineMigrationOperationSql({
        type: 'dropColumn',
        table: 'properties',
        column: 'money',
        allowDataLoss: true,
      }),
    ).toBe('ALTER TABLE `properties` DROP COLUMN `money`, ALGORITHM=INPLACE, LOCK=NONE');
    expect(
      onlineMigrationOperationSql({ type: 'dropPrimaryKey', table: 'properties' }),
    ).toBe('ALTER TABLE `properties` DROP PRIMARY KEY');
  });

  test('omits online hints when the server version is unknown', () => {
    const capabilities = capabilitiesForVersion(null);
    expect(
      onlineMigrationOperationSql(
        { type: 'addColumn', table: 'properties', column: 'note', definition: { type: 'text' } },
        capabilities,
      ),
    ).toBe('ALTER TABLE `properties` ADD COLUMN `note` TEXT NOT NULL');
  });

  test('plans the setPrimaryKey statement that will actually run', () => {
    const migration = {
      version: 2,
      name: 'set primary key',
      operations: [
        { type: 'setPrimaryKey' as const, table: 'properties', columns: ['id'] },
      ],
    };
    const table = (hasPrimaryKey: boolean) =>
      new Map([[
        'properties',
        {
          name: 'properties',
          engine: 'InnoDB',
          charset: 'utf8mb4',
          collation: 'utf8mb4_unicode_ci',
          columns: new Map(),
          indexes: hasPrimaryKey
            ? new Map([['PRIMARY', {
                name: 'PRIMARY',
                columns: ['id'],
                unique: true,
                primary: true,
                indexType: 'BTREE',
              }]])
            : new Map(),
          foreignKeys: new Map(),
        },
      ]]) as never;

    expect(migrationActions([migration], false, undefined, table(false))[0]!.sql).toBe(
      'ALTER TABLE `properties` ADD PRIMARY KEY (`id`), ALGORITHM=INPLACE, LOCK=NONE',
    );
    expect(migrationActions([migration], false, undefined, table(true))[0]!.sql).toBe(
      'ALTER TABLE `properties` DROP PRIMARY KEY, ADD PRIMARY KEY (`id`), ALGORITHM=INPLACE, LOCK=NONE',
    );
  });

  test('requires operator approval to drop columns and primary keys', () => {
    const migration = {
      version: 4,
      name: 'drop money column',
      allowBlocking: true,
      operations: [
        {
          type: 'dropColumn' as const,
          table: 'properties',
          column: 'money',
          allowDataLoss: true as const,
        },
        { type: 'dropPrimaryKey' as const, table: 'properties' },
        { type: 'setPrimaryKey' as const, table: 'properties', columns: ['id'] },
      ],
    };

    // allowDataLoss is the schema author's flag; the operator's is
    // qbxsql_schema_allow_blocking, so these must not run unattended without it.
    expect(migrationActions([migration], false)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'migration:dropColumn', automatic: false }),
        expect.objectContaining({ kind: 'migration:dropPrimaryKey', automatic: false }),
        expect.objectContaining({ kind: 'migration:setPrimaryKey', automatic: false }),
      ]),
    );
    expect(migrationActions([migration], true)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'migration:dropColumn', automatic: true }),
      ]),
    );
  });
});
