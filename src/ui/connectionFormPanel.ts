import crypto from 'node:crypto';
import type * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import type { ConnectionSecretStore } from '../secretStore';
import type { AuthMethod, ConnectionConfig } from '../types';

interface SaveConnectionPayload {
  /** Present only when this save is editing an existing connection. */
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  remotePath: string;
  authMethod: AuthMethod;
  /** Left out entirely when the user leaves the field blank while editing, so
   * an already-stored secret is never overwritten with an empty value. */
  password?: string;
  keyPath?: string;
  keyPassphrase?: string;
}

type IncomingMessage =
  | { nonce: string; type: 'saveConnection'; payload: SaveConnectionPayload }
  | { nonce: string; type: 'browseKeyPath' };

export class ConnectionFormPanel {
  readonly nonce: string = crypto.randomUUID();

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly connectionManager: ConnectionManager,
    private readonly secrets: ConnectionSecretStore,
    /**
     * Invoked once a connection has been saved. `activate()` uses it to
     * refresh the Gangway tree so a newly added or renamed connection shows
     * up in the same session, without a window reload.
     */
    private readonly onConnectionSaved: (connection: ConnectionConfig) => void = () => {},
    /**
     * Shows a native file picker and resolves the chosen local path, or
     * undefined if the user cancelled. Real callers pass
     * `vscode.window.showOpenDialog`-backed logic; injected so this class
     * never touches the real VS Code API directly, matching every other
     * module here.
     */
    private readonly chooseKeyFile: () => Promise<string | undefined> = async () => undefined,
  ) {
    this.panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message as IncomingMessage));
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    if (!message || message.nonce !== this.nonce) return;

    if (message.type === 'browseKeyPath') {
      const chosen = await this.chooseKeyFile();
      if (chosen) {
        await this.panel.webview.postMessage({ type: 'keyPathSelected', path: chosen });
      }
      return;
    }

    if (message.type === 'saveConnection') {
      const { id, password, keyPassphrase, ...connectionFields } = message.payload;
      const saved = id
        ? await this.connectionManager.update(id, connectionFields)
        : await this.connectionManager.add(connectionFields);

      if (connectionFields.authMethod === 'password' && password) {
        await this.secrets.set(saved.id, 'password', password);
      }
      if (connectionFields.authMethod === 'key' && keyPassphrase) {
        await this.secrets.set(saved.id, 'keyPassphrase', keyPassphrase);
      }

      if (!id) {
        // Without this a brand-new connection exists in the global library
        // but no command can reach it: requireActiveConnection() in
        // extension.ts resolves through the workspace binding, and nothing
        // else in the product sets one for a first-ever connection. Editing
        // an existing connection never touches the binding: the user may be
        // editing a connection other than the one currently bound, and
        // silently switching the active one out from under them would be a
        // surprising side effect of what they experience as "just fixing a
        // typo".
        await this.connectionManager.setWorkspaceBinding(saved.id);
      }
      this.onConnectionSaved(saved);
    }
  }
}
