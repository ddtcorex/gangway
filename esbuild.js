const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

esbuild
  .build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    platform: 'node',
    format: 'cjs',
    sourcemap: true,
    watch,
  })
  .catch(() => process.exit(1));
