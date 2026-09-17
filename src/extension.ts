import * as vscode from 'vscode';
import path from 'node:path';
import Client from 'ssh2-sftp-client';
import { ConnectionManager } from './connectionManager';
import { ConnectionSecretStore } from './secretStore';
import { HostKeyStore } from './hostKeyStore';
import { ConnectionPool } from './transfer/connectionPool';
import { downloadFile } from './transfer/downloadFile';
import { uploadFile } from './transfer/uploadFile';
import { AuditLog } from './auditLog';
import { checkConflict } from './conflictGuard';
import { readSidecar } from './tmpStore';
import { purgeExpiredTmp } from './tmpRetention';
import { tmpFilePathFor, tmpRootFor } from './tmpPath';
import { mapSftpError, actionLabel } from './errorMapper';
import { mapListingToEntries } from './remoteListing';
import { RemoteTreeProvider, type RemoteTreeNode } from './ui/remoteTreeProvider';
import { createTmpStatusBarItem } from './ui/statusBar';
import { buildConnectionFormHtml } from './ui/connectionFormHtml';
import { ConnectionFormPanel } from './ui/connectionFormPanel';
import { SftpClientAdapter, type RawSftpClient } from './transfer/sftpClientAdapter';
import { runFolderDownload, runFolderUpload } from './ui/folderTransferCommands';
import { resolveFileConflict, type ConflictResolutionUi } from './ui/conflictResolution';
import type { FileConflictDecision } from './conflictGuard';
import type { ConnectionConfig } from './types';

export function activate(context: vscode.ExtensionContext): { connectionManager: ConnectionManager; secrets: ConnectionSecretStore } {
  const connectionManager = new ConnectionManager(context.globalState, context.workspaceState);
  const secrets = new ConnectionSecretStore(context.secrets);
  const hostKeyStore = new HostKeyStore(context.globalState);
  const output = vscode.window.createOutputChannel('Gangway');

  /**
   * `globalStorageUri` is the per-extension directory VS Code guarantees is
   * writable, so the audit trail always has somewhere real to live. The
   * previous scheme read a `gangway.auditLogPath` globalState key that
   * nothing in the product ever wrote, so it always fell back to `.` -- the
   * extension host's process cwd, which is neither configurable, predictable,
   * nor guaranteed writable (a real E2E run dropped the log in the repo root).
   */
  const auditLog = new AuditLog(path.join(context.globalStorageUri.fsPath, 'sftp-hotfix-uploads.log'));

  const pool = new ConnectionPool(
    { create: () => new Client() as never },
    hostKeyStore,
    { confirmNewOrChangedKey: async (host, port, fingerprint, isChange) => {
        const choice = await vscode.window.showWarningMessage(
          isChange
            ? `Host key for ${host}:${port} changed to ${fingerprint}. Trust it?`
            : `First connection to ${host}:${port}. Trust host key ${fingerprint}?`,
          'Trust',
          'Cancel',
        );
        return choice === 'Trust' ? 'accept' : 'reject';
      },
    },
    secrets,
  );

  /**
   * Resolved fresh on every command invocation, never cached at activate()
   * time: a brand-new user has no connection yet when the extension boots,
   * creates one later via gangway.openConnectionForm, and the download/upload
   * keybindings must work in that same session without a window reload.
   */
  function getActiveConnection() {
    const activeConnectionId = connectionManager.getWorkspaceBinding();
    return connectionManager.list().find((c) => c.id === activeConnectionId);
  }

  function requireActiveConnection(): ReturnType<typeof getActiveConnection> {
    const connection = getActiveConnection();
    if (!connection) {
      void vscode.window.showWarningMessage(
        'No SFTP connection is bound to this workspace yet. Run "Gangway: Open Connection Form" first.',
      );
    }
    return connection;
  }

  /**
   * The one place the pooled client (typed only as the minimal
   * `SftpClientLike` connect/end pair) gets cast back to the real
   * `ssh2-sftp-client` shape and wrapped in `SftpClientAdapter`, which
   * translates the real client's `modifyTime` field to the `mtime` that
   * `RemoteStat`/`checkConflict` expect. Every command below goes through
   * this instead of casting ad-hoc at each call site.
   */
  async function getAdapter(connection: ConnectionConfig): Promise<SftpClientAdapter> {
    const client = await pool.getClient(connection);
    return new SftpClientAdapter(client as unknown as RawSftpClient);
  }

  /**
   * A listing entry the server sent that could not be turned into a safe
   * local path (see remoteListing.ts). Skipped rather than trusted, and
   * recorded so a genuinely odd server is diagnosable instead of silent.
   */
  function reportUnsafeListingName(name: string): void {
    output.appendLine(`Skipped a server listing entry with an unsafe name: ${JSON.stringify(name)}`);
  }

  /**
   * The native half of the Conflict Guard: the built-in diff editor plus a
   * three-way choice matching `FileConflictDecision`. Kept here (and injected
   * into `resolveFileConflict`) so the decision flow itself stays testable
   * outside a VS Code extension host, matching how every other module in this
   * extension takes its collaborators.
   */
  const conflictUi: ConflictResolutionUi = {
    showDiff: async (localPath, serverCopyPath, title) => {
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(localPath),
        vscode.Uri.file(serverCopyPath),
        title,
      );
    },
    askDecision: async (remotePath): Promise<FileConflictDecision> => {
      // Keep the phrase "changed on the server" in this copy: the E2E suite
      // recognises the conflict prompt by it.
      const choice = await vscode.window.showWarningMessage(
        `${remotePath} changed on the server since it was downloaded. Review the diff, then choose what to do.`,
        'Overwrite server',
        'Keep server',
        'Cancel',
      );
      if (choice === 'Overwrite server') return 'overwrite';
      if (choice === 'Keep server') return 'keepServer';
      // A dismissed notification (undefined) must never mean "push anyway".
      return 'cancel';
    },
  };

  /**
   * Created unconditionally, and resolving its root through
   * `getActiveConnection()` on every expansion. The whole block used to sit
   * behind `if (initialConnection)`, so a brand-new user -- who by definition
   * has no connection bound when the extension boots -- got no Remote
   * Explorer at all until they reloaded the window, which matches the same
   * reasoning that already made the commands register unconditionally.
   */
  const treeProvider = new RemoteTreeProvider(
    () => getActiveConnection()?.remotePath,
    async (dirPath) => {
      const connection = requireActiveConnection();
      if (!connection) return [];
      const adapter = await getAdapter(connection);
      return mapListingToEntries(dirPath, await adapter.list(dirPath), reportUnsafeListingName);
    },
  );
  const treeView = vscode.window.createTreeView('gangway.remoteExplorer', {
    treeDataProvider: treeProvider as never,
  });

  /**
   * One cancellable progress notification for both folder commands. The
   * `AbortSignal` is what actually reaches the transfer queue: VS Code's
   * cancellation token is translated once, here, so neither command has to.
   * `location: Notification` (rather than a view id) is what makes the Cancel
   * button exist at all.
   */
  function withCancellableProgress<T>(
    title: string,
    task: (signal: AbortSignal, reportProgress: (remotePath: string) => void) => Promise<T>,
  ): Thenable<T> {
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return task(controller.signal, (remotePath) => progress.report({ message: remotePath }));
      },
    );
  }

  /** Expired tmp entries are per connection, so this runs for whichever
   * connection is bound: at boot, and again as soon as one is first saved. */
  function purgeTmpFor(connection: ConnectionConfig): void {
    void purgeExpiredTmp(tmpRootFor(connection));
  }

  const initialConnection = getActiveConnection();
  if (initialConnection) purgeTmpFor(initialConnection);

  context.subscriptions.push(
    output,
    treeView,
    vscode.commands.registerCommand('gangway.downloadFile', async (node?: RemoteTreeNode) => {
      const connection = requireActiveConnection();
      if (!connection) return;

      let remotePath = node?.entry?.path;

      // Real keybinding invocation (Alt+Shift+W) supplies no arguments at
      // all -- a keybinding can only pass a static `args` value declared in
      // package.json, never "the tree item that's currently selected". The
      // actual context is "re-download whatever tmp file is open right now,
      // discarding local edits": derive the remote path from the active
      // editor's own sidecar, symmetric to how gangway.uploadFile derives
      // its arguments from the active editor.
      if (!remotePath) {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          await vscode.window.showWarningMessage(
            'No active editor to download. Select a file in the Gangway Remote Explorer, or open a Gangway-downloaded file first.',
          );
          return;
        }
        const localPath = activeEditor.document.uri.fsPath;
        const sidecar = await readSidecar(localPath);
        if (!sidecar) {
          await vscode.window.showWarningMessage(
            `${localPath} is not a Gangway-managed file (no sidecar metadata found).`,
          );
          return;
        }
        if (sidecar.connectionId !== connection.id) {
          // A tmp file left open from a previously-bound connection would
          // otherwise run against whatever connection is active now: pushing
          // a hotfix to the wrong server is the worst outcome this tool can
          // produce, so it stops here rather than issuing any network call.
          await vscode.window.showWarningMessage(
            `${localPath} belongs to a different connection than the one currently active for this workspace ` +
              `("${connection.name}"). Bind that connection to this workspace before continuing.`,
          );
          return;
        }
        remotePath = sidecar.remotePath;
      }

      try {
        const adapter = await getAdapter(connection);
        const { localPath } = await downloadFile(adapter, connection, remotePath);
        createTmpStatusBarItem(connection.name, remotePath);
        await vscode.window.showTextDocument(vscode.Uri.file(localPath) as never);
      } catch (err) {
        const mapped = mapSftpError(err);
        await vscode.window.showErrorMessage(mapped.message, ...mapped.actions.map(actionLabel));
      }
    }),
    vscode.commands.registerCommand('gangway.uploadFile', async (localPathArg?: string, remotePathArg?: string) => {
      const connection = requireActiveConnection();
      if (!connection) return;

      let localPath = localPathArg;
      let remotePath = remotePathArg;

      // Real keybinding invocation (Alt+Shift+Q) supplies no arguments at
      // all -- VS Code keybindings can only pass a static `args` value
      // declared in package.json, never "the currently active file". The
      // actual context is simply "whatever tmp file is open right now":
      // derive both the local path and its remote counterpart from the
      // active editor + that file's own sidecar metadata.
      if (!localPath) {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          await vscode.window.showWarningMessage('No active editor to upload. Open a Gangway-downloaded file first.');
          return;
        }
        localPath = activeEditor.document.uri.fsPath;
        const sidecar = await readSidecar(localPath);
        if (!sidecar) {
          await vscode.window.showWarningMessage(
            `${localPath} is not a Gangway-managed file (no sidecar metadata found).`,
          );
          return;
        }
        if (sidecar.connectionId !== connection.id) {
          // A tmp file left open from a previously-bound connection would
          // otherwise run against whatever connection is active now: pushing
          // a hotfix to the wrong server is the worst outcome this tool can
          // produce, so it stops here rather than issuing any network call.
          await vscode.window.showWarningMessage(
            `${localPath} belongs to a different connection than the one currently active for this workspace ` +
              `("${connection.name}"). Bind that connection to this workspace before continuing.`,
          );
          return;
        }
        remotePath = sidecar.remotePath;
      }

      if (!remotePath) {
        await vscode.window.showWarningMessage('Upload requires a remote path; none was provided or derived.');
        return;
      }

      try {
        const adapter = await getAdapter(connection);
        const sidecar = await readSidecar(localPath);
        const freshStat = await adapter.stat(remotePath);
        if (sidecar && checkConflict(sidecar, freshStat) === 'conflict') {
          const decision = await resolveFileConflict(adapter, connection.id, localPath, remotePath, conflictUi);
          if (decision === 'keepServer') {
            await vscode.window.showInformationMessage(
              `Local edits discarded: ${localPath} now matches the server copy of ${remotePath}.`,
            );
            return;
          }
          if (decision !== 'overwrite') return;
        }
        const bytes = (await import('node:fs/promises')).default.stat(localPath).then((s) => s.size);
        await uploadFile(adapter, connection.id, localPath, remotePath, await bytes, auditLog, (message) =>
          output.appendLine(message),
        );
      } catch (err) {
        const mapped = mapSftpError(err);
        await vscode.window.showErrorMessage(mapped.message, ...mapped.actions.map(actionLabel));
      }
    }),
    vscode.commands.registerCommand('gangway.openConnectionForm', () => {
      const mediaDir = vscode.Uri.joinPath(context.extensionUri, 'dist', 'media', 'connectionForm');
      const rawPanel = vscode.window.createWebviewPanel(
        'gangway.connectionForm',
        'Gangway: Connection',
        vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [mediaDir] },
      );
      const panel = new ConnectionFormPanel(rawPanel, connectionManager, secrets, (connection) => {
        // The first connection a user saves is what turns the (already
        // present, but rootless) Remote Explorer into a real tree.
        treeProvider.refresh();
        purgeTmpFor(connection);
      });
      rawPanel.webview.html = buildConnectionFormHtml({
        toolkitUri: rawPanel.webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'toolkit.min.js')).toString(),
        mainScriptUri: rawPanel.webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'main.js')).toString(),
        cspSource: rawPanel.webview.cspSource,
        nonce: panel.nonce,
      });
    }),
    vscode.commands.registerCommand('gangway.cleanupCache', async () => {
      const connection = requireActiveConnection();
      if (connection) await purgeExpiredTmp(tmpRootFor(connection), 0);
    }),
    vscode.commands.registerCommand('gangway.downloadFolder', async (node?: RemoteTreeNode) => {
      const connection = requireActiveConnection();
      if (!connection) return;
      if (!node?.entry?.path) {
        await vscode.window.showWarningMessage('Select a folder in the Gangway Remote Explorer to download it.');
        return;
      }
      const remotePath = node.entry.path;
      try {
        const adapter = await getAdapter(connection);
        const result = await withCancellableProgress(`Downloading ${remotePath}`, (signal, reportProgress) =>
          runFolderDownload(
            { path: remotePath, isDirectory: true, isSymbolicLink: false, size: 0 },
            async (dirPath) => mapListingToEntries(dirPath, await adapter.list(dirPath), reportUnsafeListingName),
            async (file) => {
              await downloadFile(adapter, connection, file);
            },
            reportProgress,
            { signal },
          ),
        );
        await vscode.window.showInformationMessage(
          result.cancelled
            ? `Cancelled after downloading ${result.downloaded.length} file(s).`
            : `Downloaded ${result.downloaded.length} file(s).`,
        );
      } catch (err) {
        const mapped = mapSftpError(err);
        await vscode.window.showErrorMessage(mapped.message, ...mapped.actions.map(actionLabel));
      }
    }),
    vscode.commands.registerCommand('gangway.uploadFolder', async (node?: RemoteTreeNode) => {
      const connection = requireActiveConnection();
      if (!connection) return;
      if (!node?.entry?.path) {
        await vscode.window.showWarningMessage('Select a folder in the Gangway Remote Explorer to upload it.');
        return;
      }
      const remotePath = node.entry.path;
      // A tree-view context-menu command only ever receives the one clicked
      // node -- there is no second free-form argument a real invocation can
      // supply. Derive the local tmp mirror the same way single-file
      // downloads do (tmpFilePathFor mirrors connection.remotePath-relative
      // paths under the per-connection tmp root).
      const localRoot = tmpFilePathFor(connection, remotePath);
      try {
        const adapter = await getAdapter(connection);
        const result = await withCancellableProgress(`Uploading ${remotePath}`, (signal, reportProgress) =>
          runFolderUpload(
            { path: remotePath, isDirectory: true, isSymbolicLink: false, size: 0 },
            async (dirPath) => mapListingToEntries(dirPath, await adapter.list(dirPath), reportUnsafeListingName),
            async (file) => {
              const relative = file.slice(remotePath.length);
              const localPath = `${localRoot}${relative}`;
              const bytes = (await import('node:fs/promises')).default.stat(localPath).then((s) => s.size);
              await uploadFile(adapter, connection.id, localPath, file, await bytes, auditLog, (message) =>
                output.appendLine(message),
              );
            },
            async (file) => {
              const sidecar = await readSidecar(`${localRoot}${file.slice(remotePath.length)}`);
              if (!sidecar) return false;
              const freshStat = await adapter.stat(file);
              return checkConflict(sidecar, freshStat) === 'conflict';
            },
            async (conflictedPaths) => {
              const choice = await vscode.window.showWarningMessage(
                `${conflictedPaths.length} file(s) changed on the server since download.`,
                'Review one by one',
                'Skip conflicted',
              );
              return choice === 'Review one by one' ? 'reviewOneByOne' : 'skipConflicted';
            },
            // The per-file review. Without this argument runFolderUpload has
            // nothing to call, so "Review one by one" silently behaved exactly
            // like "Skip conflicted": the user was offered a choice that did
            // nothing. Each conflicted file now gets the same diff and
            // three-way decision as a single-file push.
            async (file) => {
              const localPath = `${localRoot}${file.slice(remotePath.length)}`;
              return resolveFileConflict(adapter, connection.id, localPath, file, conflictUi);
            },
            { signal, reportProgress },
          ),
        );
        await vscode.window.showInformationMessage(
          `${result.cancelled ? 'Cancelled. ' : ''}Uploaded ${result.uploaded.length} file(s). ` +
            `${result.skippedConflicted.length} skipped (conflicted), ${result.skippedSymlinks.length} skipped (symlinks).`,
        );
      } catch (err) {
        const mapped = mapSftpError(err);
        await vscode.window.showErrorMessage(mapped.message, ...mapped.actions.map(actionLabel));
      }
    }),
  );

  // Exported so tests (Task 19's E2E in particular) can set up a real
  // connection through the same modules the connection form itself uses,
  // without needing to drive the Webview UI from an automated test.
  return { connectionManager, secrets };
}

export function deactivate(): void {
  // ConnectionPool.dispose() is invoked via context.subscriptions in a follow-up
  // hardening pass; no long-lived resources are created outside activate() today.
}
