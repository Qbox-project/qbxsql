import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const releaseRoot = path.join(repositoryRoot, 'release');

const fixedDosDate = 0x0021;
const fixedDosTime = 0x0000;
const utf8Flag = 0x0800;

function assertReleasePath(target) {
  const relative = path.relative(repositoryRoot, target);
  if (relative !== 'release' && !relative.startsWith(`release${path.sep}`)) {
    throw new Error(`Refusing to modify a path outside the release directory: ${target}`);
  }
}

export async function readPackage() {
  return JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
}

export async function manifestVersion(relativePath) {
  const manifest = await readFile(path.join(repositoryRoot, relativePath), 'utf8');
  const match = manifest.match(/^version\s+['"]([^'"]+)['"]/m);
  if (!match) throw new Error(`${relativePath} does not declare a version.`);
  return match[1];
}

async function existingFiles(relativePaths) {
  const files = [];
  for (const relativePath of relativePaths) {
    try {
      const entry = await stat(path.join(repositoryRoot, relativePath));
      if (entry.isFile()) files.push(relativePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return files;
}

async function filesUnder(relativeDirectory) {
  const root = path.join(repositoryRoot, relativeDirectory);
  try {
    const output = [];
    const visit = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) {
          output.push(path.relative(repositoryRoot, absolute).replaceAll('\\', '/'));
        }
      }
    };
    await visit(root);
    return output;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function releaseFiles() {
  const coreRequired = [
    'fxmanifest.lua',
    'package.json',
    'LICENSE',
    'README.md',
    'dist/index.js',
    'dist/index.js.map',
    'lib/MySQL.lua',
    'lib/Schema.lua',
  ];
  for (const relativePath of coreRequired) {
    const entry = await stat(path.join(repositoryRoot, relativePath)).catch(() => null);
    if (!entry?.isFile()) throw new Error(`Required release file is missing: ${relativePath}`);
  }

  const documentation = await existingFiles(['CHANGELOG.md', 'SECURITY.md']);
  const docs = await filesUnder('docs');
  const core = [...coreRequired, ...documentation, ...docs].sort();
  const compat = (await filesUnder('qbxsql_compat')).sort();
  for (const required of [
    'qbxsql_compat/fxmanifest.lua',
    'qbxsql_compat/server.lua',
    'qbxsql_compat/lib/MySQL.lua',
  ]) {
    if (!compat.includes(required)) throw new Error(`Required release file is missing: ${required}`);
  }
  return { core, compat };
}

export async function validateSourceVersions() {
  const packageJson = await readPackage();
  const coreVersion = await manifestVersion('fxmanifest.lua');
  const compatibilityVersion = await manifestVersion('qbxsql_compat/fxmanifest.lua');
  if (packageJson.version !== coreVersion) {
    throw new Error(
      `package.json (${packageJson.version}) and fxmanifest.lua (${coreVersion}) disagree.`,
    );
  }
  if (compatibilityVersion !== '2.14.1') {
    throw new Error(`qbxsql_compat must target oxmysql 2.14.1, found ${compatibilityVersion}.`);
  }

  const coreManifest = await readFile(path.join(repositoryRoot, 'fxmanifest.lua'), 'utf8');
  if (/^provide\s/m.test(coreManifest) || /server_only/m.test(coreManifest)) {
    throw new Error('The core manifest must not contain provide or server_only declarations.');
  }
  const compatManifest = await readFile(
    path.join(repositoryRoot, 'qbxsql_compat/fxmanifest.lua'),
    'utf8',
  );
  for (const declaration of [
    "dependency 'qbxsql'",
    "provide 'oxmysql'",
    "provide 'mysql-async'",
    "provide 'ghmattimysql'",
  ]) {
    if (!compatManifest.includes(declaration)) {
      throw new Error(`qbxsql_compat is missing ${declaration}.`);
    }
  }
  if (compatManifest.includes('server_only')) {
    throw new Error('qbxsql_compat must remain visible to clients.');
  }

  const loader = await readFile(path.join(repositoryRoot, 'qbxsql_compat/lib/MySQL.lua'), 'utf8');
  if (!loader.includes("LoadResourceFile('qbxsql', 'lib/MySQL.lua')")) {
    throw new Error('qbxsql_compat does not load the canonical qbxsql Lua wrapper.');
  }
  return { coreVersion, compatibilityVersion };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function deterministicZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const name = Buffer.from(entry.name.replaceAll('\\', '/'), 'utf8');
    const data = Buffer.from(entry.data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(utf8Flag, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(fixedDosTime, 10);
    local.writeUInt16LE(fixedDosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(utf8Flag, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(fixedDosTime, 12);
    central.writeUInt16LE(fixedDosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export async function buildRelease() {
  const versions = await validateSourceVersions();
  const files = await releaseFiles();
  assertReleasePath(releaseRoot);
  await rm(releaseRoot, { recursive: true, force: true });
  await mkdir(releaseRoot, { recursive: true });
  const zipEntries = [];

  for (const [resource, paths] of [
    ['qbxsql', files.core],
    ['qbxsql_compat', files.compat],
  ]) {
    for (const relativePath of paths) {
      const sourceRelative =
        resource === 'qbxsql_compat'
          ? path.relative('qbxsql_compat', relativePath)
          : relativePath;
      const data = await readFile(path.join(repositoryRoot, relativePath));
      const destination = path.join(releaseRoot, resource, sourceRelative);
      assertReleasePath(destination);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, data);
      zipEntries.push({ name: `${resource}/${sourceRelative}`, data });
    }
  }

  const zipName = `qbxsql-${versions.coreVersion}.zip`;
  const zip = deterministicZip(zipEntries);
  await writeFile(path.join(releaseRoot, zipName), zip);
  const sha256 = createHash('sha256').update(zip).digest('hex');
  await writeFile(path.join(releaseRoot, `${zipName}.sha256`), `${sha256}  ${zipName}\n`);
  return { ...versions, zipName, sha256, entries: zipEntries.map((entry) => entry.name).sort() };
}

export async function parseStoredZip(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const expectedCrc = buffer.readUInt32LE(offset + 14);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    if (method !== 0) throw new Error('Release ZIP contains a non-deterministic compressed entry.');
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const data = buffer.subarray(dataStart, dataStart + size);
    if (crc32(data) !== expectedCrc) throw new Error(`CRC mismatch for ${name}.`);
    entries.set(name, Buffer.from(data));
    offset = dataStart + size;
  }
  return entries;
}

export async function validateBuiltRelease() {
  const versions = await validateSourceVersions();
  const expected = await releaseFiles();
  const zipName = `qbxsql-${versions.coreVersion}.zip`;
  const zip = await readFile(path.join(releaseRoot, zipName));
  const checksumLine = await readFile(path.join(releaseRoot, `${zipName}.sha256`), 'utf8');
  const expectedChecksum = checksumLine.trim().split(/\s+/)[0];
  const actualChecksum = createHash('sha256').update(zip).digest('hex');
  if (expectedChecksum !== actualChecksum) throw new Error('Release ZIP SHA-256 checksum mismatch.');

  const entries = await parseStoredZip(zip);
  const expectedEntries = [
    ...expected.core.map((entry) => `qbxsql/${entry}`),
    ...expected.compat.map((entry) =>
      `qbxsql_compat/${path.relative('qbxsql_compat', entry).replaceAll('\\', '/')}`,
    ),
  ].sort();
  const actualEntries = [...entries.keys()].sort();
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error('Release ZIP contents do not match the resource file allowlist.');
  }

  for (const sourcePath of expected.core) {
    const source = await readFile(path.join(repositoryRoot, sourcePath));
    if (!source.equals(entries.get(`qbxsql/${sourcePath}`))) {
      throw new Error(`Release ZIP is stale for source file: ${sourcePath}`);
    }
  }
  for (const sourcePath of expected.compat) {
    const entryName = `qbxsql_compat/${path.relative('qbxsql_compat', sourcePath).replaceAll('\\', '/')}`;
    const source = await readFile(path.join(repositoryRoot, sourcePath));
    if (!source.equals(entries.get(entryName))) {
      throw new Error(`Release ZIP is stale for source file: ${sourcePath}`);
    }
  }

  for (const [entryName, entryData] of entries) {
    const unpacked = await readFile(path.join(releaseRoot, entryName));
    if (!unpacked.equals(entryData)) {
      throw new Error(`Unpacked release file does not match the ZIP: ${entryName}`);
    }
  }

  const packagedPackage = JSON.parse(entries.get('qbxsql/package.json').toString('utf8'));
  const packagedCoreManifest = entries.get('qbxsql/fxmanifest.lua').toString('utf8');
  const packagedCompatManifest = entries.get('qbxsql_compat/fxmanifest.lua').toString('utf8');
  if (packagedPackage.version !== versions.coreVersion || !packagedCoreManifest.includes(`version '${versions.coreVersion}'`)) {
    throw new Error('Packaged core versions disagree.');
  }
  if (!packagedCompatManifest.includes(`version '${versions.compatibilityVersion}'`)) {
    throw new Error('Packaged compatibility target disagrees.');
  }
  if ((entries.get('qbxsql/dist/index.js')?.length ?? 0) === 0) {
    throw new Error('Packaged server build is empty.');
  }

  return { ...versions, zipName, sha256: actualChecksum, entries: actualEntries };
}
