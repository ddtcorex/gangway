import crypto from 'node:crypto';
import type * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import type { ConnectionSecretStore } from '../secretStore';
import type { AuthMethod } from '../types';

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
    }
  }
}
