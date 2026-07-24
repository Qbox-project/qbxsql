import { describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..', '..');
const workflows = path.join(root, '.github', 'workflows');

describe('lean GitHub Actions workflows', () => {
  test('keeps routine CI to one MariaDB/PostgreSQL-backed hosted job', async () => {
    const workflow = await readFile(path.join(workflows, 'ci.yml'), 'utf8');

    expect(workflow.match(/runs-on: ubuntu-latest/g)).toHaveLength(1);
    expect(workflow).toContain('image: mariadb:11.4');
    expect(workflow).toContain('image: pgvector/pgvector:0.8.5-pg16-bookworm');
    expect(workflow).toContain('bun run test:unit');
    expect(workflow).toContain('bun run test:contract');
    expect(workflow).toContain('bun run test:integration');
    expect(workflow).toContain('bun run build');
    expect(workflow).not.toContain('matrix:');
    expect(workflow).not.toContain('upload-artifact');
  });

  test('does not retain runtime, matrix, nightly, security, enhanced, or soak workflows', async () => {
    expect((await readdir(workflows)).sort()).toEqual(['ci.yml']);
  });
});
