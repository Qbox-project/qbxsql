import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { repositoryRoot, validateSourceVersions } from './release-lib.mjs';
import path from 'node:path';

const { coreVersion } = await validateSourceVersions();
if (process.env.GITHUB_REF_NAME !== `v${coreVersion}`) {
  throw new Error(`Release tag must be v${coreVersion}.`);
}
const changelog = await readFile(path.join(repositoryRoot, 'CHANGELOG.md'), 'utf8');
const section = changelog.split(/^## /m).find((entry) => entry.startsWith(`${coreVersion} - `));
if (!section) throw new Error(`CHANGELOG.md needs a dated ${coreVersion} section.`);
const notes = section.slice(section.indexOf('\n') + 1).trim();
if (!notes) throw new Error('Release notes must not be empty.');
await mkdir(path.join(repositoryRoot, '.cache'), { recursive: true });
await writeFile(path.join(repositoryRoot, '.cache', 'release-notes.md'),
  `Download qbxsql-${coreVersion}.zip below and extract the qbxsql folder into resources.\n\n${notes}\n`);
