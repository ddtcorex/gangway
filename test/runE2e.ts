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

/**
 * Hard bound on the whole run. A 2026-09-17 run sat for 11 hours with ~11s of
 * CPU time, hung on a real (un-stubbed) Electron modal nobody could click.
 * The suite stubs those now, but a headless GUI run has too many other ways
 * to wedge to rely on that alone, and the mitigation used at the time lived
 * only in a throwaway shell wrapper that was never committed.
 *
 * Caveat, deliberately not papered over: this bounds the *runner*. Exiting
 * here does not reap the VS Code process @vscode/test-electron spawned (it
 * does not expose the child handle), so CI should still impose its own
 * job-level timeout as a backstop for the orphan.
 */
const TIMEOUT_MS = Number(process.env.GANGWAY_E2E_TIMEOUT_MS ?? 15 * 60 * 1000);

async function main() {
  const watchdog = setTimeout(() => {
    console.error(`[e2e] hard timeout after ${TIMEOUT_MS}ms; failing loudly instead of hanging.`);
    process.exit(124);
  }, TIMEOUT_MS);

  try {
    await runSuite();
  } finally {
    clearTimeout(watchdog);
  }
}

async function runSuite() {
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
    // runTests copies the whole parent environment into the VS Code child.
    // If the caller's shell has ELECTRON_RUN_AS_NODE=1 (editor-integrated and
    // agent-hosted terminals commonly do), VS Code boots as plain Node, tries
    // to `require()` the first positional launch arg, and dies with an
    // inscrutable "Cannot find module '/tmp/gangway-e2e-workspace-XXXX'" that
    // looks nothing like its actual cause. Node's spawn drops keys whose
    // value is undefined, so this removes the variable for the child only.
    extensionTestsEnv: { ELECTRON_RUN_AS_NODE: undefined },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
