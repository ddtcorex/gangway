import * as assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';

/**
 * This suite runs inside a real VS Code extension host (@vscode/test-electron)
 * against a real `atmoz/sftp` container (test/fixtures/docker-compose.sftp.yml).
 * It is the acceptance test for spec §6: "1-file hotfix flow + conflict always
 * shows diff first" -- exercised here end to end against the real
 * `ssh2-sftp-client` library, not mocks.
 *
 * Reconciliation with the current src/extension.ts (this brief was written
 * before later review rounds changed the command signatures; verified against
 * the real handlers before writing this):
 *
 *  - `gangway.downloadFile` takes an optional `RemoteTreeNode` (`{ entry: RemoteEntry }`),
 *    not a bare remote-path string -- it reads `node?.entry?.path`. A scripted
 *    invocation must therefore pass a tree-node-shaped object, which is what
 *    this test does below, instead of the plain string the original brief
 *    assumed.
 *  - `gangway.uploadFile(localPathArg?, remotePathArg?)` still takes the two
 *    positional string args the brief assumed -- unchanged.
 *
 * Hang-safety (2026-09-17 post-mortem): an earlier version of this suite only
 * stubbed `showWarningMessage`. Every command handler in src/extension.ts also
 * calls the REAL, un-stubbed `showErrorMessage` on any caught error -- and that
 * call is `await`-ed in the handler. In a headless run there is no human to
 * click that real Electron modal, so any unexpected error (a bad arg, a
 * network hiccup, anything) turned into a silent, CPU-idle, infinite hang
 * instead of a loud test failure -- exactly the failure mode observed in a
 * real run that sat for 11 hours with ~11s of total CPU time. Both
 * `showWarningMessage` and `showErrorMessage` are now stubbed from the very
 * first line of `run()`, before anything else executes, and every stub logs
 * what it was called with via `log()` so a future hang (or a fast failure)
 * leaves a breadcrumb trail in captured stdout showing exactly how far the
 * suite got. `test/runE2e.ts`'s caller additionally wraps the whole process in
 * a hard `timeout --signal=KILL`, so a real hang is now bounded and loud
 * instead of unbounded and silent.
 */

function repoRoot(): string {
  // Compiled location is out/test/e2e/hotfix.e2e.test.js; the repo root is
  // three directories up (e2e -> test -> out -> repo root).
  return path.resolve(__dirname, '..', '..', '..');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(step: string): void {
  // Direct stdout write (not console.log) so the breadcrumb is flushed
  // immediately and shows up in the captured `docker run`/xvfb-run output
  // even if the process is later force-killed mid-step.
  process.stdout.write(`[e2e ${new Date().toISOString()}] ${step}\n`);
}

export async function run(): Promise<void> {
  log('run() start');

  // Installed FIRST, before anything else, so nothing between here and the
  // real host-key/error paths can race ahead of the stub (see hang-safety
  // note above). showErrorMessage is stubbed for the whole suite: no code
  // path below is expected to trigger it, so seeing it log at all is itself
  // a diagnostic signal, not just a hang guard.
  type ShowMessage = typeof vscode.window.showWarningMessage;
  let hostKeyPromptInvoked = false;
  let warnedAboutConflict = false;
  const infoMessages: string[] = [];
  const patchableWindow = vscode.window as unknown as { showWarningMessage: ShowMessage; showErrorMessage: ShowMessage };

  patchableWindow.showWarningMessage = (async (msg: string, ...items: string[]) => {
    log(`showWarningMessage stub called: "${msg}" items=${JSON.stringify(items)}`);
    if (items.includes('Trust')) {
      hostKeyPromptInvoked = true;
      return 'Trust';
    }
    if (/changed on the server/i.test(msg)) {
      warnedAboutConflict = true;
      return undefined;
    }
    // File/folder-ops suite: confirm trash moves the same way a user would.
    if (/to the Gangway trash/i.test(msg)) return 'Move to Trash';
    return undefined;
  }) as unknown as ShowMessage;

  patchableWindow.showErrorMessage = (async (msg: string, ...items: string[]) => {
    log(`showErrorMessage stub called (UNEXPECTED): "${msg}" items=${JSON.stringify(items)}`);
    return undefined;
  }) as unknown as ShowMessage;

  // Headless guards installed once for every suite below: a real modal would
  // hang forever with nobody to click it. QuickPick returns everything
  // offered for multi-picks and the first item for single picks (direction
  // lists put Upload first, dest choices put original-location first);
  // information messages auto-dismiss (and log, so summaries stay visible);
  // input boxes answer from a queue the suites fill before invoking.
  type ShowQuickPick = typeof vscode.window.showQuickPick;
  const patchablePick = vscode.window as unknown as { showQuickPick: ShowQuickPick };
  patchablePick.showQuickPick = (async (items: unknown, opts?: { canPickMany?: boolean }) => {
    log(`showQuickPick stub called: ${Array.isArray(items) ? items.length : '?'} item(s), canPickMany=${opts?.canPickMany}`);
    if (!Array.isArray(items) || items.length === 0) return undefined;
    return opts?.canPickMany ? items : items[0];
  }) as unknown as ShowQuickPick;
  type ShowInformation = typeof vscode.window.showInformationMessage;
  const patchableInfo = vscode.window as unknown as { showInformationMessage: ShowInformation };
  patchableInfo.showInformationMessage = (async (msg: string) => {
    log(`showInformationMessage stub called: "${msg}"`);
    infoMessages.push(msg);
    return undefined;
  }) as unknown as ShowInformation;
  const inputQueue: (string | undefined)[] = [];
  type ShowInput = typeof vscode.window.showInputBox;
  const patchableInput = vscode.window as unknown as { showInputBox: ShowInput };
  patchableInput.showInputBox = (async () => inputQueue.shift()) as unknown as ShowInput;

  assert.strictEqual(
    vscode.window.showWarningMessage,
    patchableWindow.showWarningMessage,
    'test bug: the showWarningMessage stub did not actually replace the real property',
  );

  log('activating extension');
  const extension = vscode.extensions.getExtension('ddtcorex.gangway');
  const api = await extension?.activate();
  assert.ok(api, 'expected activate() to return { connectionManager, secrets }');
  log('extension activated');

  // The extension has no connection bound at boot in a fresh test profile.
  // Real users create one through gangway.manageRemotes's Webview; an
  // automated test cannot drive that UI, so it sets up the same state
  // through the exact modules the form itself calls (Task 17's export).
  const connection = await api.connectionManager.add({
    name: 'e2e',
    host: '127.0.0.1',
    port: 2223,
    username: 'testuser',
    remotePath: '/var/www',
    authMethod: 'password',
  });
  await api.secrets.set(connection.id, 'password', 'testpass');
  await api.connectionManager.setWorkspaceBinding(connection.id);
  log(`connection ${connection.id} added, secret stored, workspace binding set`);

  // Fixture: sftp-data/hotfix.php pre-seeded with "<?php echo 'v1';" by
  // test/runE2e.ts before this suite is launched, via the docker-compose
  // bind mount so the container and the assertions below share one file.
  const remotePath = '/var/www/hotfix.php';
  const hostFixturePath = path.join(repoRoot(), 'test', 'fixtures', 'sftp-data', 'hotfix.php');

  // gangway.downloadFile reads its remote path off `node?.entry?.path` (a
  // RemoteTreeNode carrying its own connectionId), not a bare string -- see
  // the reconciliation note above.
  log('invoking gangway.downloadFile (first connect: expect TOFU host-key prompt)');
  await vscode.commands.executeCommand('gangway.downloadFile', {
    connectionId: connection.id,
    entry: { path: remotePath, isDirectory: false, isSymbolicLink: false, size: 0 },
  });
  log('gangway.downloadFile returned');

  // Confirms ssh2-sftp-client actually forwards hostHash/hostVerifier to the
  // underlying ssh2 Client and invokes it during the handshake: if it
  // silently dropped those options instead, this stub would never fire and
  // TOFU host-key verification would be a no-op in production.
  assert.ok(hostKeyPromptInvoked, 'expected the first connect to invoke the TOFU host-key prompt via hostVerifier');

  const editor = vscode.window.activeTextEditor;
  assert.ok(editor, 'expected the downloaded file to open in the active editor');
  log(`active editor: ${editor!.document.uri.fsPath}`);

  await editor!.edit((builder) => {
    const fullRange = new vscode.Range(0, 0, editor!.document.lineCount, 0);
    builder.replace(fullRange, "<?php echo 'v2';");
  });
  await editor!.document.save();
  log('local edit saved (v2)');

  log('invoking gangway.uploadFile (clean push)');
  await vscode.commands.executeCommand('gangway.uploadFile', editor!.document.uri.fsPath, remotePath);
  log('gangway.uploadFile (clean push) returned');

  const serverContentAfterCleanPush = await fs.readFile(hostFixturePath, 'utf8');
  assert.strictEqual(
    serverContentAfterCleanPush,
    "<?php echo 'v2';",
    'expected the pushed bytes to match what was edited locally',
  );
  log('clean push content verified on the real server-side file');

  // --- Conflict path -------------------------------------------------------
  // Deliberately keeps the out-of-band edit the SAME BYTE LENGTH as the
  // content just pushed ("<?php echo 'v2';" -> "<?php echo 'v9';", 17 bytes
  // either way). If the conflict guard only ever caught this via a size
  // mismatch, a real bug in SftpClientAdapter's modifyTime -> mtime
  // translation (Task 17's review fix) could silently pass this suite while
  // still being broken for a same-size server-side edit. This isolates the
  // assertion to mtime alone, which is the thing that fix actually touches.
  const referenceMtimeMs = (await fs.stat(hostFixturePath)).mtimeMs;

  // SFTP protocol attrs (and ssh2-sftp-client's modifyTime derived from them)
  // carry mtime at whole-second resolution, not milliseconds. A gap of at
  // least one full second between two writes is the minimum that guarantees
  // the reported mtime actually advances by a whole unit, regardless of
  // where in the current second the first write landed (floor(t) strictly
  // increases once t advances by >= 1.0s). A short real sleep is not a fake
  // timer: this suite runs inside the real extension host process.
  log('sleeping 1200ms to guarantee a whole-second mtime bucket change');
  await sleep(1200);

  const conflictingContent = serverContentAfterCleanPush.replace('v2', 'v9');
  assert.strictEqual(
    conflictingContent.length,
    serverContentAfterCleanPush.length,
    'test bug: the conflict fixture edit must be byte-length-identical to isolate the mtime check from size',
  );
  await fs.writeFile(hostFixturePath, conflictingContent, 'utf8');
  log('wrote out-of-band conflicting content directly to the server-side file');

  const mutatedMtimeMs = (await fs.stat(hostFixturePath)).mtimeMs;
  assert.notStrictEqual(
    Math.floor(mutatedMtimeMs / 1000),
    Math.floor(referenceMtimeMs / 1000),
    'expected the out-of-band edit to land in a different whole-second mtime bucket than the clean push; ' +
      'if this fails it is a real filesystem/SFTP timestamp granularity issue in this environment, not a flaky assertion to loosen',
  );
  log('confirmed mtime bucket advanced');

  log('invoking gangway.uploadFile (expect conflict block)');
  await vscode.commands.executeCommand('gangway.uploadFile', editor!.document.uri.fsPath, remotePath);
  log('gangway.uploadFile (conflict attempt) returned');

  assert.ok(
    warnedAboutConflict,
    'expected the conflicting upload to be blocked with a warning instead of silently overwriting',
  );

  const serverContentAfterBlockedPush = await fs.readFile(hostFixturePath, 'utf8');
  assert.strictEqual(
    serverContentAfterBlockedPush,
    conflictingContent,
    'expected the blocked upload to leave the server-side (out-of-band) content untouched, proving the block ' +
      'actually prevented the write and was not just a warning shown alongside a silent overwrite',
  );
  log('conflict block verified: server content untouched');

  // --- File/folder ops path ------------------------------------------------
  // Delete → restore → rename → folder sync, all through the real registered
  // commands against the real server. Input/modal answers come from the
  // shared stubs at the top (trash confirm, input queue, pick-all,
  // auto-dismissed info): nothing here can hang headless.
  const opsNode = (remotePath: string, isDirectory: boolean) => ({
    connectionId: connection.id,
    entry: { path: remotePath, isDirectory, isSymbolicLink: false, size: 0 },
  });

  log('invoking gangway.deleteRemote on conflict.php (expect trash move)');
  await vscode.commands.executeCommand('gangway.deleteRemote', opsNode('/var/www/conflict.php', false));
  log('gangway.deleteRemote returned');
  const conflictHostPath = path.join(repoRoot(), 'test', 'fixtures', 'sftp-data', 'conflict.php');
  await assert.rejects(fs.stat(conflictHostPath), 'expected the deleted file gone from its server path');
  const trashHosts = await fs.readdir(path.join(repoRoot(), 'test', 'fixtures', 'sftp-data', '.trash-gangway'));
  assert.ok(trashHosts.length > 0, 'expected a trash stamp dir in the fallback trash root');
  log('trash move verified on the server tree');

  log('invoking gangway.restoreFromTrash');
  await vscode.commands.executeCommand('gangway.restoreFromTrash');
  log('gangway.restoreFromTrash returned');
  assert.strictEqual(
    await fs.readFile(conflictHostPath, 'utf8'),
    "<?php echo 'base';",
    'expected the trashed file restored with its original bytes',
  );
  log('restore verified with original bytes');

  log('invoking gangway.renameRemote on nested/inner.php');
  inputQueue.push('renamed.php');
  await vscode.commands.executeCommand('gangway.renameRemote', opsNode('/var/www/nested/inner.php', false));
  log('gangway.renameRemote returned');
  const renamedHostPath = path.join(repoRoot(), 'test', 'fixtures', 'sftp-data', 'nested', 'renamed.php');
  assert.strictEqual(await fs.readFile(renamedHostPath, 'utf8'), "<?php echo 'nested';");
  log('rename verified on the server tree');

  log('invoking gangway.downloadFolder on nested/');
  await vscode.commands.executeCommand('gangway.downloadFolder', opsNode('/var/www/nested', true));
  log('gangway.downloadFolder returned');
  log('invoking gangway.syncFolder up on nested/');
  await vscode.commands.executeCommand('gangway.syncFolder', opsNode('/var/www/nested', true));
  log('gangway.syncFolder returned (clean tree: expect No-differences info in the log above)');

  log('renaming nested/renamed.php back to inner.php for repeatability');
  inputQueue.push('inner.php');
  await vscode.commands.executeCommand('gangway.renameRemote', opsNode('/var/www/nested/renamed.php', false));
  assert.strictEqual(
    await fs.readFile(path.join(repoRoot(), 'test', 'fixtures', 'sftp-data', 'nested', 'inner.php'), 'utf8'),
    "<?php echo 'nested';",
  );
  log('rename-back verified: fixture tree restored');

  // --- Workspace mapping sync path -----------------------------------------
  // A subdir of the real workspace folder maps to a fresh remote dir, so the
  // sync only ever touches files this section owns (never the whole repo).
  // Modals use the shared headless stubs from the top of run().
  const workspaceFolders = vscode.workspace.workspaceFolders;
  assert.ok(workspaceFolders && workspaceFolders.length > 0, 'expected the e2e host to open a workspace folder');
  const e2eWsDir = path.join(workspaceFolders[0].uri.fsPath, 'e2e-ws-tmp');
  await fs.mkdir(e2eWsDir, { recursive: true });
  await fs.writeFile(path.join(e2eWsDir, 'mapped.php'), "<?php echo 'w1';");
  await api.connectionManager.update(connection.id, {
    mappings: [{ localPath: e2eWsDir, remotePath: '/var/www/e2e-ws' }],
  });
  log('workspace mapping set for e2e-ws-tmp');


  const hostMappedPath = path.join(repoRoot(), 'test', 'fixtures', 'sftp-data', 'e2e-ws', 'mapped.php');
  log('invoking gangway.syncWorkspaceUp');
  await vscode.commands.executeCommand('gangway.syncWorkspaceUp');
  log('gangway.syncWorkspaceUp returned');
  assert.strictEqual(
    await fs.readFile(hostMappedPath, 'utf8'),
    "<?php echo 'w1';",
    'expected the workspace file to land on the server through the mapping',
  );
  log('workspace up verified on the real server-side file');

  // Same-size out-of-band server edit, but the no-sidecar fallback compares
  // mtimes with a 2s tolerance: sleep past it so the download direction is
  // unambiguous instead of flaky.
  log('sleeping 2600ms to clear the no-baseline mtime tolerance');
  await sleep(2600);
  await fs.writeFile(hostMappedPath, "<?php echo 'w2';", 'utf8');
  log('wrote out-of-band server edit');
  log('invoking gangway.syncWorkspaceDown');
  await vscode.commands.executeCommand('gangway.syncWorkspaceDown');
  log('gangway.syncWorkspaceDown returned');
  assert.strictEqual(
    await fs.readFile(path.join(e2eWsDir, 'mapped.php'), 'utf8'),
    "<?php echo 'w2';",
    'expected the server edit to land back in the workspace file',
  );
  assert.ok(
    infoMessages.some((msg) => msg.includes(e2eWsDir)),
    'expected the sync summary to name the mapped workspace root',
  );
  log('workspace down verified in the local file');

  await fs.rm(path.join(repoRoot(), 'test', 'fixtures', 'sftp-data', 'e2e-ws'), { recursive: true, force: true });
  await fs.rm(e2eWsDir, { recursive: true, force: true });
  log('mapping fixture cleaned up');
  log('run() complete: all assertions passed');
}
