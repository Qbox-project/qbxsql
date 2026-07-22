import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const options = {
  bundle: true,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.cjs',
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  keepNames: true,
  logLevel: 'info',
};

if (watch) {
  const buildContext = await context(options);
  await buildContext.watch();
  console.log('[qbxsql] watching for changes');
} else {
  await build(options);
}

