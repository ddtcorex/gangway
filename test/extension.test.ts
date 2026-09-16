import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { activate } from '../src/extension';

function fakeContext(): vscode.ExtensionContext {
  const memento = () => {
    const data = new Map<string, unknown>();
    return { get: <T>(k: string) => data.get(k) as T | undefined, update: async (k: string, v: unknown) => { data.set(k, v); } };
  };
  return {
    globalState: memento(),
    workspaceState: memento(),
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

describe('activate', () => {
  it('registers the upload, download, cleanup-cache, and open-connection-form commands', () => {
    const registered: string[] = [];
    const original = vscode.commands.registerCommand;
    vscode.commands.registerCommand = (id: string, handler: (...args: unknown[]) => unknown) => {
      registered.push(id);
      return original(id, handler);
    };

    activate(fakeContext());

    expect(registered).toEqual(
      expect.arrayContaining([
        'gangway.uploadFile',
        'gangway.downloadFile',
        'gangway.cleanupCache',
        'gangway.openConnectionForm',
      ]),
    );
  });

  it('registers the file commands even with no connection bound yet, so they exist as soon as one is created', () => {
    const registered: string[] = [];
    const original = vscode.commands.registerCommand;
    vscode.commands.registerCommand = (id: string, handler: (...args: unknown[]) => unknown) => {
      registered.push(id);
      return original(id, handler);
    };

    const result = activate(fakeContext());

    expect(registered).toContain('gangway.downloadFile');
    expect(result.connectionManager).toBeDefined();
    expect(result.secrets).toBeDefined();
  });
});
