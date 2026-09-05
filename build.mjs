import { build, context } from 'esbuild';
import { writeBundledLicenses } from './scripts/bundled-licenses.mjs';

const watch = process.argv.includes('--watch');
const options = {
  bundle: true,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  keepNames: true,
  logLevel: 'info',
  metafile: true,
  plugins: [{
    name: 'bundled-licenses',
    setup(builder) {
      builder.onEnd(async (result) => {
        if (result.errors.length === 0) await writeBundledLicenses(result.metafile);
      });
    },
  }],
};

if (watch) {
  const buildContext = await context(options);
  await buildContext.watch();
  console.log('[qbxsql] watching for changes');
} else {
  await build(options);
}
