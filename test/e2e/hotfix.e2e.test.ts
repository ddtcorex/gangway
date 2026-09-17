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
    return undefined;
  }) as unknown as ShowMessage;

  patchableWindow.showErrorMessage = (async (msg: string, ...items: string[]) => {
    log(`showErrorMessage stub called (UNEXPECTED): "${msg}" items=${JSON.stringify(items)}`);
    return undefined;
  }) as unknown as ShowMessage;

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
  // Real users create one through gangway.openConnectionForm's Webview; an
  // automated test cannot drive that UI, so it sets up the same state
  // through the exact modules the form itself calls (Task 17's export).
  const connection = await api.connectionManager.add({
    name: 'e2e',
    host: '127.0.0.1',
    port: 2222,
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
  // RemoteTreeNode), not a bare string -- see the reconciliation note above.
  log('invoking gangway.downloadFile (first connect: expect TOFU host-key prompt)');
  await vscode.commands.executeCommand('gangway.downloadFile', {
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
  log('run() complete: all assertions passed');
}
