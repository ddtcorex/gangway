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
  try {
    await fs.mkdir(fixtureDir, { recursive: true });
    await fs.writeFile(path.join(fixtureDir, 'hotfix.php'), SEED_CONTENT, 'utf8');
    // Richer tree for the folder-ops suites (sync preview, excludes,
    // conflict review): nested file, excluded dir, conflict pair.
    await fs.mkdir(path.join(fixtureDir, 'nested'), { recursive: true });
    await fs.writeFile(path.join(fixtureDir, 'nested', 'inner.php'), "<?php echo 'nested';", 'utf8');
    await fs.mkdir(path.join(fixtureDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(fixtureDir, 'node_modules', 'skip.js'), 'skip me', 'utf8');
    await fs.writeFile(path.join(fixtureDir, 'conflict.php'), "<?php echo 'base';", 'utf8');
    // Prior runs leave e2e scratch dirs in the bind mount: sweep them so
    // every run starts from the same tree. (Trash/backup roots are gone:
    // the extension no longer creates them, so they are not swept.)
    for (const entry of await fs.readdir(fixtureDir)) {
      if (entry === 'e2e-ws' || entry === 'mapped-sync') {
        await fs.rm(path.join(fixtureDir, entry), { recursive: true, force: true });
      }
    }
  } catch (err) {
    // The fixture dir is a docker bind-mount: once the sftp container has
    // started, the mount point is owned by the container's user, so a direct
    // host write fails with EACCES (first seen in CI 2026-09-18). Re-throw
    // with the fix attached instead of a bare errno.
    const hint =
      'hint: the sftp-data dir is owned by the container user once the fixture is up; ' +
      '`sudo chown -R $(id -u):$(id -g) test/fixtures/sftp-data` (CI does this automatically)';
    throw new Error(`resetFixture failed: ${err instanceof Error ? err.message : String(err)}. ${hint}`);
  }
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

/**
 * The suites the extension host runs, in order. Each one gets its own fresh
 * workspace folder and VS Code instance, so neither can inherit state (a bound
 * connection, an open editor) from the other.
 */
const SUITES = ['e2e/hotfix.e2e.test.js', 'e2e/mapping-sync.e2e.test.js'];

/**
 * `--grep <text>` / `--grep=<text>` selects the suites whose file name
 * contains <text> (case-insensitive), which is what
 * `pnpm run test:e2e -- --grep "mapping-sync"` relies on to run one suite
 * while iterating. No --grep means every suite runs — the plain
 * `node ./out/test/runE2e.js` CI step, unchanged in behavior.
 *
 * A `--grep` with no value is an error, never "no pattern": silently running
 * every suite would look like the filter was applied and quietly re-run (and
 * re-mutate) both fixture trees, which is the opposite of what the flag is
 * for. The message mirrors the no-match error below.
 */
function selectedSuites(argv: readonly string[]): string[] {
  let pattern: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--grep') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`--grep needs a value; usage: --grep <suite text>. Available: ${SUITES.join(', ')}`);
      }
      pattern = value;
    } else if (arg.startsWith('--grep=')) pattern = arg.slice('--grep='.length);
  }
  if (pattern === undefined) return SUITES;
  if (pattern === '') {
    throw new Error(`--grep needs a value; usage: --grep <suite text>. Available: ${SUITES.join(', ')}`);
  }
  const needle = pattern.toLowerCase();
  const matched = SUITES.filter((suite) => suite.toLowerCase().includes(needle));
  if (matched.length === 0) {
    throw new Error(`--grep "${pattern}" matched no suite; available: ${SUITES.join(', ')}`);
  }
  return matched;
}

async function runSuite() {
  // Resolve the selection before touching the fixture: a bad --grep must fail
  // fast, not after resetting (i.e. mutating) the bind-mounted fixture tree.
  const suites = selectedSuites(process.argv.slice(2));

  await resetFixture();

  const extensionDevelopmentPath = repoRoot;

  for (const suite of suites) {
    const extensionTestsPath = path.resolve(__dirname, suite);

    // Isolated empty workspace folder so the extension host boots with a real
    // (if empty) workspace rather than no folder at all -- closer to how a
    // real user invokes the commands under test.
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'gangway-e2e-workspace-'));
    console.log(`[e2e] running ${suite}`);

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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
