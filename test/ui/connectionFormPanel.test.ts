import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { ConnectionFormPanel } from '../../src/ui/connectionFormPanel';
import { ConnectionManager } from '../../src/connectionManager';
import { ConnectionSecretStore } from '../../src/secretStore';
import type { KeyValueStore, SecretStore } from '../../src/types';

function fakeKeyValueStore(): KeyValueStore {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      data.set(key, value);
    },
  };
}

function fakeSecretStore(): SecretStore {
  const data = new Map<string, string>();
  return {
    get: async (key: string) => data.get(key),
    store: async (key: string, value: string) => {
      data.set(key, value);
    },
    delete: async (key: string) => data.delete(key) as unknown as void,
  };
}

describe('ConnectionFormPanel', () => {
  it('rejects a message whose nonce does not match the one embedded for this panel instance', async () => {
    const manager = new ConnectionManager(fakeKeyValueStore(), fakeKeyValueStore());
    const secrets = new ConnectionSecretStore(fakeSecretStore());
    const rawPanel = vscode.window.createWebviewPanel('gangway.connectionForm', 'Connection', vscode.ViewColumn.Active, {});
    const panel = new ConnectionFormPanel(rawPanel as never, manager, secrets);

    await (rawPanel as unknown as { __test_fireMessage: (m: unknown) => void }).__test_fireMessage({
      nonce: 'wrong-nonce',
      type: 'saveConnection',
      payload: { name: 'x', host: 'x', port: 22, username: 'x', remotePath: '/', authMethod: 'password' },
    });

    expect(manager.list()).toEqual([]);
    void panel;
  });

  it('saves a new connection and its password secret when the nonce matches', async () => {
    const manager = new ConnectionManager(fakeKeyValueStore(), fakeKeyValueStore());
    const secrets = new ConnectionSecretStore(fakeSecretStore());
    const rawPanel = vscode.window.createWebviewPanel('gangway.connectionForm', 'Connection', vscode.ViewColumn.Active, {});
    const panel = new ConnectionFormPanel(rawPanel as never, manager, secrets);

    await (rawPanel as unknown as { __test_fireMessage: (m: unknown) => void }).__test_fireMessage({
      nonce: panel.nonce,
      type: 'saveConnection',
      payload: {
        name: 'staging',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        remotePath: '/var/www',
        authMethod: 'password',
        password: 'hunter2',
      },
    });

    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0].name).toBe('staging');
    await expect(secrets.get(manager.list()[0].id, 'password')).resolves.toBe('hunter2');
  });

  it('defaults a new connection to global scope, and saves it as workspace scope when the payload asks for it', async () => {
    const manager = new ConnectionManager(fakeKeyValueStore(), fakeKeyValueStore());
    const secrets = new ConnectionSecretStore(fakeSecretStore());
    const rawPanel = vscode.window.createWebviewPanel('gangway.connectionForm', 'Connection', vscode.ViewColumn.Active, {});
    const panel = new ConnectionFormPanel(rawPanel as never, manager, secrets);
    const fire = (rawPanel as unknown as { __test_fireMessage: (m: unknown) => void }).__test_fireMessage;

    await fire({
      nonce: panel.nonce,
      type: 'saveConnection',
      payload: { name: 'global-one', host: 'g.example.com', port: 22, username: 'deploy', remotePath: '/var/www', authMethod: 'password' },
    });
    await fire({
      nonce: panel.nonce,
      type: 'saveConnection',
      payload: { name: 'workspace-one', host: 'w.example.com', port: 22, username: 'deploy', remotePath: '/var/www', authMethod: 'password', scope: 'workspace' },
    });

    expect(manager.list().find((c) => c.name === 'global-one')?.scope).toBe('global');
    expect(manager.list().find((c) => c.name === 'workspace-one')?.scope).toBe('workspace');
  });

  it('moves a connection between global and workspace storage when an edit changes its scope', async () => {
    const manager = new ConnectionManager(fakeKeyValueStore(), fakeKeyValueStore());
    const secrets = new ConnectionSecretStore(fakeSecretStore());
    const rawPanel = vscode.window.createWebviewPanel('gangway.connectionForm', 'Connection', vscode.ViewColumn.Active, {});
    const panel = new ConnectionFormPanel(rawPanel as never, manager, secrets);
    const fire = (rawPanel as unknown as { __test_fireMessage: (m: unknown) => void }).__test_fireMessage;

    const created = await manager.add({
      name: 'staging', host: 'example.com', port: 22, username: 'deploy', remotePath: '/var/www', authMethod: 'password',
    });

    await fire({
      nonce: panel.nonce,
      type: 'saveConnection',
      payload: {
        id: created.id, name: 'staging', host: 'example.com', port: 22, username: 'deploy',
        remotePath: '/var/www', authMethod: 'password', scope: 'workspace',
      },
    });

    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0].scope).toBe('workspace');
  });

  it('stores the key path on the connection and the passphrase in the secret store for key auth', async () => {
    // Only the password path was ever covered, even though the form now has
    // key fields and `keyPath` is what authResolver reads to load the private
    // key: a key-auth connection saved without it can never connect.
    const manager = new ConnectionManager(fakeKeyValueStore(), fakeKeyValueStore());
    const secrets = new ConnectionSecretStore(fakeSecretStore());
    const rawPanel = vscode.window.createWebviewPanel('gangway.connectionForm', 'Connection', vscode.ViewColumn.Active, {});
    const panel = new ConnectionFormPanel(rawPanel as never, manager, secrets);

    await (rawPanel as unknown as { __test_fireMessage: (m: unknown) => void }).__test_fireMessage({
      nonce: panel.nonce,
      type: 'saveConnection',
      payload: {
        name: 'prod',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        remotePath: '/var/www',
        authMethod: 'key',
        keyPath: '/home/deploy/.ssh/id_ed25519',
        keyPassphrase: 'phrase',
      },
    });

    const created = manager.list()[0];
    expect(created.keyPath).toBe('/home/deploy/.ssh/id_ed25519');
    await expect(secrets.get(created.id, 'keyPassphrase')).resolves.toBe('phrase');
    // The key material itself must never reach the connection record.
    expect(JSON.stringify(created)).not.toContain('phrase');
  });

  it('binds the newly saved connection to the workspace, so the commands can actually use it', async () => {
    // Nothing in src/ ever called setWorkspaceBinding(): a user could create a
    // connection and store its secret, yet every command still failed with
    // "No SFTP connection is bound to this workspace yet", because
    // requireActiveConnection() resolves through the binding. V1 supports one
    // connection per workspace by design, so the connection just saved here
    // is unambiguously the one this workspace means.
    const manager = new ConnectionManager(fakeKeyValueStore(), fakeKeyValueStore());
    const secrets = new ConnectionSecretStore(fakeSecretStore());
    const rawPanel = vscode.window.createWebviewPanel('gangway.connectionForm', 'Connection', vscode.ViewColumn.Active, {});
    const panel = new ConnectionFormPanel(rawPanel as never, manager, secrets);

    await (rawPanel as unknown as { __test_fireMessage: (m: unknown) => void }).__test_fireMessage({
      nonce: panel.nonce,
      type: 'saveConnection',
      payload: {
        name: 'staging',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        remotePath: '/var/www',
        authMethod: 'agent',
      },
    });

    expect(manager.getWorkspaceBinding()).toBe(manager.list()[0].id);
  });

  it('notifies its caller with the fresh list after a save, so the Gangway tree can refresh without a window reload', async () => {
    const manager = new ConnectionManager(fakeKeyValueStore(), fakeKeyValueStore());
    const secrets = new ConnectionSecretStore(fakeSecretStore());
    const rawPanel = vscode.window.createWebviewPanel('gangway.connectionForm', 'Connection', vscode.ViewColumn.Active, {});
    const onConnectionsChanged = vi.fn();
    const panel = new ConnectionFormPanel(rawPanel as never, manager, secrets, onConnectionsChanged);

    await (rawPanel as unknown as { __test_fireMessage: (m: unknown) => void }).__test_fireMessage({
      nonce: panel.nonce,
      type: 'saveConnection',
      payload: {
        name: 'staging',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        remotePath: '/var/www',
        authMethod: 'agent',
      },
    });

    expect(onConnectionsChanged).toHaveBeenCalledWith([expect.objectContaining({ name: 'staging', id: manager.list()[0].id })]);
  });

  it('pushes the fresh connections list back to the webview after a save, including which id was just saved', async () => {
    const manager = new ConnectionManager(fakeKeyValueStore(), fakeKeyValueStore());
    const secrets = new ConnectionSecretStore(fakeSecretStore());
    const rawPanel = vscode.window.createWebviewPanel('gangway.connectionForm', 'Connection', vscode.ViewColumn.Active, {});
    const postMessage = vi.spyOn(rawPanel.webview, 'postMessage');
    const panel = new ConnectionFormPanel(rawPanel as never, manager, secrets);

    await (rawPanel as unknown as { __test_fireMessage: (m: unknown) => void }).__test_fireMessage({
      nonce: panel.nonce,
      type: 'saveConnection',
      payload: { name: 'staging', host: 'example.com', port: 22, username: 'deploy', remotePath: '/var/www', authMethod: 'agent' },
    });

    const savedId = manager.list()[0].id;
    expect(postMessage).toHaveBeenCalledWith({
      nonce: panel.nonce,
      type: 'connectionsUpdated',
      connections: manager.list(),
      savedId,
    });
  });

  it('never binds anything when the message nonce does not match', async () => {
    const manager = new ConnectionManager(fakeKeyValueStore(), fakeKeyValueStore());
    const secrets = new ConnectionSecretStore(fakeSecretStore());
    const rawPanel = vscode.window.createWebviewPanel('gangway.connectionForm', 'Connection', vscode.ViewColumn.Active, {});
    new ConnectionFormPanel(rawPanel as never, manager, secrets);

    await (rawPanel as unknown as { __test_fireMessage: (m: unknown) => void }).__test_fireMessage({
      nonce: 'wrong-nonce',
      type: 'saveConnection',
      payload: { name: 'x', host: 'x', port: 22, username: 'x', remotePath: '/', authMethod: 'agent' },
    });

    expect(manager.getWorkspaceBinding()).toBeUndefined();
  });

  it('updates an existing connection in place when the payload carries its id, and never touches the workspace binding', async () => {
    const manager = new ConnectionManager(fakeKeyValueStore(), fakeKeyValueStore());
    const secrets = new ConnectionSecretStore(fakeSecretStore());
    const existing = await manager.add({
      name: 'staging',
      host: 'old-host.example.com',
      port: 22,
      username: 'deploy',
      remotePath: '/var/www',
      authMethod: 'password',
    });
    // A different connection is the one actually bound right now -- editing
    // "staging" must not silently switch the active connection out from
    // under the user.
    const otherBound = await manager.add({
      name: 'prod',
      host: 'prod.example.com',
      port: 22,
      username: 'deploy',
      remotePath: '/var/www',
      authMethod: 'agent',
    });
    await manager.setWorkspaceBinding(otherBound.id);

    const rawPanel = vscode.window.createWebviewPanel('gangway.connectionForm', 'Connection', vscode.ViewColumn.Active, {});
    const panel = new ConnectionFormPanel(rawPanel as never, manager, secrets);

    await (rawPanel as unknown as { __test_fireMessage: (m: unknown) => void }).__test_fireMessage({
      nonce: panel.nonce,
      type: 'saveConnection',
      payload: {
        id: existing.id,
        name: 'staging-renamed',
        host: 'new-host.example.com',
        port: 2222,
        username: 'deploy',
        remotePath: '/var/www/html',
        authMethod: 'password',
        password: 'new-password',
      },
    });

    expect(manager.list()).toHaveLength(2);
    const updated = manager.list().find((c) => c.id === existing.id)!;
    expect(updated).toMatchObject({ name: 'staging-renamed', host: 'new-host.example.com', port: 2222, remotePath: '/var/www/html' });
    await expect(secrets.get(existing.id, 'password')).resolves.toBe('new-password');
    expect(manager.getWorkspaceBinding()).toBe(otherBound.id);
  });

  it('replies with the chosen path when the webview asks to browse for a key file', async () => {
    const manager = new ConnectionManager(fakeKeyValueStore(), fakeKeyValueStore());
    const secrets = new ConnectionSecretStore(fakeSecretStore());
    const rawPanel = vscode.window.createWebviewPanel('gangway.connectionForm', 'Connection', vscode.ViewColumn.Active, {});
    const postMessage = vi.spyOn(rawPanel.webview, 'postMessage');
    const panel = new ConnectionFormPanel(rawPanel as never, manager, secrets, undefined, async () => '/home/deploy/.ssh/id_ed25519');

    await (rawPanel as unknown as { __test_fireMessage: (m: unknown) => void }).__test_fireMessage({
      nonce: panel.nonce,
      type: 'browseKeyPath',
    });

    expect(postMessage).toHaveBeenCalledWith({ nonce: panel.nonce, type: 'keyPathSelected', path: '/home/deploy/.ssh/id_ed25519' });
  });

  it('sends no message back when the user cancels the file picker', async () => {
    const manager = new ConnectionManager(fakeKeyValueStore(), fakeKeyValueStore());
    const secrets = new ConnectionSecretStore(fakeSecretStore());
    const rawPanel = vscode.window.createWebviewPanel('gangway.connectionForm', 'Connection', vscode.ViewColumn.Active, {});
    const postMessage = vi.spyOn(rawPanel.webview, 'postMessage');
    const panel = new ConnectionFormPanel(rawPanel as never, manager, secrets, undefined, async () => undefined);

    await (rawPanel as unknown as { __test_fireMessage: (m: unknown) => void }).__test_fireMessage({
      nonce: panel.nonce,
      type: 'browseKeyPath',
    });

    expect(postMessage).not.toHaveBeenCalled();
  });

  describe('deleteConnection', () => {
    async function setup(confirmDelete: (c: import('../../src/types').ConnectionConfig) => Promise<boolean>) {
      const manager = new ConnectionManager(fakeKeyValueStore(), fakeKeyValueStore());
      const secrets = new ConnectionSecretStore(fakeSecretStore());
      const target = await manager.add({
        name: 'staging',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        remotePath: '/var/www',
        authMethod: 'password',
      });
      const rawPanel = vscode.window.createWebviewPanel('gangway.connectionForm', 'Connection', vscode.ViewColumn.Active, {});
      const onConnectionsChanged = vi.fn();
      const panel = new ConnectionFormPanel(rawPanel as never, manager, secrets, onConnectionsChanged, undefined, confirmDelete);
      return { manager, rawPanel, panel, onConnectionsChanged, target };
    }

    it('removes the connection and clears the workspace binding when it was the bound one, after confirmation', async () => {
      const { manager, rawPanel, panel, onConnectionsChanged, target } = await setup(async () => true);
      await manager.setWorkspaceBinding(target.id);
      const postMessage = vi.spyOn(rawPanel.webview, 'postMessage');

      await (rawPanel as unknown as { __test_fireMessage: (m: unknown) => void }).__test_fireMessage({
        nonce: panel.nonce,
        type: 'deleteConnection',
        payload: { id: target.id },
      });

      expect(manager.list()).toEqual([]);
      expect(manager.getWorkspaceBinding()).toBeUndefined();
      expect(onConnectionsChanged).toHaveBeenCalledWith([]);
      expect(postMessage).toHaveBeenCalledWith({ nonce: panel.nonce, type: 'connectionsUpdated', connections: [], deletedId: target.id });
    });

    it('does nothing when the confirmation is declined', async () => {
      const { manager, rawPanel, panel, onConnectionsChanged, target } = await setup(async () => false);

      await (rawPanel as unknown as { __test_fireMessage: (m: unknown) => void }).__test_fireMessage({
        nonce: panel.nonce,
        type: 'deleteConnection',
        payload: { id: target.id },
      });

      expect(manager.list()).toHaveLength(1);
      expect(onConnectionsChanged).not.toHaveBeenCalled();
    });

    it('still completes the delete and warns when the keychain refuses the secret cleanup', async () => {
      const manager = new ConnectionManager(fakeKeyValueStore(), fakeKeyValueStore());
      const secrets = new ConnectionSecretStore({
        get: async () => undefined,
        store: async () => {},
        delete: async () => {
          throw new Error('keyring is locked');
        },
      });
      const target = await manager.add({
        name: 'staging',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        remotePath: '/var/www',
        authMethod: 'password',
      });
      const rawPanel = vscode.window.createWebviewPanel('gangway.connectionForm', 'Connection', vscode.ViewColumn.Active, {});
      const onSecretStoreError = vi.fn();
      const panel = new ConnectionFormPanel(rawPanel as never, manager, secrets, () => {}, undefined, async () => true, onSecretStoreError);

      await (rawPanel as unknown as { __test_fireMessage: (m: unknown) => void }).__test_fireMessage({
        nonce: panel.nonce,
        type: 'deleteConnection',
        payload: { id: target.id },
      });

      expect(manager.list()).toEqual([]);
      expect(onSecretStoreError).toHaveBeenCalledWith(expect.stringContaining('keyring is locked'));
    });

    it('never rebinds a still-existing, different connection when the deleted one was not the bound one', async () => {
      const { manager, rawPanel, panel, target } = await setup(async () => true);
      const other = await manager.add({
        name: 'prod',
        host: 'prod.example.com',
        port: 22,
        username: 'deploy',
        remotePath: '/var/www',
        authMethod: 'agent',
      });
      await manager.setWorkspaceBinding(other.id);

      await (rawPanel as unknown as { __test_fireMessage: (m: unknown) => void }).__test_fireMessage({
        nonce: panel.nonce,
        type: 'deleteConnection',
        payload: { id: target.id },
      });

      expect(manager.getWorkspaceBinding()).toBe(other.id);
    });

    it('deletes both kinds of stored secrets so nothing lingers in the keychain', async () => {
      const manager = new ConnectionManager(fakeKeyValueStore(), fakeKeyValueStore());
      const backing = fakeSecretStore();
      const secrets = new ConnectionSecretStore(backing);
      const target = await manager.add({
        name: 'staging',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        remotePath: '/var/www',
        authMethod: 'password',
      });
      await secrets.set(target.id, 'password', 'hunter2');
      await secrets.set(target.id, 'keyPassphrase', 'old-phrase');
      const rawPanel = vscode.window.createWebviewPanel('gangway.connectionForm', 'Connection', vscode.ViewColumn.Active, {});
      const panel = new ConnectionFormPanel(rawPanel as never, manager, secrets, () => {}, undefined, async () => true);

      await (rawPanel as unknown as { __test_fireMessage: (m: unknown) => void }).__test_fireMessage({
        nonce: panel.nonce,
        type: 'deleteConnection',
        payload: { id: target.id },
      });

      await expect(secrets.get(target.id, 'password')).resolves.toBeUndefined();
      await expect(secrets.get(target.id, 'keyPassphrase')).resolves.toBeUndefined();
    });
  });

  describe('auth-method switch', () => {
    async function setupSwitch() {
      const manager = new ConnectionManager(fakeKeyValueStore(), fakeKeyValueStore());
      const secrets = new ConnectionSecretStore(fakeSecretStore());
      const target = await manager.add({
        name: 'staging',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        remotePath: '/var/www',
        authMethod: 'password',
      });
      await secrets.set(target.id, 'password', 'hunter2');
      const rawPanel = vscode.window.createWebviewPanel('gangway.connectionForm', 'Connection', vscode.ViewColumn.Active, {});
      const panel = new ConnectionFormPanel(rawPanel as never, manager, secrets);
      const fire = (payload: unknown) =>
        (rawPanel as unknown as { __test_fireMessage: (m: unknown) => Promise<void> }).__test_fireMessage({
          nonce: panel.nonce,
          type: 'saveConnection',
          payload,
        });
      return { manager, secrets, target, fire };
    }

    it('drops the password secret when switching from password to key auth', async () => {
      const { secrets, target, fire } = await setupSwitch();
      await fire({ id: target.id, name: 'staging', host: 'example.com', port: 22, username: 'deploy', remotePath: '/var/www', authMethod: 'key', keyPath: '/home/deploy/.ssh/id_ed25519', keyPassphrase: 'new-phrase' });

      await expect(secrets.get(target.id, 'password')).resolves.toBeUndefined();
      await expect(secrets.get(target.id, 'keyPassphrase')).resolves.toBe('new-phrase');
    });

    it('drops the key passphrase when switching from key to password auth', async () => {
      const { manager, secrets, fire } = await setupSwitch();
      const keyed = await manager.add({
        name: 'keyed',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        remotePath: '/var/www',
        authMethod: 'key',
      });
      await secrets.set(keyed.id, 'keyPassphrase', 'old-phrase');

      await fire({ id: keyed.id, name: 'keyed', host: 'example.com', port: 22, username: 'deploy', remotePath: '/var/www', authMethod: 'password', password: 'fresh' });

      await expect(secrets.get(keyed.id, 'keyPassphrase')).resolves.toBeUndefined();
      await expect(secrets.get(keyed.id, 'password')).resolves.toBe('fresh');
    });
  });

  describe('a secret store that fails or hangs', () => {
    // Discovered against a real Extension Development Host: an unresponsive
    // secrets.set() call (the OS keyring locked, unavailable, or just slow)
    // used to leave the ENTIRE save stuck behind that one unresolved await --
    // the connection record was written, but the workspace binding, the tree
    // refresh, and the webview's own reply never happened, with no error
    // anywhere. Every unit test's fake secret store always settled instantly,
    // so this gap was invisible until it was driven live.
    it('still completes the save and notifies its caller when secrets.set() rejects', async () => {
      const manager = new ConnectionManager(fakeKeyValueStore(), fakeKeyValueStore());
      const secrets = new ConnectionSecretStore({
        get: async () => undefined,
        store: async () => {
          throw new Error('keyring is locked');
        },
        delete: async () => {},
      });
      const rawPanel = vscode.window.createWebviewPanel('gangway.connectionForm', 'Connection', vscode.ViewColumn.Active, {});
      const onConnectionsChanged = vi.fn();
      const onSecretStoreError = vi.fn();
      const postMessage = vi.spyOn(rawPanel.webview, 'postMessage');
      const panel = new ConnectionFormPanel(
        rawPanel as never,
        manager,
        secrets,
        onConnectionsChanged,
        undefined,
        undefined,
        onSecretStoreError,
      );

      await (rawPanel as unknown as { __test_fireMessage: (m: unknown) => void }).__test_fireMessage({
        nonce: panel.nonce,
        type: 'saveConnection',
        payload: {
          name: 'staging',
          host: 'example.com',
          port: 22,
          username: 'deploy',
          remotePath: '/var/www',
          authMethod: 'password',
          password: 'hunter2',
        },
      });

      expect(manager.list()).toHaveLength(1);
      expect(manager.getWorkspaceBinding()).toBe(manager.list()[0].id);
      expect(onConnectionsChanged).toHaveBeenCalledWith(manager.list());
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'connectionsUpdated' }));
      expect(onSecretStoreError).toHaveBeenCalledWith(expect.stringContaining('keyring is locked'));
    });

    it('times out and still completes the save when secrets.set() never settles at all', async () => {
      vi.useFakeTimers();
      try {
        const manager = new ConnectionManager(fakeKeyValueStore(), fakeKeyValueStore());
        const secrets = new ConnectionSecretStore({
          get: async () => undefined,
          store: () => new Promise(() => {}), // never resolves or rejects
          delete: async () => {},
        });
        const rawPanel = vscode.window.createWebviewPanel('gangway.connectionForm', 'Connection', vscode.ViewColumn.Active, {});
        const onConnectionsChanged = vi.fn();
        const onSecretStoreError = vi.fn();
        const panel = new ConnectionFormPanel(
          rawPanel as never,
          manager,
          secrets,
          onConnectionsChanged,
          undefined,
          undefined,
          onSecretStoreError,
        );

        const fired = (rawPanel as unknown as { __test_fireMessage: (m: unknown) => Promise<void> }).__test_fireMessage({
          nonce: panel.nonce,
          type: 'saveConnection',
          payload: {
            name: 'staging',
            host: 'example.com',
            port: 22,
            username: 'deploy',
            remotePath: '/var/www',
            authMethod: 'password',
            password: 'hunter2',
          },
        });

        await vi.advanceTimersByTimeAsync(5_000);
        await fired;

        expect(manager.list()).toHaveLength(1);
        expect(manager.getWorkspaceBinding()).toBe(manager.list()[0].id);
        expect(onConnectionsChanged).toHaveBeenCalledWith(manager.list());
        expect(onSecretStoreError).toHaveBeenCalledWith(expect.stringContaining('Timed out'));
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
