import { defineConfig, configDefaults } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    alias: {
      vscode: path.resolve(__dirname, 'test/mocks/vscode.ts'),
    },
    // test/e2e/** runs only inside a real VS Code extension host via
    // @vscode/test-electron (see test/runE2e.ts, package.json's "test:e2e").
    // It exports a mocha-style `run()`, requires the real 'vscode' module
    // (not the mock above), and needs a real SFTP server -- vitest must
    // never try to collect it as a unit test file. `out/**` is tsc's
    // gitignored build output (test:e2e compiles test/**/*.ts there too) --
    // without this exclude, vitest's default glob picks up the exact same
    // test files twice, once as .ts and once as the compiled .js copy.
    exclude: [...configDefaults.exclude, 'test/e2e/**', 'out/**'],
  },
});
