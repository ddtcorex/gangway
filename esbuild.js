const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const watch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // 'vscode' is provided by the extension host at runtime.
  // 'cpu-features' is ssh2's optional native accelerator (require()'d inside
  // a try/catch in ssh2/lib/protocol/constants.js): esbuild otherwise tries
  // to statically bundle its `require('../build/Release/cpufeatures.node')`
  // and fails at build time when no prebuilt binary exists for this platform.
  // Kept external so it resolves (or gracefully fails) at real runtime, same
  // as ssh2 already expects.
  external: ['vscode', 'cpu-features'],
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  plugins: [
    {
      // ssh2's optional native accelerators (*.node) must stay runtime
      // requires: ssh2 loads each inside try/catch and falls back to pure
      // JS when the binary is absent. Without this, the build is
      // environment-dependent — it passes when the ssh2 postinstall never
      // produced the binary (unresolved require left as-is) and fails with
      // "No loader is configured for .node files" on any fresh install
      // where the binary exists (caught 2026-09-18 by a clean-room
      // install sim while wiring CI).
      name: 'native-node-external',
      setup(build) {
        build.onResolve({ filter: /\.node$/ }, (args) => ({
          path: args.path,
          external: true,
        }));
      },
    },
  ],
};

function copyMediaAssets() {
  const mediaOutDir = path.join(__dirname, 'dist', 'media', 'connectionForm');
  fs.mkdirSync(mediaOutDir, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, 'node_modules', '@vscode', 'webview-ui-toolkit', 'dist', 'toolkit.min.js'),
    path.join(mediaOutDir, 'toolkit.min.js'),
  );
  fs.copyFileSync(
    path.join(__dirname, 'src', 'ui', 'media', 'connectionForm', 'main.js'),
    path.join(mediaOutDir, 'main.js'),
  );
}

async function main() {
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    copyMediaAssets();
  } else {
    await esbuild.build(buildOptions);
    copyMediaAssets();
  }
}

main().catch(() => process.exit(1));
