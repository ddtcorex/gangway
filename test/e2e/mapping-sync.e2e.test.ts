import * as assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Client from 'ssh2-sftp-client';
import * as vscode from 'vscode';
import { isNotFoundError } from '../../src/remoteOps';

/**
 * Acceptance test for the mapped-sync batch (spec §3–§5), run inside a real
 * VS Code extension host (@vscode/test-electron) against the real
 * `atmoz/sftp` fixture (test/fixtures/docker-compose.sftp.yml, host port
 * 2223) — the same acceptance route hotfix.e2e.test.ts takes for the hotfix
 * flow.
 *
 * What only this layer can prove: all six mapped commands are registered and
 * reachable from their real ids, they resolve the mapping the way the
 * zero-config rule documents (first workspace folder → connection path),
 * their confirms offer the labels the handler then compares against, and the
 * bytes that land on the server are the walked set with the connection's
 * excludes honored — all through the same `getAdapter` pool, TOFU host-key
 * verifier and `pushMappedFile`/`pullMappedFile` primitives a user gets.
 *
 * Server-side truth is read through a SECOND, independent SFTP connection
 * (the `witness`), never through the extension's pooled client: a stat/fastGet
 * round trip witnessed from outside is what spec §6's "verify server bytes"
 * means, and the extension cannot be its own judge. Teardown is the one
 * exception — removing a whole directory over SFTP needs the library's
 * `rmdir`, which the hand-written ambient declaration in
 * src/ssh2-sftp-client.d.ts deliberately does not declare (it mirrors only
 * what src/ calls). Tearing the bind-mounted tree down from the host side is
 * exactly what hotfix.e2e.test.ts already does.
 *
 * Dialog safety (2026-09-17 post-mortem, same as hotfix.e2e.test.ts): every
 * real modal is stubbed BEFORE anything else runs, including
 * `showErrorMessage` — an unstubbed error modal hangs a headless run forever
 * instead of failing it. Confirm answers come from `answerWarning()` and are
 * only ever a label the handler actually offered; a mismatch or an
 * unconsumed answer fails loudly instead of letting the command silently
 * no-op and the suite pass vacuously. `answerWarning()` also opens a step:
 * both the queued answer and the recorded fragment list are step-local, so a
 * confirm an earlier command produced can never satisfy a later assertion.
 */

type ShowMessage = typeof vscode.window.showWarningMessage;

function log(step: string): void {
  // Direct stdout write (not console.log): the breadcrumb must be flushed
  // even if a later step wedges and the runner watchdog kills the process.
  process.stdout.write(`[e2e mapping-sync ${new Date().toISOString()}] ${step}\n`);
}

function repoRoot(): string {
  // Compiled location is out/test/e2e/mapping-sync.e2e.test.js; the repo root
  // is three directories up (e2e -> test -> out -> repo root), same as
  // hotfix.e2e.test.ts.
  return path.resolve(__dirname, '..', '..', '..');
}

/** The fixture: host port 2223, user/password seeded by the compose command. */
const SSH = { host: '127.0.0.1', port: 2223, username: 'testuser', password: 'testpass' };

/**
 * Local folder created inside the e2e workspace folder, and the remote root
 * the zero-config default maps it to (first workspace folder → connection
 * remotePath `/var/www`). The two must stay in step: every assertion below
 * names both sides of that pair explicitly.
 */
const LOCAL_FOLDER = 'mapped-sync';
const REMOTE_ROOT = `/var/www/${LOCAL_FOLDER}`;

export async function run(): Promise<void> {
  log('run() start');

  const patchableWindow = vscode.window as unknown as {
    showWarningMessage: ShowMessage;
    showErrorMessage: ShowMessage;
  };
  const warningCalls: Array<{ message: string; items: string[] }> = [];
  const infoMessages: string[] = [];
  const errorMessages: string[] = [];
  let pendingWarningAnswer: string | undefined;
  let warningAnswerProblem: string | undefined;
  let hostKeyPromptInvoked = false;

  patchableWindow.showWarningMessage = (async (message: string, ...items: string[]) => {
    log(`showWarningMessage: "${message}" items=${JSON.stringify(items)}`);
    if (items.includes('Trust')) {
      hostKeyPromptInvoked = true;
      return 'Trust';
    }
    warningCalls.push({ message, items });
    if (pendingWarningAnswer === undefined) return undefined;
    const answer = pendingWarningAnswer;
    pendingWarningAnswer = undefined;
    if (!items.includes(answer)) {
      warningAnswerProblem = `the queued answer "${answer}" was not among the choices offered for "${message}" (${JSON.stringify(items)})`;
      return undefined;
    }
    return answer;
  }) as unknown as ShowMessage;

  patchableWindow.showErrorMessage = (async (message: string, ...items: string[]) => {
    log(`showErrorMessage stub called (UNEXPECTED): "${message}" items=${JSON.stringify(items)}`);
    errorMessages.push(message);
    return undefined;
  }) as unknown as ShowMessage;

  type ShowInformation = typeof vscode.window.showInformationMessage;
  const patchableInfo = vscode.window as unknown as { showInformationMessage: ShowInformation };
  patchableInfo.showInformationMessage = (async (message: string) => {
    log(`showInformationMessage: "${message}"`);
    infoMessages.push(message);
    return undefined;
  }) as unknown as ShowInformation;

  // Nothing below is expected to ask a question, but a real QuickPick in a
  // headless run is an unbounded hang, so it is answered for the whole suite.
  type ShowQuickPick = typeof vscode.window.showQuickPick;
  const patchablePick = vscode.window as unknown as { showQuickPick: ShowQuickPick };
  patchablePick.showQuickPick = (async (items: unknown, opts?: { canPickMany?: boolean }) => {
    log(`showQuickPick stub called: ${Array.isArray(items) ? items.length : '?'} item(s)`);
    if (!Array.isArray(items) || items.length === 0) return undefined;
    return opts?.canPickMany ? items : items[0];
  }) as unknown as ShowQuickPick;
  type ShowInput = typeof vscode.window.showInputBox;
  const patchableInput = vscode.window as unknown as { showInputBox: ShowInput };
  patchableInput.showInputBox = (async () => undefined) as unknown as ShowInput;

  assert.strictEqual(
    vscode.window.showWarningMessage,
    patchableWindow.showWarningMessage,
    'test bug: the showWarningMessage stub did not actually replace the real property',
  );

  /** Index into `warningCalls` where the current step begins. */
  let stepStart = 0;

  /** Queues the label the next confirm must be answered with, and opens a new
   * step: the fragment list below is scoped from here, so `expectConfirmed`
   * only ever sees the confirms the command about to run actually produced
   * (an earlier step's confirm can never satisfy a later step's assertion). */
  function answerWarning(label: string): void {
    assert.strictEqual(
      pendingWarningAnswer,
      undefined,
      `test bug: a confirm answer was queued while "${pendingWarningAnswer}" was still unused`,
    );
    pendingWarningAnswer = label;
    stepStart = warningCalls.length;
  }

  /** Fails unless the confirm was shown with `fragment` and its answer was
   * actually consumed by the command (an unconsumed answer means the command
   * returned before prompting — the transfer never happened). */
  function expectConfirmed(step: string, fragment: string): void {
    assert.strictEqual(
      pendingWarningAnswer,
      undefined,
      `${step}: the queued confirm answer was never consumed — the command returned before asking`,
    );
    assert.strictEqual(warningAnswerProblem, undefined, `${step}: ${warningAnswerProblem}`);
    const stepCalls = warningCalls.slice(stepStart);
    assert.ok(
      stepCalls.some((call) => call.message.includes(fragment)),
      `${step}: expected a confirm containing "${fragment}"; this step saw ${JSON.stringify(stepCalls.map((call) => call.message))}`,
    );
  }

  function expectInfo(step: string, expected: string): void {
    assert.ok(
      infoMessages.includes(expected),
      `${step}: expected the info message "${expected}"; saw ${JSON.stringify(infoMessages)}`,
    );
  }

  function expectNoErrors(step: string): void {
    assert.deepStrictEqual(errorMessages, [], `${step} reported an unexpected error instead of completing`);
  }

  log('activating extension');
  const extension = vscode.extensions.getExtension('ddtcorex.gangway');
  const api = await extension?.activate();
  assert.ok(api, 'expected activate() to return { connectionManager, secrets }');
  log('extension activated');

  const workspaceFolders = vscode.workspace.workspaceFolders;
  assert.ok(workspaceFolders && workspaceFolders.length > 0, 'expected the e2e host to open a workspace folder');
  const localRoot = path.join(workspaceFolders[0].uri.fsPath, LOCAL_FOLDER);
  // The same directory seen from the host through the fixture's bind mount
  // (`./sftp-data:/home/testuser/var/www`), used only to tear the tree down.
  const hostRemoteRoot = path.join(repoRoot(), 'test', 'fixtures', 'sftp-data', LOCAL_FOLDER);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'gangway-mapped-e2e-'));

  const witness = new Client();
  await witness.connect({ ...SSH });
  log(`witness connected; server-side root ${REMOTE_ROOT}`);

  async function remoteTreeNames(root: string): Promise<string[]> {
    const found: string[] = [];
    const stack = [{ dir: root, prefix: '' }];
    while (stack.length > 0) {
      const { dir, prefix } = stack.pop() as { dir: string; prefix: string };
      for (const entry of await witness.list(dir)) {
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.type === 'd') stack.push({ dir: `${dir}/${entry.name}`, prefix: rel });
        else found.push(rel);
      }
    }
    return found.sort();
  }

  async function readRemoteText(remotePath: string, label: string): Promise<string> {
    const copy = path.join(scratch, `witness-${label}`);
    await witness.fastGet(remotePath, copy);
    return fs.readFile(copy, 'utf8');
  }

  async function putRemoteText(remotePath: string, content: string, label: string): Promise<void> {
    const staged = path.join(scratch, `seed-${label}`);
    await fs.writeFile(staged, content, 'utf8');
    await witness.fastPut(staged, remotePath);
  }

  async function expectRemoteMissing(remotePath: string): Promise<void> {
    let caught: unknown;
    try {
      await witness.stat(remotePath);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, `expected ${remotePath} to be absent on the server, but it exists`);
    assert.ok(isNotFoundError(caught), `expected a not-found failure for ${remotePath}, got: ${String(caught)}`);
  }

  // A fresh tree on both sides: nothing below may depend on what a previous
  // run (or the hotfix suite) left behind.
  await fs.rm(hostRemoteRoot, { recursive: true, force: true });
  await fs.rm(localRoot, { recursive: true, force: true });
  await fs.mkdir(localRoot, { recursive: true });

  const connection = await api.connectionManager.add({
    name: 'e2e-mapped',
    ...SSH,
    remotePath: '/var/www',
    authMethod: 'password',
  });
  await api.secrets.set(connection.id, 'password', SSH.password);
  await api.connectionManager.setWorkspaceBinding(connection.id);
  log(`connection ${connection.id} added, secret stored, workspace binding set`);

  /** A remote-tree node as the view hands it to the two remote-side commands
   * (they read `node.connectionId` and `node.entry.path`). */
  function remoteNode(remotePath: string, isDirectory: boolean) {
    return {
      connectionId: connection.id,
      entry: { path: remotePath, isDirectory, isSymbolicLink: false, size: 0 },
    };
  }

  // --- Local Explorer: one file up ----------------------------------------
  // No explicit mapping is seeded on purpose: this exercises the documented
  // zero-config default — first workspace folder → connection path, i.e. the
  // pair { localPath: <e2e workspace>, remotePath: '/var/www' } — which is the
  // resolution every command below must arrive at on its own.
  const upLocal = path.join(localRoot, 'up.php');
  const upRemote = `${REMOTE_ROOT}/up.php`;
  await fs.writeFile(upLocal, "<?php echo 'mapped-w1';", 'utf8');

  log('invoking gangway.uploadMappedFile');
  answerWarning('Upload');
  await vscode.commands.executeCommand('gangway.uploadMappedFile', vscode.Uri.file(upLocal));
  expectConfirmed('uploadMappedFile', `Upload ${upLocal} → ${upRemote}`);
  expectInfo('uploadMappedFile', `Uploaded ${upLocal} → ${upRemote}.`);
  expectNoErrors('uploadMappedFile');
  assert.ok(hostKeyPromptInvoked, 'expected the first connect to invoke the TOFU host-key prompt via hostVerifier');
  assert.strictEqual(await readRemoteText(upRemote, 'up'), "<?php echo 'mapped-w1';");
  // Pure B on the live server: one file, no `.tmp` orphan, no backup copy.
  assert.deepStrictEqual(
    await remoteTreeNames(REMOTE_ROOT),
    ['up.php'],
    'expected the mapped push to leave exactly the pushed file behind',
  );
  log('mapped single-file upload verified through the witness connection');

  // --- Local Explorer: one file down --------------------------------------
  // The server copy is edited out of band so a download that quietly kept the
  // local bytes would fail here; the local file is dirtied so the overwrite is
  // observable too.
  await putRemoteText(upRemote, "<?php echo 'mapped-w2';", 'up-server');
  await fs.writeFile(upLocal, 'stale local bytes that a mapped download must replace', 'utf8');

  log('invoking gangway.downloadMappedFile');
  answerWarning('Download');
  await vscode.commands.executeCommand('gangway.downloadMappedFile', vscode.Uri.file(upLocal));
  expectConfirmed('downloadMappedFile', `Download ${upRemote} on "e2e-mapped" → ${upLocal}`);
  expectInfo('downloadMappedFile', `Downloaded ${upRemote} → ${upLocal}.`);
  expectNoErrors('downloadMappedFile');
  assert.strictEqual(await fs.readFile(upLocal, 'utf8'), "<?php echo 'mapped-w2';");
  assert.deepStrictEqual(
    (await fs.readdir(localRoot)).filter((name) => name.includes('.gangway-')),
    [],
    'expected the direct overwrite to leave no staging or backup artifact next to the workspace file',
  );
  log('mapped single-file download verified in the workspace file');

  // --- Local Explorer: folder up, honoring the connection's excludes -------
  // excludePatterns is set on the connection, so the real `effectiveExcludes`
  // path decides what is left behind — not a test-local predicate.
  await api.connectionManager.update(connection.id, { excludePatterns: ['skipdir/**'] });
  const folderUp = path.join(localRoot, 'folder-up');
  await fs.mkdir(path.join(folderUp, 'sub'), { recursive: true });
  await fs.mkdir(path.join(folderUp, 'skipdir'), { recursive: true });
  await fs.writeFile(path.join(folderUp, 'one.php'), 'one');
  await fs.writeFile(path.join(folderUp, 'sub', 'two.php'), 'two');
  await fs.writeFile(path.join(folderUp, 'skipdir', 'never.php'), 'never');

  log('invoking gangway.uploadMappedFolder');
  answerWarning('Upload 2 files');
  await vscode.commands.executeCommand('gangway.uploadMappedFolder', vscode.Uri.file(folderUp));
  expectConfirmed(
    'uploadMappedFolder',
    `Upload 2 file(s) in ${folderUp} → ${REMOTE_ROOT}/folder-up? Server copies will be overwritten. (+1 excluded)`,
  );
  expectNoErrors('uploadMappedFolder');
  expectInfo('uploadMappedFolder', `Uploaded 2 file(s) to ${REMOTE_ROOT}/folder-up. 1 file(s) excluded by patterns.`);
  assert.deepStrictEqual(
    await remoteTreeNames(REMOTE_ROOT),
    ['folder-up/one.php', 'folder-up/sub/two.php', 'up.php'],
    'expected the folder walk to push the unexcluded tree (nested parents created) and nothing else',
  );
  await expectRemoteMissing(`${REMOTE_ROOT}/folder-up/skipdir`);
  await expectRemoteMissing(`${REMOTE_ROOT}/folder-up/skipdir/never.php`);
  log('mapped folder upload verified: nested parents created, excluded subtree never landed');

  // --- Remote tree: folder down (gangway.downloadToWorkspaceFolder) --------
  await putRemoteText(`${REMOTE_ROOT}/folder-up/one.php`, 'one-from-server', 'one');
  await putRemoteText(`${REMOTE_ROOT}/folder-up/sub/two.php`, 'two-from-server', 'two');
  await fs.writeFile(path.join(folderUp, 'one.php'), 'stale');
  await fs.writeFile(path.join(folderUp, 'sub', 'two.php'), 'stale');

  log('invoking gangway.downloadToWorkspaceFolder');
  answerWarning('Download 2 files');
  await vscode.commands.executeCommand(
    'gangway.downloadToWorkspaceFolder',
    remoteNode(`${REMOTE_ROOT}/folder-up`, true),
  );
  expectConfirmed('downloadToWorkspaceFolder', `Download 2 file(s) from ${REMOTE_ROOT}/folder-up → ${folderUp}`);
  expectNoErrors('downloadToWorkspaceFolder');
  assert.strictEqual(await fs.readFile(path.join(folderUp, 'one.php'), 'utf8'), 'one-from-server');
  assert.strictEqual(await fs.readFile(path.join(folderUp, 'sub', 'two.php'), 'utf8'), 'two-from-server');
  log('mapped folder download (remote tree) verified in both workspace files');

  // --- Local Explorer: folder down (gangway.downloadMappedFolder) ----------
  await putRemoteText(`${REMOTE_ROOT}/folder-up/one.php`, 'one-from-server-2', 'one2');
  log('invoking gangway.downloadMappedFolder');
  answerWarning('Download 2 files');
  await vscode.commands.executeCommand('gangway.downloadMappedFolder', vscode.Uri.file(folderUp));
  expectConfirmed('downloadMappedFolder', `Download 2 file(s) from ${REMOTE_ROOT}/folder-up → ${folderUp}`);
  expectNoErrors('downloadMappedFolder');
  assert.strictEqual(await fs.readFile(path.join(folderUp, 'one.php'), 'utf8'), 'one-from-server-2');
  log('mapped folder download (local menu) verified');

  // --- Remote tree: one file down (gangway.downloadToWorkspaceFile) --------
  await putRemoteText(upRemote, 'up-from-server-tree', 'up-tree');
  log('invoking gangway.downloadToWorkspaceFile');
  answerWarning('Download');
  await vscode.commands.executeCommand('gangway.downloadToWorkspaceFile', remoteNode(upRemote, false));
  expectConfirmed('downloadToWorkspaceFile', `Download ${upRemote} on "e2e-mapped" → ${upLocal}`);
  expectNoErrors('downloadToWorkspaceFile');
  assert.strictEqual(await fs.readFile(upLocal, 'utf8'), 'up-from-server-tree');
  log('mapped single-file download (remote tree) verified against live server bytes');

  // Leave the fixture exactly as it was found: this suite owns REMOTE_ROOT
  // and the workspace subfolder it created, nothing else.
  await witness.end().catch(() => {});
  await fs.rm(hostRemoteRoot, { recursive: true, force: true });
  await fs.rm(localRoot, { recursive: true, force: true });
  await fs.rm(scratch, { recursive: true, force: true });
  log('fixture cleaned up');
  log('run() complete: all assertions passed');
}
