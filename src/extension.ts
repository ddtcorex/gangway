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
import { tmpRootFor } from './tmpPath';
import { mapSftpError, actionLabel } from './errorMapper';
import { RemoteTreeProvider } from './ui/remoteTreeProvider';
import { createTmpStatusBarItem } from './ui/statusBar';
import { buildConnectionFormHtml } from './ui/connectionFormHtml';
import { ConnectionFormPanel } from './ui/connectionFormPanel';

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

  const initialConnection = getActiveConnection();
  if (initialConnection) {
    const treeProvider = new RemoteTreeProvider(initialConnection.remotePath, async (dirPath) => {
      const connection = requireActiveConnection();
      if (!connection) return [];
      const client = await pool.getClient(connection);
      const list = await (client as unknown as { list: (p: string) => Promise<Array<{ name: string; type: string }>> }).list(dirPath);
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
    vscode.commands.registerCommand('gangway.downloadFile', async (remotePath: string) => {
      const connection = requireActiveConnection();
      if (!connection) return;
      try {
        const client = await pool.getClient(connection);
        const { localPath } = await downloadFile(client as never, connection, remotePath);
        createTmpStatusBarItem(connection.name, remotePath);
        await vscode.window.showTextDocument(vscode.Uri.file(localPath) as never);
      } catch (err) {
        const mapped = mapSftpError(err);
        await vscode.window.showErrorMessage(mapped.message, ...mapped.actions.map(actionLabel));
      }
    }),
    vscode.commands.registerCommand('gangway.uploadFile', async (localPath: string, remotePath: string) => {
      const connection = requireActiveConnection();
      if (!connection) return;
      try {
        const client = await pool.getClient(connection);
        const sidecar = await readSidecar(localPath);
        const freshStat = await (client as unknown as { stat: (p: string) => Promise<{ mtime: number; size: number }> }).stat(
          remotePath,
        );
        if (sidecar && checkConflict(sidecar, { ...freshStat, isDirectory: false, isSymbolicLink: false }) === 'conflict') {
          await vscode.window.showWarningMessage(
            `${remotePath} changed on the server since download. Open the diff and choose Overwrite, Keep server, or Cancel.`,
          );
          return;
        }
        const bytes = (await import('node:fs/promises')).default.stat(localPath).then((s) => s.size);
        await uploadFile(client as never, connection.id, localPath, remotePath, await bytes, auditLog);
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
