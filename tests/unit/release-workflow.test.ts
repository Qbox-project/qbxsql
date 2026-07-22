import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..', '..');

describe('FXServer release evidence workflow', () => {
  test('archives sanitized metadata, logs, contracts, and artifacts for every runtime', async () => {
    const workflow = await readFile(
      path.join(root, '.github', 'workflows', 'fxserver-release.yml'),
      'utf8',
    );

    for (const evidence of [
      'stock-windows-runtime.json',
      'stock-linux-runtime.json',
      'enhanced-windows-runtime.json',
    ]) {
      expect(workflow).toContain(evidence);
    }
    for (const log of [
      'stock-windows-fxserver.log',
      'stock-linux-fxserver.log',
      'enhanced-windows-fxserver.log',
    ]) {
      expect(workflow).toContain(log);
    }
    expect(workflow.match(/uses: actions\/upload-artifact@v4/g)).toHaveLength(3);
    expect(workflow.match(/retention-days: 90/g)).toHaveLength(3);
    expect(workflow.match(/if: always\(\)/g)).toHaveLength(3);
    expect(workflow).toContain('qbxsql-contract.json');
    expect(workflow).toContain('oxmysql-contract.json');
    expect(workflow).not.toContain('pull_request:');
  });
});
