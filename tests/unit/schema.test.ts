import { describe, expect, test } from 'bun:test';
import { columnSql, createTableSql, migrationOperationSql } from '../../src/schema/sql.js';
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
  });
});
