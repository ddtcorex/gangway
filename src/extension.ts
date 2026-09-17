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
import { GangwayTreeProvider, type RemoteTreeNode } from './ui/gangwayTreeProvider';
import { createTmpStatusBarItem } from './ui/statusBar';
import { DirtyDecorationProvider } from './ui/dirtyDecoration';
import { buildConnectionFormHtml, resolveConnectionFormFields, toConnectionsJson } from './ui/connectionFormHtml';
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
   * creates one later via gangway.manageRemotes, and the download/upload
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
   * A tree node (file/folder, or a folder command invoked from one) always
   * names its own connection: resolve THAT one, never the workspace binding,
   * so browsing or acting on a connection other than the bound one can never
   * silently operate against the wrong server. Only a keybinding invocation
   * -- which has no tree node to read a connectionId from -- falls back to
   * the single bound connection.
   */
  function resolveConnection(node?: RemoteTreeNode): ConnectionConfig | undefined {
    if (!node) return requireActiveConnection();
    const connection = connectionManager.list().find((c) => c.id === node.connectionId);
    if (!connection) {
      void vscode.window.showErrorMessage(`Gangway: no saved connection matches this item anymore (id ${node.connectionId}).`);
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
   * Created unconditionally: every saved connection is always listed as a
   * root node (a brand-new user with zero connections just sees an empty
   * tree, no special-casing needed), and expanding one connects it --
   * mirroring PhpStorm's "Remote Host" tool window, where expanding a host
   * row is what connects to it.
   */
  const treeProvider = new GangwayTreeProvider(
    () => connectionManager.list(),
    () => connectionManager.getWorkspaceBinding(),
    async (connection) => {
      await getAdapter(connection);
      await connectionManager.setWorkspaceBinding(connection.id);
      purgeTmpFor(connection);
    },
    async (connection, dirPath) => {
      const adapter = await getAdapter(connection);
      return mapListingToEntries(dirPath, await adapter.list(dirPath), reportUnsafeListingName);
    },
    (connectionId, remotePath) => {
      const connection = connectionManager.list().find((c) => c.id === connectionId);
      return vscode.Uri.file(connection ? tmpFilePathFor(connection, remotePath) : remotePath);
    },
    (err) => {
      const mapped = mapSftpError(err);
      void vscode.window.showErrorMessage(mapped.message, ...mapped.actions.map(actionLabel));
    },
  );
  const treeView = vscode.window.createTreeView('gangway.remoteExplorer', {
    treeDataProvider: treeProvider as never,
  });

  /**
   * Badges a Gangway tmp file (in this tree, and in any editor tab showing
   * it) once its local content has diverged from what last matched the
   * server. VS Code caches decorations until told otherwise, so every path
   * that can change dirty state (a successful download or upload makes a
   * file clean again; a save can make it dirty) explicitly refreshes it.
   */
  const dirtyDecorations = new DirtyDecorationProvider();
  const dirtyDecorationRegistration = vscode.window.registerFileDecorationProvider(dirtyDecorations);
  const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
    dirtyDecorations.refresh(vscode.Uri.file(document.uri.fsPath));
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

  /**
   * The Manage Remotes page: an add/edit form (left) plus a sidebar listing
   * every saved connection (right), matching PhpStorm's Deployment dialog.
   * `initialConnection` only decides which entry the form starts on -- the
   * sidebar always lists everything and the user can click any row, or "+
   * Add", to change what the form is editing without reopening the page.
   */
  function openManageRemotesPanel(initialConnection?: ConnectionConfig): void {
    const mediaDir = vscode.Uri.joinPath(context.extensionUri, 'dist', 'media', 'connectionForm');
    const rawPanel = vscode.window.createWebviewPanel(
      'gangway.connectionForm',
      'Gangway: Manage Remotes',
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [mediaDir] },
    );
    const panel = new ConnectionFormPanel(
      rawPanel,
      connectionManager,
      secrets,
      (connections) => {
        // Any add/edit/delete can change what the tree's selector row and
        // file listing should show (a renamed bound connection, one that
        // just lost its binding because it was deleted, ...).
        treeProvider.refresh();
        const bound = connections.find((c) => c.id === connectionManager.getWorkspaceBinding());
        if (bound) purgeTmpFor(bound);
      },
      async () => {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          title: 'Select SSH Private Key',
          openLabel: 'Select Key',
        });
        return picked?.[0]?.fsPath;
      },
      async (connection) => {
        const choice = await vscode.window.showWarningMessage(
          `Delete the saved connection "${connection.name}" (${connection.host})? This does not touch anything on the server.`,
          { modal: true },
          'Delete',
        );
        return choice === 'Delete';
      },
      (message) => {
        void vscode.window.showWarningMessage(`Gangway: ${message}`);
      },
    );
    rawPanel.webview.html = buildConnectionFormHtml({
      toolkitUri: rawPanel.webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'toolkit.min.js')).toString(),
      mainScriptUri: rawPanel.webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'main.js')).toString(),
      cspSource: rawPanel.webview.cspSource,
      nonce: panel.nonce,
      ...resolveConnectionFormFields(initialConnection),
      connectionsJson: toConnectionsJson(connectionManager.list()),
    });
  }

  context.subscriptions.push(
    output,
    treeView,
    dirtyDecorationRegistration,
    saveListener,
    vscode.commands.registerCommand('gangway.downloadFile', async (node?: RemoteTreeNode) => {
      const connection = resolveConnection(node);
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
        const { localPath } = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Gangway: downloading ${remotePath}` },
          async () => {
            const adapter = await getAdapter(connection);
            return downloadFile(adapter, connection, remotePath);
          },
        );
        createTmpStatusBarItem(connection.name, remotePath);
        dirtyDecorations.refresh(vscode.Uri.file(localPath));
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
        const bytes = await (await import('node:fs/promises')).default.stat(localPath).then((s) => s.size);
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Gangway: uploading ${remotePath}` },
          () => uploadFile(adapter, connection.id, localPath, remotePath, bytes, auditLog, (message) => output.appendLine(message)),
        );
        dirtyDecorations.refresh(vscode.Uri.file(localPath));
      } catch (err) {
        const mapped = mapSftpError(err);
        await vscode.window.showErrorMessage(mapped.message, ...mapped.actions.map(actionLabel));
      }
    }),
    vscode.commands.registerCommand('gangway.manageRemotes', () => openManageRemotesPanel(getActiveConnection())),
    vscode.commands.registerCommand('gangway.pickConnection', async () => {
      // The native analogue of PhpStorm's host dropdown: VS Code has no
      // built-in <select> inside a TreeView, and a QuickPick is the
      // idiomatic way to let the user pick one of several named things.
      type PickItem = vscode.QuickPickItem & { connectionId?: string; action?: 'add' | 'manage' };
      const items: PickItem[] = [
        ...connectionManager
          .list()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(
            (c): PickItem => ({
              label: c.name,
              description: `${c.username}@${c.host}:${c.port}`,
              detail: c.remotePath,
              connectionId: c.id,
            }),
          ),
        { label: '$(add) Add New Remote...', action: 'add' },
        { label: '$(gear) Manage Remotes...', action: 'manage' },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a connection to bind to this workspace',
      });
      if (!picked) return;
      if (picked.action === 'add') {
        openManageRemotesPanel();
        return;
      }
      if (picked.action === 'manage') {
        openManageRemotesPanel(getActiveConnection());
        return;
      }
      if (!picked.connectionId) return;
      await connectionManager.setWorkspaceBinding(picked.connectionId);
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('gangway.cleanupCache', async () => {
      // Explicit user gesture, so it intentionally bypasses the default
      // 7-day retention window (`retentionDays = 0` purges everything whose
      // recorded age is not in the future, which in practice is every tmp
      // file for this connection). That includes files with no sidecar yet
      // -- a download genuinely still in flight, or one that crashed
      // mid-stream -- since purgeExpiredTmp() cannot tell those apart from an
      // abandoned one. This command is "empty the cache for this
      // connection", not "sweep only what's expired"; run it while a
      // transfer is in progress at your own risk.
      const connection = requireActiveConnection();
      if (connection) await purgeExpiredTmp(tmpRootFor(connection), 0);
    }),
    vscode.commands.registerCommand('gangway.downloadFolder', async (node?: RemoteTreeNode) => {
      if (!node?.entry?.path) {
        await vscode.window.showWarningMessage('Select a folder in the Gangway Remote Explorer to download it.');
        return;
      }
      const connection = resolveConnection(node);
      if (!connection) return;
      const remotePath = node.entry.path;
      try {
        const adapter = await getAdapter(connection);
        const result = await withCancellableProgress(`Downloading ${remotePath}`, (signal, reportProgress) =>
          runFolderDownload(
            { path: remotePath, isDirectory: true, isSymbolicLink: false, size: 0 },
            async (dirPath) => mapListingToEntries(dirPath, await adapter.list(dirPath), reportUnsafeListingName),
            async (file) => {
              const { localPath } = await downloadFile(adapter, connection, file);
              dirtyDecorations.refresh(vscode.Uri.file(localPath));
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
      if (!node?.entry?.path) {
        await vscode.window.showWarningMessage('Select a folder in the Gangway Remote Explorer to upload it.');
        return;
      }
      const connection = resolveConnection(node);
      if (!connection) return;
      const remotePath = node.entry.path;
      try {
        // A tree-view context-menu command only ever receives the one
        // clicked node -- there is no second free-form argument a real
        // invocation can supply. Derive the local tmp mirror the same way
        // single-file downloads do (tmpFilePathFor mirrors
        // connection.remotePath-relative paths under the per-connection tmp
        // root). tmpFilePathFor throws on an escaping path (see tmpPath.ts),
        // and that throw must land in this catch like every other failure
        // below, not become an unhandled rejection outside it.
        const localRoot = tmpFilePathFor(connection, remotePath);
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
              dirtyDecorations.refresh(vscode.Uri.file(localPath));
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
