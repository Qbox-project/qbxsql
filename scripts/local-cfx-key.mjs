import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const KEY_PATTERN = /^cfxk_[A-Za-z0-9_-]{16,}$/;

export function localCfxKeyPath(repositoryRoot) {
  return path.join(repositoryRoot, '.cache', 'qbxsql', 'cfx-license-key');
}

function validatedKey(value) {
  const key = value.trim();
  if (!KEY_PATTERN.test(key)) {
    throw new Error('The CFX license key has an invalid format.');
  }
  return key;
}

export async function readLocalCfxKey(repositoryRoot) {
  try {
    return validatedKey(await readFile(localCfxKeyPath(repositoryRoot), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function saveLocalCfxKey(repositoryRoot, value) {
  const key = validatedKey(value);
  const file = localCfxKeyPath(repositoryRoot);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

export async function promptCfxKey() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error(
      'Run bun run cfx-key:save interactively or set CFX_LICENSE_KEY for this process.',
    );
  }

  process.stdout.write('CFX license key (hidden): ');
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  const wasRaw = Boolean(process.stdin.isRaw);
  process.stdin.setRawMode(true);

  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else {
        try {
          resolve(validatedKey(value));
        } catch (validationError) {
          reject(validationError);
        }
      }
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish(new Error('Cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    process.stdin.on('data', onData);
  });
}
