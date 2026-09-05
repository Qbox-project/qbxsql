import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { deterministicZip, releaseFiles, validateDocumentationLinks } from '../../scripts/release-lib.mjs';

const root = path.resolve(import.meta.dir, '../..');

describe('public release package', () => {
  test('includes only runtime files and user documentation with resolvable links', async () => {
    const { core } = await releaseFiles();
    expect(core).not.toContain('package.json');
    expect(core.some((file) => /^(src|tests|scripts|\.github)\//.test(file))).toBe(false);
    expect(core.filter((file) => file.startsWith('docs/'))).toEqual([
      'docs/compatibility.md', 'docs/operations.md', 'docs/postgresql.md', 'docs/schemas.md',
    ]);
    expect(core).toContain('dist/THIRD_PARTY_NOTICES.txt');
    const files = new Map(await Promise.all(core.map(async (file) =>
      [file, await readFile(path.join(root, file))] as const,
    )));
    expect(() => validateDocumentationLinks(files)).not.toThrow();
    const notices = files.get('dist/THIRD_PARTY_NOTICES.txt')!.toString();
    expect(notices).toContain('mysql2@');
    expect(notices).toContain('pg@');
    expect(notices).toContain('pg-types@');
    expect(notices).toContain('Copyright');
  });

  test('rejects documentation that links to an unpackaged internal file', () => {
    const files = new Map([['README.md', Buffer.from('[Build](docs/development.md)')]]);
    expect(() => validateDocumentationLinks(files)).toThrow('Broken documentation link');
  });

  test('reproduces ZIP bytes independently of input order', () => {
    const entries = [
      { name: 'qbxsql/z.txt', data: Buffer.from('last') },
      { name: 'qbxsql/A.txt', data: Buffer.from('first') },
    ];
    expect(deterministicZip(entries).equals(deterministicZip(entries.toReversed()))).toBe(true);
  });
});
