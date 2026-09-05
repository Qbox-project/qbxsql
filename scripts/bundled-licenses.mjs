import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Use esbuild's actual inputs, so notices follow what we ship rather than
// including development dependencies or missing a nested runtime package.
export async function writeBundledLicenses(metafile) {
  const roots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const match = input.replaceAll('\\', '/').match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (match) roots.add(match[1]);
  }
  const notices = new Map();
  for (const root of [...roots].sort()) {
    const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const files = (await readdir(root)).filter((name) => /^licen[sc]e(?:[.-].*)?$/i.test(name)).sort();
    const texts = await Promise.all(files.map((file) => readFile(path.join(root, file), 'utf8')));
    if (texts.length === 0) {
      const readme = await readFile(path.join(root, 'README.md'), 'utf8');
      const section = readme.match(/^#{1,3}\s+licen[sc]e[^\n]*\n([\s\S]*?)(?=^#{1,3}\s|$(?![\s\S]))/im);
      if (!section || !/copyright/i.test(section[1])) {
        throw new Error(`Missing bundled license for ${metadata.name}.`);
      }
      texts.push(section[1]);
    }
    notices.set(`${metadata.name}@${metadata.version}`, texts.join('\n').replaceAll('\r\n', '\n').trim());
  }
  const output = ['Third-party software bundled with qbxsql. Each component retains its own license.'];
  for (const [name, license] of [...notices].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    output.push(`${'='.repeat(72)}\n${name}\n${'='.repeat(72)}\n\n${license}`);
  }
  await writeFile('dist/THIRD_PARTY_NOTICES.txt', `${output.join('\n\n')}\n`);
}
