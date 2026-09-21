import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { window as mockWindow, workspace as mockWorkspace } from './mocks/vscode';

/**
 * `gangway.compareWorkspaceFile` (workspace Explorer context menu): resolve
 * the clicked workspace file through the ACTIVE connection's mappings,
 * download the server's fresh bytes to a staging file, and open
 * `vscode.diff` read-only. Same harness shape as
 * `test/mappedExplorer.test.ts` (connectionPool module mock, real
 * mappedTransfer path, no network).
 */

const fakeRawClient = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  end: vi.fn().mockResolvedValue(undefined),
  list: vi.fn().mockResolvedValue([] as Array<{ name: string; type: string }>),
  stat: vi.fn().mockResolvedValue({ size: 0, modifyTime: 0, isDirectory: false, isSymbolicLink: false }),
  fastGet: vi.fn().mockImplementation(async (_remotePath: string, localPath: string) => {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, 'server content');
  }),
  fastPut: vi.fn().mockResolvedValue(undefined),
  posixRename: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rmdir: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
}));

function resetFakeClient(): void {
  fakeRawClient.connect.mockClear();
  fakeRawClient.end.mockClear();
  fakeRawClient.list.mockReset().mockResolvedValue([]);
  fakeRawClient.stat.mockReset().mockResolvedValue({ size: 0, modifyTime: 0, isDirectory: false, isSymbolicLink: false });
  fakeRawClient.fastGet.mockClear();
  fakeRawClient.fastPut.mockClear();
  fakeRawClient.posixRename.mockClear();
  fakeRawClient.delete.mockClear();
  fakeRawClient.mkdir.mockClear();
  fakeRawClient.rmdir.mockClear();
  fakeRawClient.chmod.mockClear();
}

vi.mock('../src/transfer/connectionPool', () => ({
  ConnectionPool: vi.fn().mockImplementation(() => ({
    getClient: vi.fn().mockResolvedValue(fakeRawClient),
    invalidate: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
    hasClient: vi.fn().mockReturnValue(true),
  })),
}));

import { activate } from '../src/extension';
import type { ConnectionManager } from '../src/connectionManager';
import type { ConnectionConfig } from '../src/types';

const originalRegisterCommand = vscode.commands.registerCommand;

let tmpHome: string;
let wsRoot: string;
let globalStorageDir: string;
let handlers: Map<string, (...args: unknown[]) => unknown>;
let connectionManager: ConnectionManager;
let connection: ConnectionConfig;
let osTmpdirSpy: ReturnType<typeof vi.spyOn>;
let previousFolders: unknown;

function fakeContext(): vscode.ExtensionContext {
  const memento = (seed?: Record<string, unknown>) => {
    const data = new Map<string, unknown>(Object.entries(seed ?? {}));
    return {
      get: <T>(k: string): T | undefined => data.get(k) as T | undefined,
      update: async (k: string, v: unknown): Promise<void> => {
        data.set(k, v);
      },
    };
  };
  return {
    globalState: memento(),
    workspaceState: memento(),
    globalStorageUri: { fsPath: globalStorageDir },
    extensionUri: { fsPath: path.join(tmpHome, 'gangway-extension-root'), scheme: 'file' },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gangway-compare-ws-test-'));
  wsRoot = path.join(tmpHome, 'proj');
  globalStorageDir = path.join(tmpHome, 'global-storage');
  await fs.mkdir(wsRoot, { recursive: true });
  osTmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(tmpHome);
  mockWindow.__test_resetAnswers();
  resetFakeClient();
  vscode.window.activeTextEditor = undefined;
  previousFolders = mockWorkspace.workspaceFolders;
  mockWorkspace.workspaceFolders = [{ uri: { fsPath: wsRoot }, name: 'proj' }];

  handlers = new Map();
  const original = vscode.commands.registerCommand;
  vscode.commands.registerCommand = (id: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(id, handler);
    return original(id, handler);
  };

  const result = activate(fakeContext());
  connectionManager = result.connectionManager;
  connection = await connectionManager.add({
    name: 'staging',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    remotePath: '/var/www',
    authMethod: 'password',
    scope: 'workspace',
    mappings: [{ localPath: wsRoot, remotePath: '/var/www' }],
  });
  await connectionManager.setWorkspaceBinding(connection.id);
});

afterEach(async () => {
  osTmpdirSpy.mockRestore();
  vscode.commands.registerCommand = originalRegisterCommand;
  mockWorkspace.workspaceFolders = previousFolders as typeof mockWorkspace.workspaceFolders;
  vscode.window.activeTextEditor = undefined;
  mockWindow.__test_resetAnswers();
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe('compareWorkspaceFile command', () => {
  it('registers gangway.compareWorkspaceFile', () => {
    expect(handlers.has('gangway.compareWorkspaceFile')).toBe(true);
  });

  it('warns with the effective default and offers Open Mappings when the file sits outside every mapping', async () => {
    const outside = path.join(tmpHome, 'elsewhere', 'app.php');
    await fs.mkdir(path.dirname(outside), { recursive: true });
    await fs.writeFile(outside, '<?php echo 1;');
    mockWindow.__test_queueWarning('Open Mappings');
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    const execSpy = vi.spyOn(vscode.commands, 'executeCommand');

    await handlers.get('gangway.compareWorkspaceFile')!({ fsPath: outside });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('is not inside any path mapping'),
      'Open Mappings',
      'Cancel',
    );
    expect(execSpy).toHaveBeenCalledWith('gangway.manageRemotes');
    expect(fakeRawClient.fastGet).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    execSpy.mockRestore();
  });

  it('opens vscode.diff between the workspace file and a staged server copy', async () => {
    const localFile = path.join(wsRoot, 'app.php');
    await fs.writeFile(localFile, '<?php echo local;');
    const execSpy = vi.spyOn(vscode.commands, 'executeCommand');

    await handlers.get('gangway.compareWorkspaceFile')!({ fsPath: localFile });

    expect(fakeRawClient.fastGet).toHaveBeenCalledWith('/var/www/app.php', expect.stringContaining('.gangway-compare-workspace'));
    expect(execSpy).toHaveBeenCalledWith(
      'vscode.diff',
      expect.objectContaining({ fsPath: localFile }),
      expect.objectContaining({ fsPath: expect.stringContaining('.gangway-compare-workspace') }),
      'app.php: workspace ↔ server (current)',
    );
    execSpy.mockRestore();
  });

  it('warns plainly with no action when the remote file does not exist', async () => {
    const localFile = path.join(wsRoot, 'new.php');
    await fs.writeFile(localFile, '<?php echo 1;');
    fakeRawClient.stat.mockRejectedValue(Object.assign(new Error('No such file'), { code: '2' }));
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');
    const execSpy = vi.spyOn(vscode.commands, 'executeCommand');

    await handlers.get('gangway.compareWorkspaceFile')!({ fsPath: localFile });

    expect(warnSpy).toHaveBeenCalledWith('No such file on server: /var/www/new.php.');
    expect(fakeRawClient.fastGet).not.toHaveBeenCalled();
    expect(execSpy).not.toHaveBeenCalledWith('vscode.diff', expect.anything(), expect.anything(), expect.anything());
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    execSpy.mockRestore();
  });

  it('compares even when the connection is frozen (read-only, no frozen gate)', async () => {    await connectionManager.update(connection.id, { frozen: true });
    const localFile = path.join(wsRoot, 'app.php');
    await fs.writeFile(localFile, '<?php echo 1;');
    const execSpy = vi.spyOn(vscode.commands, 'executeCommand');
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

    await handlers.get('gangway.compareWorkspaceFile')!({ fsPath: localFile });

    expect(execSpy).toHaveBeenCalledWith('vscode.diff', expect.anything(), expect.anything(), expect.anything());
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringMatching(/frozen/i));
    execSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('refuses a folder with a files-only warning and transfers nothing', async () => {
    const localDir = path.join(wsRoot, 'sub');
    await fs.mkdir(localDir, { recursive: true });
    fakeRawClient.stat.mockResolvedValue({ size: 0, modifyTime: 0, isDirectory: true, isSymbolicLink: false });
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');

    await handlers.get('gangway.compareWorkspaceFile')!({ fsPath: localDir });

    expect(warnSpy).toHaveBeenCalledWith('Compare works on files, not folders.');
    expect(fakeRawClient.fastGet).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('falls back to the active editor when invoked without a Uri', async () => {
    const localFile = path.join(wsRoot, 'app.php');
    await fs.writeFile(localFile, '<?php echo local;');
    vscode.window.activeTextEditor = { document: { uri: { fsPath: localFile } } } as unknown as vscode.TextEditor;
    const execSpy = vi.spyOn(vscode.commands, 'executeCommand');

    await handlers.get('gangway.compareWorkspaceFile')!(undefined);

    expect(execSpy).toHaveBeenCalledWith('vscode.diff', expect.objectContaining({ fsPath: localFile }), expect.anything(), expect.anything());
    execSpy.mockRestore();
  });
});
