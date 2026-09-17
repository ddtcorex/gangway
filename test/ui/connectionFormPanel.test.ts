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
});
