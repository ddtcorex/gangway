import crypto from 'node:crypto';
import type * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import type { ConnectionSecretStore, SecretKind } from '../secretStore';
import type { AuthMethod, ConnectionConfig } from '../types';
import { withTimeout } from '../withTimeout';

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
  | { nonce: string; type: 'deleteConnection'; payload: { id: string } }
  | { nonce: string; type: 'browseKeyPath' };

/**
 * The OS secret store (SecretStorage's backing keyring/keychain) is a system
 * service outside this extension's control: it can be locked, unavailable,
 * or simply slow to respond depending on the machine's desktop session.
 * Discovered against a real Extension Development Host (not by any unit
 * test, since every test's fake secret store always settles instantly): an
 * unresponsive secrets.set() call left the *whole* save silently stuck --
 * the connection record was written, but the workspace binding, the tree
 * refresh, and the webview's own "saved" reply all sat behind the same
 * unresolved await, so nothing ever updated and nothing ever errored. This
 * bounds every secret-store write so a slow or hung keyring can only ever
 * cost a warning, never the rest of the save.
 */
const SECRET_STORE_TIMEOUT_MS = 5_000;

/**
 * Backs the Manage Remotes page (src/ui/manageRemotesHtml.ts): a single
 * webview that lists every saved connection alongside an add/edit form for
 * whichever one is selected. ConnectionConfig itself never carries secrets
 * (those live only in SecretStorage, keyed by connection id), so the whole
 * list can be pushed back to the webview after any mutation with no
 * filtering needed.
 */
export class ConnectionFormPanel {
  readonly nonce: string = crypto.randomUUID();

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly connectionManager: ConnectionManager,
    private readonly secrets: ConnectionSecretStore,
    /**
     * Invoked after any add, edit, or delete. `activate()` uses it to
     * refresh the Gangway tree (a renamed or deleted connection, or one
     * that just lost its workspace binding, all need the tree and its
     * selector row to reflect it in the same session).
     */
    private readonly onConnectionsChanged: (connections: ConnectionConfig[]) => void = () => {},
    /**
     * Shows a native file picker and resolves the chosen local path, or
     * undefined if the user cancelled. Real callers pass
     * `vscode.window.showOpenDialog`-backed logic; injected so this class
     * never touches the real VS Code API directly, matching every other
     * module here.
     */
    private readonly chooseKeyFile: () => Promise<string | undefined> = async () => undefined,
    /**
     * Confirms a delete before it happens (real callers show a native modal
     * warning). Injected for the same testability reason as chooseKeyFile;
     * defaulting to "always confirm" would make deletion un-guardable in
     * tests that don't care about the prompt, so tests set this explicitly.
     */
    private readonly confirmDelete: (connection: ConnectionConfig) => Promise<boolean> = async () => true,
    /**
     * Reports a secret that failed (or timed out) to save, after the
     * connection record itself was already saved successfully. Never blocks
     * or reverts the save; this is purely informational so the user knows
     * to re-enter the credential rather than silently failing to connect
     * later. Also used when a secret could not be *deleted* (connection
     * remove or auth-method switch): a lingering keychain entry the user
     * believes is gone is worse than a warning.
     */
    private readonly onSecretStoreError: (message: string) => void = () => {},
  ) {
    this.panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message as IncomingMessage));
  }

  /**
   * Best-effort secret cleanup, bounded like every other keychain call: a
   * locked or hung system store must never wedge a delete or a save. The
   * connection record is already gone (or already switched) by the time
   * this runs, so a failure here is reported, never thrown.
   */
  private async deleteSecrets(connectionId: string, kinds: readonly SecretKind[], context: 'deleted connection' | 'auth-method switch'): Promise<void> {
    for (const kind of kinds) {
      try {
        await withTimeout(
          this.secrets.delete(connectionId, kind),
          SECRET_STORE_TIMEOUT_MS,
          'Timed out writing to the system secret store',
        );
      } catch (err) {
        this.onSecretStoreError(
          `Removed the ${context}, but could not delete its stored ${kind === 'password' ? 'password' : 'key passphrase'} (${err instanceof Error ? err.message : String(err)}). Remove it from the OS keychain manually.`,
        );
      }
    }
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    if (!message || message.nonce !== this.nonce) return;

    if (message.type === 'browseKeyPath') {
      const chosen = await this.chooseKeyFile();
      if (chosen) {
        await this.panel.webview.postMessage({ nonce: this.nonce, type: 'keyPathSelected', path: chosen });
      }
      return;
    }

    if (message.type === 'saveConnection') {
      const { id, password, keyPassphrase, ...connectionFields } = message.payload;
      // Read before the update: an auth-method switch orphans the previous
      // method's secret, and after the write there is no "previous" left.
      const previousMethod = id
        ? this.connectionManager.list().find((c) => c.id === id)?.authMethod
        : undefined;
      const saved = id
        ? await this.connectionManager.update(id, connectionFields)
        : await this.connectionManager.add(connectionFields);

      if (connectionFields.authMethod === 'password' && password) {
        try {
          await withTimeout(
            this.secrets.set(saved.id, 'password', password),
            SECRET_STORE_TIMEOUT_MS,
            'Timed out writing to the system secret store',
          );
        } catch (err) {
          this.onSecretStoreError(
            `Saved "${saved.name}", but could not store its password (${err instanceof Error ? err.message : String(err)}). Open Manage Remotes and re-enter it.`,
          );
        }
      }
      if (connectionFields.authMethod === 'key' && keyPassphrase) {
        try {
          await withTimeout(
            this.secrets.set(saved.id, 'keyPassphrase', keyPassphrase),
            SECRET_STORE_TIMEOUT_MS,
            'Timed out writing to the system secret store',
          );
        } catch (err) {
          this.onSecretStoreError(
            `Saved "${saved.name}", but could not store its key passphrase (${err instanceof Error ? err.message : String(err)}). Open Manage Remotes and re-enter it.`,
          );
        }
      }

      // Stale-method cleanup: deletes only the PREVIOUS method's secret kind,
      // so a just-stored secret for the new method is never touched. A switch
      // with a blank new-secret field leaves that method credential-less --
      // the next connect fails with a clear auth error rather than silently
      // using the previous method's leftover secret.
      if (previousMethod && previousMethod !== connectionFields.authMethod) {
        await this.deleteSecrets(
          saved.id,
          [previousMethod === 'password' ? 'password' : 'keyPassphrase'],
          'auth-method switch',
        );
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

      const connections = this.connectionManager.list();
      this.onConnectionsChanged(connections);
      // Tells the webview which id was just saved (so a first-time add turns
      // into an edit for any later save in the same panel session, without
      // reopening it) and refreshes its own sidebar list in place.
      await this.panel.webview.postMessage({ nonce: this.nonce, type: 'connectionsUpdated', connections, savedId: saved.id });
      return;
    }

    if (message.type === 'deleteConnection') {
      const connection = this.connectionManager.list().find((c) => c.id === message.payload.id);
      if (!connection) return;
      const confirmed = await this.confirmDelete(connection);
      if (!confirmed) return;

      await this.connectionManager.remove(connection.id);
      if (this.connectionManager.getWorkspaceBinding() === connection.id) {
        await this.connectionManager.setWorkspaceBinding(undefined);
      }
      // The record is gone: its keychain entries must go too, or a deleted
      // connection's password lingers in the OS store indefinitely.
      await this.deleteSecrets(connection.id, ['password', 'keyPassphrase'], 'deleted connection');

      const connections = this.connectionManager.list();
      this.onConnectionsChanged(connections);
      await this.panel.webview.postMessage({ nonce: this.nonce, type: 'connectionsUpdated', connections, deletedId: connection.id });
    }
  }
}
