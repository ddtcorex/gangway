import crypto from 'node:crypto';
import type * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import type { ConnectionSecretStore } from '../secretStore';
import type { AuthMethod, ConnectionConfig } from '../types';

interface SaveConnectionPayload {
  name: string;
  host: string;
  port: number;
  username: string;
  remotePath: string;
  authMethod: AuthMethod;
  password?: string;
  keyPath?: string;
  keyPassphrase?: string;
}

interface IncomingMessage {
  nonce: string;
  type: 'saveConnection';
  payload: SaveConnectionPayload;
}

export class ConnectionFormPanel {
  readonly nonce: string = crypto.randomUUID();

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly connectionManager: ConnectionManager,
    private readonly secrets: ConnectionSecretStore,
    /**
     * Invoked once a connection has been saved and bound. `activate()` uses it
     * to refresh the Remote Explorer so a user's first connection populates
     * the view in the same session, without a window reload.
     */
    private readonly onConnectionSaved: (connection: ConnectionConfig) => void = () => {},
  ) {
    this.panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message as IncomingMessage));
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    if (!message || message.nonce !== this.nonce) return;
    if (message.type === 'saveConnection') {
      const { password, keyPassphrase, ...connectionFields } = message.payload;
      const created = await this.connectionManager.add(connectionFields);
      if (connectionFields.authMethod === 'password' && password) {
        await this.secrets.set(created.id, 'password', password);
      }
      if (connectionFields.authMethod === 'key' && keyPassphrase) {
        await this.secrets.set(created.id, 'keyPassphrase', keyPassphrase);
      }
      // Without this the connection exists in the global library but no
      // command can reach it: requireActiveConnection() in extension.ts
      // resolves through the workspace binding, and nothing else in the
      // product ever set one, so every upload/download failed with "No SFTP
      // connection is bound to this workspace yet" no matter what the user
      // did. V1 is deliberately one connection per workspace (spec §7), so
      // the connection the user just saved here is unambiguously the one this
      // workspace means.
      await this.connectionManager.setWorkspaceBinding(created.id);
      this.onConnectionSaved(created);
    }
  }
}
