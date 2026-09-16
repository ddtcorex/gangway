import * as vscode from 'vscode';
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
import { RemoteTreeProvider, type RemoteTreeNode } from './ui/remoteTreeProvider';
import { createTmpStatusBarItem } from './ui/statusBar';
import { buildConnectionFormHtml } from './ui/connectionFormHtml';
import { ConnectionFormPanel } from './ui/connectionFormPanel';
import { SftpClientAdapter, type RawSftpClient } from './transfer/sftpClientAdapter';
import { runFolderDownload, runFolderUpload } from './ui/folderTransferCommands';
import type { ConnectionConfig } from './types';

export function activate(context: vscode.ExtensionContext): { connectionManager: ConnectionManager; secrets: ConnectionSecretStore } {
  const connectionManager = new ConnectionManager(context.globalState, context.workspaceState);
  const secrets = new ConnectionSecretStore(context.secrets);
  const hostKeyStore = new HostKeyStore(context.globalState);
  const auditLog = new AuditLog(`${context.globalState.get<string>('gangway.auditLogPath') ?? '.'}/sftp-hotfix-uploads.log`);

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

  const initialConnection = getActiveConnection();
  if (initialConnection) {
    const treeProvider = new RemoteTreeProvider(initialConnection.remotePath, async (dirPath) => {
      const connection = requireActiveConnection();
      if (!connection) return [];
      const adapter = await getAdapter(connection);
      const list = await adapter.list(dirPath);
      return list.map((entry) => ({
        path: `${dirPath}/${entry.name}`,
        isDirectory: entry.type === 'd',
        isSymbolicLink: entry.type === 'l',
        size: 0,
      }));
    });
    vscode.window.createTreeView?.('gangway.remoteExplorer', { treeDataProvider: treeProvider as never });
    void purgeExpiredTmp(tmpRootFor(initialConnection));
  }

  context.subscriptions.push(
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
          await vscode.window.showWarningMessage(
            `${remotePath} changed on the server since download. Open the diff and choose Overwrite, Keep server, or Cancel.`,
          );
          return;
        }
        const bytes = (await import('node:fs/promises')).default.stat(localPath).then((s) => s.size);
        await uploadFile(adapter, connection.id, localPath, remotePath, await bytes, auditLog);
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
      const panel = new ConnectionFormPanel(rawPanel, connectionManager, secrets);
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
        await vscode.window.withProgress(
          { location: { viewId: 'gangway.remoteExplorer' }, title: 'Downloading folder' },
          () =>
            runFolderDownload(
              { path: remotePath, isDirectory: true, isSymbolicLink: false, size: 0 },
              async (dirPath) => {
                const entries = await adapter.list(dirPath);
                return entries.map((entry) => ({
                  path: `${dirPath}/${entry.name}`,
                  isDirectory: entry.type === 'd',
                  isSymbolicLink: entry.type === 'l',
                  size: 0,
                }));
              },
              async (file) => {
                await downloadFile(adapter, connection, file);
              },
              () => {},
            ),
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
        const result = await runFolderUpload(
          { path: remotePath, isDirectory: true, isSymbolicLink: false, size: 0 },
          async (dirPath) => {
            const entries = await adapter.list(dirPath);
            return entries.map((entry) => ({
              path: `${dirPath}/${entry.name}`,
              isDirectory: entry.type === 'd',
              isSymbolicLink: entry.type === 'l',
              size: 0,
            }));
          },
          async (file) => {
            const relative = file.slice(remotePath.length);
            const localPath = `${localRoot}${relative}`;
            const bytes = (await import('node:fs/promises')).default.stat(localPath).then((s) => s.size);
            await uploadFile(adapter, connection.id, localPath, file, await bytes, auditLog);
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
        );
        await vscode.window.showInformationMessage(
          `Uploaded ${result.uploaded.length} file(s). ${result.skippedConflicted.length} skipped (conflicted), ${result.skippedSymlinks.length} skipped (symlinks).`,
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
