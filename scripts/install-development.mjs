import { cp, lstat, mkdir, readlink, rename, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { releaseRoot, repositoryRoot, validateBuiltRelease } from './release-lib.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const resourcesArgument = option('--resources');
const copyMode = process.argv.includes('--copy');
const replace = process.argv.includes('--replace');

if (!resourcesArgument) {
  throw new Error(
    'Usage: bun run install:dev -- --resources <FXServer resources directory> [--copy] [--replace]',
  );
}

const resourcesRoot = path.resolve(resourcesArgument);
const resourcesStat = await stat(resourcesRoot).catch(() => null);
if (!resourcesStat?.isDirectory()) {
  throw new Error(`Resources directory does not exist: ${resourcesRoot}`);
}
if (resourcesRoot === repositoryRoot || resourcesRoot === releaseRoot) {
  throw new Error('The repository and release directories cannot be used as an install target.');
}

const release = await validateBuiltRelease();
const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');

async function prepareTarget(target, source) {
  const relative = path.relative(resourcesRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error(`Refusing to replace a target outside the resources directory: ${target}`);
  }

  const existing = await lstat(target).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!existing) return true;

  if (existing.isSymbolicLink() && !copyMode) {
    const current = path.resolve(path.dirname(target), await readlink(target));
    if (current === source) {
      console.log(`[qbxsql] ${path.basename(target)} already points to the validated release.`);
      return false;
    }
  }

  if (!replace) {
    throw new Error(
      `${target} already exists. Re-run with --replace to move it to a timestamped backup.`,
    );
  }
  const backup = `${target}.backup-${timestamp}`;
  await rename(target, backup);
  console.log(`[qbxsql] preserved existing resource at ${backup}`);
  return true;
}

for (const resource of ['qbxsql']) {
  const source = path.join(releaseRoot, resource);
  const target = path.join(resourcesRoot, resource);
  if (!(await prepareTarget(target, source))) continue;

  if (copyMode) {
    await mkdir(target, { recursive: true });
    await cp(source, target, { recursive: true, errorOnExist: true, force: false });
    console.log(`[qbxsql] copied ${resource} from the verified ${release.zipName} artifact.`);
  } else {
    await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
    console.log(`[qbxsql] linked ${target} -> ${source}`);
  }
}

console.log(`[qbxsql] development install verified with SHA-256 ${release.sha256}`);
