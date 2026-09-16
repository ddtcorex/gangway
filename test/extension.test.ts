import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';

// Shared fake raw SFTP client, created via vi.hoisted so both the
// vi.mock('../src/transfer/connectionPool', ...) factory below and the test
// bodies can reference the exact same object (assert on its vi.fn() calls,
// reset it between tests). Its shape matches `RawSftpClient`
// (src/transfer/sftpClientAdapter.ts): connect/end/stat/fastGet/fastPut/
// rename/list. Real SFTP `stat()` returns `modifyTime`, never `mtime` --
// `SftpClientAdapter` translates it, so this fake returns `modifyTime` too,
// exercising the same translation path a real connection would.
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
  rename: vi.fn().mockResolvedValue(undefined),
}));

function resetFakeClient(): void {
  fakeRawClient.connect.mockClear();
  fakeRawClient.end.mockClear();
  fakeRawClient.list.mockReset().mockResolvedValue([]);
  fakeRawClient.stat.mockReset().mockResolvedValue({ size: 0, modifyTime: 0, isDirectory: false, isSymbolicLink: false });
  fakeRawClient.fastGet.mockClear();
  fakeRawClient.fastPut.mockClear();
  fakeRawClient.rename.mockClear();
}

// activate() builds its own ConnectionPool internally (not injectable), and
// the real pool's clientFactory constructs a real `ssh2-sftp-client` that
// would attempt an actual TCP/SSH handshake. Replacing the whole module lets
// realistic-invocation tests below exercise the full command handler --
// including SftpClientAdapter's translation and the real downloadFile/
// uploadFile library functions -- without any real network I/O.
vi.mock('../src/transfer/connectionPool', () => ({
  ConnectionPool: vi.fn().mockImplementation(() => ({
    getClient: vi.fn().mockResolvedValue(fakeRawClient),
  })),
}));

import { activate } from '../src/extension';
import { writeSidecar } from '../src/tmpStore';
import { tmpFilePathFor } from '../src/tmpPath';
import type { ConnectionConfig } from '../src/types';

function fakeContext(): vscode.ExtensionContext {
  const memento = (seed?: Record<string, unknown>) => {
    const data = new Map<string, unknown>(Object.entries(seed ?? {}));
    return { get: <T>(k: string) => data.get(k) as T | undefined, update: async (k: string, v: unknown) => { data.set(k, v); } };
  };
  return {
    // Seeds `gangway.auditLogPath` with `os.tmpdir()` so AuditLog.append()
    // (invoked by every successful upload below) writes into the disposable
    // per-test tmp directory instead of defaulting to `.` -- the real
    // process cwd -- which would otherwise leave a stray
    // `sftp-hotfix-uploads.log` in the repo working tree after every test run.
    globalState: memento({ 'gangway.auditLogPath': os.tmpdir() }),
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
        'gangway.downloadFolder',
        'gangway.uploadFolder',
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

/**
 * Every command above is only tested for *registration*, never for
 * *realistic invocation*: VS Code invokes a command very differently
 * depending on the trigger. A keybinding can only pass a static `args`
 * value (or nothing); a tree-view context-menu entry always passes the
 * clicked `RemoteTreeNode` (`{ entry: RemoteEntry }`), never a raw path
 * string. These tests call the actually-registered handlers the way a real
 * VS Code gesture would, and confirm they resolve the remote/local paths
 * correctly instead of just not crashing.
 */
describe('activate - realistic command invocation', () => {
  let tmpHome: string;
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  let connection: ConnectionConfig;
  let osTmpdirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gangway-ext-test-'));
    // Deliberately a *targeted* spy restored by its own reference below,
    // never `vi.restoreAllMocks()`: that global call also tears down the
    // `vi.mock('../src/transfer/connectionPool', ...)` factory's mock
    // implementation and the hoisted `fakeRawClient` vi.fn()s (they are
    // mocks, not spies-with-an-original, so "restoring" them leaves them
    // with no implementation at all) -- breaking every test that runs
    // after the first one that used a scoped spy.
    osTmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(tmpHome);
    resetFakeClient();
    vscode.window.activeTextEditor = undefined;

    handlers = new Map();
    const original = vscode.commands.registerCommand;
    vscode.commands.registerCommand = (id: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(id, handler);
      return original(id, handler);
    };

    const result = activate(fakeContext());
    connection = await result.connectionManager.add({
      name: 'staging',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      remotePath: '/var/www',
      authMethod: 'password',
    });
    await result.connectionManager.setWorkspaceBinding(connection.id);
  });

  afterEach(async () => {
    osTmpdirSpy.mockRestore();
    vscode.window.activeTextEditor = undefined;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('gangway.downloadFile resolves the remote path from the tree node (RemoteTreeNode), not a raw string', async () => {
    fakeRawClient.stat.mockResolvedValue({ size: 5, modifyTime: 1700000000000, isDirectory: false, isSymbolicLink: false });
    const handler = handlers.get('gangway.downloadFile')!;

    await handler({ entry: { path: '/var/www/app/config.php', isDirectory: false, isSymbolicLink: false, size: 5 } });

    expect(fakeRawClient.stat).toHaveBeenCalledWith('/var/www/app/config.php');
    expect(fakeRawClient.fastGet).toHaveBeenCalledWith('/var/www/app/config.php', expect.any(String));
  });

  it('gangway.downloadFile derives the remote path from the active editor + its sidecar when invoked with no arguments (the real keybinding case, refreshing from server)', async () => {
    const localPath = path.join(tmpHome, 'stale-config.php');
    await fs.writeFile(localPath, 'stale local content');
    await writeSidecar(localPath, {
      connectionId: connection.id,
      remotePath: '/var/www/app/config.php',
      mtime: 1700000000000,
      size: 5,
      downloadedAt: Date.now(),
    });
    fakeRawClient.stat.mockResolvedValue({ size: 5, modifyTime: 1700000000000, isDirectory: false, isSymbolicLink: false });
    vscode.window.activeTextEditor = { document: { uri: { fsPath: localPath } } } as unknown as vscode.TextEditor;

    const handler = handlers.get('gangway.downloadFile')!;
    await handler();

    expect(fakeRawClient.stat).toHaveBeenCalledWith('/var/www/app/config.php');
    expect(fakeRawClient.fastGet).toHaveBeenCalledWith('/var/www/app/config.php', expect.any(String));
  });

  it('gangway.downloadFile warns and never touches the network when invoked with no arguments and no active editor', async () => {
    vscode.window.activeTextEditor = undefined;
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    const handler = handlers.get('gangway.downloadFile')!;

    await handler(undefined);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No active editor'));
    expect(fakeRawClient.stat).not.toHaveBeenCalled();
  });

  it('gangway.downloadFile warns cleanly when invoked with no arguments and the open file has no Gangway sidecar metadata', async () => {
    const localPath = path.join(tmpHome, 'not-managed.php');
    await fs.writeFile(localPath, 'plain content');
    vscode.window.activeTextEditor = { document: { uri: { fsPath: localPath } } } as unknown as vscode.TextEditor;
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');

    const handler = handlers.get('gangway.downloadFile')!;
    await handler();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not a Gangway-managed file'));
    expect(fakeRawClient.stat).not.toHaveBeenCalled();
  });

  it('gangway.downloadFolder resolves the remote path from the tree node and walks it, not a raw string', async () => {
    fakeRawClient.list.mockImplementation(async (dirPath: string) =>
      dirPath === '/var/www/app' ? [{ name: 'config.php', type: '-' }] : [],
    );
    const handler = handlers.get('gangway.downloadFolder')!;

    await handler({ entry: { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 } });

    expect(fakeRawClient.list).toHaveBeenCalledWith('/var/www/app');
    expect(fakeRawClient.fastGet).toHaveBeenCalledWith('/var/www/app/config.php', expect.any(String));
  });

  it('gangway.downloadFolder warns and never touches the network when invoked with no node', async () => {
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    const handler = handlers.get('gangway.downloadFolder')!;

    await handler(undefined);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Select a folder'));
    expect(fakeRawClient.list).not.toHaveBeenCalled();
  });

  it('gangway.uploadFolder derives localRoot from the connection (never a second invocation argument) and reports the outcome', async () => {
    fakeRawClient.list.mockImplementation(async (dirPath: string) =>
      dirPath === '/var/www/app' ? [{ name: 'clean.php', type: '-' }] : [],
    );
    // Simulates the file already having been downloaded before this edit/upload.
    const localFile = tmpFilePathFor(connection, '/var/www/app/clean.php');
    await fs.mkdir(path.dirname(localFile), { recursive: true });
    await fs.writeFile(localFile, 'clean content');
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

    const handler = handlers.get('gangway.uploadFolder')!;
    await handler({ entry: { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 } });

    expect(fakeRawClient.fastPut).toHaveBeenCalledWith(localFile, '/var/www/app/clean.php.tmp');
    expect(fakeRawClient.rename).toHaveBeenCalledWith('/var/www/app/clean.php.tmp', '/var/www/app/clean.php');
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Uploaded 1 file(s)'));
  });

  it('gangway.uploadFolder warns and never touches the network when invoked with no node', async () => {
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    const handler = handlers.get('gangway.uploadFolder')!;

    await handler(undefined);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Select a folder'));
    expect(fakeRawClient.list).not.toHaveBeenCalled();
  });

  it('gangway.uploadFile derives localPath/remotePath from the active editor + its sidecar when invoked with no arguments (the real keybinding case)', async () => {
    const localPath = path.join(tmpHome, 'edited-config.php');
    await fs.writeFile(localPath, 'edited content');
    await writeSidecar(localPath, {
      connectionId: connection.id,
      remotePath: '/var/www/app/config.php',
      mtime: 1700000000000,
      size: 5,
      downloadedAt: Date.now(),
    });
    fakeRawClient.stat.mockResolvedValue({ size: 5, modifyTime: 1700000000000, isDirectory: false, isSymbolicLink: false });
    vscode.window.activeTextEditor = { document: { uri: { fsPath: localPath } } } as unknown as vscode.TextEditor;

    const handler = handlers.get('gangway.uploadFile')!;
    await handler();

    expect(fakeRawClient.stat).toHaveBeenCalledWith('/var/www/app/config.php');
    expect(fakeRawClient.fastPut).toHaveBeenCalledWith(localPath, '/var/www/app/config.php.tmp');
    expect(fakeRawClient.rename).toHaveBeenCalledWith('/var/www/app/config.php.tmp', '/var/www/app/config.php');
  });

  it('gangway.uploadFile warns and never attempts an upload when there is no active editor', async () => {
    vscode.window.activeTextEditor = undefined;
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');

    const handler = handlers.get('gangway.uploadFile')!;
    await handler();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No active editor'));
    expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
  });

  it('gangway.uploadFile warns cleanly when the open file has no Gangway sidecar metadata', async () => {
    const localPath = path.join(tmpHome, 'not-managed.php');
    await fs.writeFile(localPath, 'plain content');
    vscode.window.activeTextEditor = { document: { uri: { fsPath: localPath } } } as unknown as vscode.TextEditor;
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');

    const handler = handlers.get('gangway.uploadFile')!;
    await handler();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not a Gangway-managed file'));
    expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
  });

  it('gangway.uploadFile still accepts explicit localPath/remotePath arguments (Task 19 E2E contract)', async () => {
    const localPath = path.join(tmpHome, 'explicit.php');
    await fs.writeFile(localPath, 'explicit content');

    const handler = handlers.get('gangway.uploadFile')!;
    await handler(localPath, '/var/www/app/explicit.php');

    expect(fakeRawClient.fastPut).toHaveBeenCalledWith(localPath, '/var/www/app/explicit.php.tmp');
    expect(fakeRawClient.rename).toHaveBeenCalledWith('/var/www/app/explicit.php.tmp', '/var/www/app/explicit.php');
  });
});
