import { runTests } from '@vscode/test-electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SEED_CONTENT = "<?php echo 'v1';";

// tsc (rootDir ".") mirrors test/runE2e.ts to out/test/runE2e.js, so __dirname
// at runtime is <repo>/out/test -- one directory deeper than the brief's
// original uncompiled assumption of <repo>/test. Both the repo root
// (extensionDevelopmentPath, which must point at the real package.json next
// to dist/extension.js) and the fixture path below are computed relative to
// that actual compiled location, not assumed to be __dirname's immediate parent.
const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * The E2E test mutates test/fixtures/sftp-data/hotfix.php in place (its own
 * upload, then an out-of-band conflict edit): resetting it here before every
 * run makes the suite repeatable and keeps the fixture out of git entirely
 * (see .gitignore) instead of relying on a one-time hand-created file that
 * would drift after the first real run.
 */
async function resetFixture(): Promise<void> {
  const fixtureDir = path.join(repoRoot, 'test', 'fixtures', 'sftp-data');
  await fs.mkdir(fixtureDir, { recursive: true });
  await fs.writeFile(path.join(fixtureDir, 'hotfix.php'), SEED_CONTENT, 'utf8');
}

async function main() {
  await resetFixture();

  const extensionDevelopmentPath = repoRoot;
  const extensionTestsPath = path.resolve(__dirname, 'e2e/hotfix.e2e.test.js');

  // Isolated empty workspace folder so the extension host boots with a real
  // (if empty) workspace rather than no folder at all -- closer to how a
  // real user invokes the commands under test.
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'gangway-e2e-workspace-'));

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspacePath, '--disable-gpu'],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
