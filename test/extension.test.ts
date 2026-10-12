import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
// Relative mock import for the test-only answer queues (__test_queue*):
// same runtime instance the handlers use, full types under tsc.
import { window as mockWindow } from './mocks/vscode';
import { env as mockEnv } from './mocks/vscode';

// Shared fake raw SFTP client, created via vi.hoisted so both the
// vi.mock('../src/transfer/connectionPool', ...) factory below and the test
// bodies can reference the exact same object (assert on its vi.fn() calls,
// reset it between tests). Its shape matches `RawSftpClient`
// (src/transfer/sftpClientAdapter.ts): connect/end/stat/fastGet/fastPut/
// posixRename/delete/mkdir/list. Real SFTP `stat()` returns `modifyTime`, never `mtime` --
// `SftpClientAdapter` translates it, so this fake returns `modifyTime` too,
// exercising the same translation path a real connection would.
const fakeRawClient = vi.hoisted(() => {
  const client = {
  connect: vi.fn().mockResolvedValue(undefined),
  end: vi.fn().mockResolvedValue(undefined),
  list: vi.fn().mockResolvedValue([] as Array<{ name: string; type: string }>),
  stat: vi.fn().mockResolvedValue({ size: 0, modifyTime: 0, isDirectory: false, isSymbolicLink: false }),
  // Identity realPath and a not-a-link lstat by default, so every plain-file
  // test resolves exactly as before; link tests override both. lstat answers
  // like the stat fake (missing for stat is missing for lstat).
  lstat: vi.fn().mockImplementation(async (p: string) => ({ ...(await client.stat(p)), isSymbolicLink: false })),
  realPath: vi.fn().mockImplementation(async (p: string) => p),
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
  };
  return client;
});

function resetFakeClient(): void {
  fakeRawClient.connect.mockClear();
  fakeRawClient.end.mockClear();
  fakeRawClient.list.mockReset().mockResolvedValue([]);
  fakeRawClient.stat.mockReset().mockResolvedValue({ size: 0, modifyTime: 0, isDirectory: false, isSymbolicLink: false });
  fakeRawClient.lstat
    .mockReset()
    .mockImplementation(async (p: string) => ({ ...(await fakeRawClient.stat(p)), isSymbolicLink: false }));
  fakeRawClient.realPath.mockReset().mockImplementation(async (p: string) => p);
  fakeRawClient.fastGet.mockClear();
  fakeRawClient.fastPut.mockClear();
  fakeRawClient.posixRename.mockClear();
  fakeRawClient.delete.mockClear();
  fakeRawClient.mkdir.mockClear();
  fakeRawClient.rmdir.mockClear();
  fakeRawClient.chmod.mockClear();
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
    invalidate: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
    // false by default so every existing test keeps exercising the
    // connecting-progress path (see "runs both folder transfers inside a
    // cancellable progress notification" and the getAdapter unit tests in
    // connectionPool.test.ts for the true/cache-hit path).
    hasClient: vi.fn().mockReturnValue(false),
  })),
}));

import { activate } from '../src/extension';
import { AuditLog } from '../src/auditLog';
import { ConnectionPool } from '../src/transfer/connectionPool';
import type { ConnectionManager } from '../src/connectionManager';
import { readSidecar, writeSidecar } from '../src/tmpStore';
import { tmpFilePathFor } from '../src/tmpPath';
import type { ConnectionConfig, SidecarMeta } from '../src/types';

/**
 * `globalStorageUri` is the real, always-writable per-extension directory VS
 * Code hands every extension; the audit log lives there now. Pointing it at
 * the per-test tmp dir keeps every run self-contained -- the previous scheme
 * read a `gangway.auditLogPath` globalState key that nothing in the product
 * ever set, so a real run fell back to the extension host's process cwd and
 * dropped `sftp-hotfix-uploads.log` into whatever directory that happened to
 * be (the repo root, for the E2E suite).
 */
function fakeContext(): vscode.ExtensionContext {
  const memento = (seed?: Record<string, unknown>) => {
    const data = new Map<string, unknown>(Object.entries(seed ?? {}));
    return { get: <T>(k: string) => data.get(k) as T | undefined, update: async (k: string, v: unknown) => { data.set(k, v); } };
  };
  return {
    globalState: memento(),
    workspaceState: memento(),
    globalStorageUri: { fsPath: path.join(os.tmpdir(), 'gangway-global-storage') },
    extensionUri: { fsPath: path.join(os.tmpdir(), 'gangway-extension-root'), scheme: 'file' },
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
        'gangway.manageRemotes',
        'gangway.pickConnection',
        'gangway.downloadFolder',
        'gangway.uploadFolder',
        'gangway.copyRemotePath',
      ]),
    );
  });

  it('creates the Remote Explorer view even with no connection bound yet', () => {
    // Previously the whole tree-view block was inside `if (initialConnection)`,
    // so a user creating their first connection got no explorer at all until
    // they reloaded the window.
    const created: string[] = [];
    const original = vscode.window.createTreeView;
    vscode.window.createTreeView = ((id: string, options: never) => {
      created.push(id);
      return original(id, options);
    }) as typeof original;

    try {
      activate(fakeContext());
    } finally {
      vscode.window.createTreeView = original;
    }

    expect(created).toContain('gangway.remoteExplorer');
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
  let connectionManager: ConnectionManager;
  let osTmpdirSpy: ReturnType<typeof vi.spyOn>;
  let capturedProvider: { getChildren: (n?: unknown) => Promise<unknown[]> };
  let capturedTreeView: { __test_fireDidChangeSelection: (node: unknown) => void } | undefined;

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

    const originalCreateTreeView = vscode.window.createTreeView;
    vscode.window.createTreeView = ((id: string, options: never) => {
      const view = originalCreateTreeView(id, options);
      capturedProvider = (options as unknown as { treeDataProvider: typeof capturedProvider }).treeDataProvider;
      capturedTreeView = view as unknown as { __test_fireDidChangeSelection: (node: unknown) => void };
      return view;
    }) as typeof originalCreateTreeView;

    const result = activate(fakeContext());
    connectionManager = result.connectionManager;
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

    await handler({ connectionId: connection.id, entry: { path: '/var/www/app/config.php', isDirectory: false, isSymbolicLink: false, size: 5 } });

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

    await handler({ connectionId: connection.id, entry: { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 } });

    expect(fakeRawClient.list).toHaveBeenCalledWith('/var/www/app');
    expect(fakeRawClient.fastGet).toHaveBeenCalledWith('/var/www/app/config.php', expect.any(String));
  });

  it('runs both folder transfers inside a cancellable progress notification', async () => {
    // folderQueue's AbortSignal plumbing existed from the start but nothing
    // passed one in, and folder upload had no progress UI at all -- Cancel
    // was an affordance that did nothing.
    // Note: connecting itself now shows its own cancellable notification
    // (see the connect-progress test below), so this filters to the two
    // transfer notifications by title instead of counting every call.
    type ProgressOptions = {
      cancellable?: boolean;
      location?: vscode.ProgressLocation | { viewId: string };
      title?: string;
    };
    const progressOptions: ProgressOptions[] = [];
    const original = vscode.window.withProgress;
    vscode.window.withProgress = ((opts: ProgressOptions, task: never) => {
      progressOptions.push(opts);
      return original(opts as never, task);
    }) as typeof original;

    try {
      fakeRawClient.list.mockResolvedValue([]);
      await handlers.get('gangway.downloadFolder')!({
        connectionId: connection.id,
        entry: { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 },
      });
      await handlers.get('gangway.uploadFolder')!({
        connectionId: connection.id,
        entry: { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 },
      });
    } finally {
      vscode.window.withProgress = original;
    }

    const transfers = progressOptions.filter(
      (options) => options.title?.startsWith('Downloading ') || options.title?.startsWith('Uploading '),
    );
    expect(transfers).toHaveLength(2);
    for (const options of transfers) {
      expect(options.cancellable).toBe(true);
      expect(options.location).toBe(vscode.ProgressLocation.Notification);
    }
  });

  it('skips a hostile listing entry name instead of downloading outside the tmp root', async () => {
    // A compromised or spoofed server (the exact threat TOFU host-key
    // verification defends against) can put anything in a directory listing,
    // and the name used to be concatenated straight into a local path.
    fakeRawClient.list.mockImplementation(async (dirPath: string) =>
      dirPath === '/var/www/app'
        ? [
            { name: '../../../../../../../../tmp/gangway-pwned', type: '-' },
            { name: 'config.php', type: '-' },
          ]
        : [],
    );

    await handlers.get('gangway.downloadFolder')!({
      connectionId: connection.id,
      entry: { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 },
    });

    expect(fakeRawClient.fastGet).toHaveBeenCalledTimes(1);
    expect(fakeRawClient.fastGet).toHaveBeenCalledWith('/var/www/app/config.php', expect.any(String));
    for (const [, localPath] of fakeRawClient.fastGet.mock.calls as Array<[string, string]>) {
      expect(localPath.startsWith(tmpHome)).toBe(true);
    }
  });

  describe('gangway.downloadFolder through a directory link', () => {
    const linkFolder = (p: string) => ({
      connectionId: connection.id,
      entry: { path: p, isDirectory: true, isSymbolicLink: true, size: 0 },
    });
    const outside = () =>
      fakeRawClient.realPath.mockImplementation(async (p: string) =>
        p === '/var/www/app/shared' ? '/srv/other' : p,
      );

    it('asks with the real path for a link that leaves the root and downloads after Download', async () => {
      outside();
      fakeRawClient.list.mockImplementation(async (d: string) =>
        d === '/var/www/app/shared' ? [{ name: 'a.php', type: '-' }] : [],
      );
      const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
      mockWindow.__test_queueWarning('Download');

      await handlers.get('gangway.downloadFolder')!(linkFolder('/var/www/app/shared'));

      expect(warnSpy).toHaveBeenCalledWith(
        'This folder is a link to /srv/other, outside the connection root. Download its contents anyway?',
        { modal: true },
        'Download',
      );
      expect(fakeRawClient.fastGet).toHaveBeenCalledWith('/var/www/app/shared/a.php', expect.any(String));
      warnSpy.mockRestore();
    });

    it('cancel downloads nothing and shows no error dialog', async () => {
      outside();
      const errSpy = vi.spyOn(vscode.window, 'showErrorMessage');
      mockWindow.__test_queueWarning(undefined);

      await handlers.get('gangway.downloadFolder')!(linkFolder('/var/www/app/shared'));

      expect(fakeRawClient.list).not.toHaveBeenCalled();
      expect(fakeRawClient.fastGet).not.toHaveBeenCalled();
      expect(errSpy).not.toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('an in-root link and a plain folder get no prompt; only the link costs a resolve', async () => {
      fakeRawClient.list.mockResolvedValue([]);
      const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');

      await handlers.get('gangway.downloadFolder')!(linkFolder('/var/www/app/shared'));
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('outside the connection root'), expect.anything(), expect.anything());
      expect(fakeRawClient.list).toHaveBeenCalledWith('/var/www/app/shared');

      fakeRawClient.realPath.mockClear();
      await handlers.get('gangway.downloadFolder')!({
        connectionId: connection.id,
        entry: { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 },
      });
      expect(fakeRawClient.realPath).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('a broken or looping link shows a plain warning without Retry or the clicked path', async () => {
      const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
      const errSpy = vi.spyOn(vscode.window, 'showErrorMessage');
      fakeRawClient.realPath.mockImplementation(async () => undefined);
      fakeRawClient.lstat.mockResolvedValue({ size: 0, modifyTime: 0, isDirectory: false, isSymbolicLink: true });

      await handlers.get('gangway.downloadFolder')!(linkFolder('/var/www/app/shared'));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]).toHaveLength(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('shared');
      expect(String(warnSpy.mock.calls[0][0])).not.toContain('/var/www/app/shared');

      warnSpy.mockClear();
      fakeRawClient.realPath.mockImplementation(async () => {
        throw Object.assign(new Error('loop'), { code: 'ELOOP' });
      });
      await handlers.get('gangway.downloadFolder')!(linkFolder('/var/www/app/shared'));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]).toHaveLength(1);
      expect(String(warnSpy.mock.calls[0][0])).not.toContain('/var/www/app/shared');
      expect(errSpy).not.toHaveBeenCalled();
      expect(fakeRawClient.list).not.toHaveBeenCalled();
      warnSpy.mockRestore();
      errSpy.mockRestore();
    });
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
    // Simulates the file already having been downloaded before this edit/upload
    // (a real download always writes both the tmp file and its sidecar).
    const localFile = tmpFilePathFor(connection, '/var/www/app/clean.php');
    await fs.mkdir(path.dirname(localFile), { recursive: true });
    await fs.writeFile(localFile, 'clean content');
    await writeSidecar(localFile, {
      connectionId: connection.id,
      remotePath: '/var/www/app/clean.php',
      mtime: 0,
      size: 0,
      downloadedAt: Date.now(),
    });
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

    const handler = handlers.get('gangway.uploadFolder')!;
    await handler({ connectionId: connection.id, entry: { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 } });

    expect(fakeRawClient.fastPut).toHaveBeenCalledWith(localFile, '/var/www/app/clean.php.tmp');
    expect(fakeRawClient.posixRename).toHaveBeenCalledWith('/var/www/app/clean.php.tmp', '/var/www/app/clean.php');
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Uploaded 1 file(s)'));
  });

  it('gangway.uploadFolder reports a path-escape error through showErrorMessage instead of an unhandled rejection', async () => {
    // tmpFilePathFor() throws when the node's remote path resolves outside
    // the connection's own remotePath (see tmpPath.ts). That call used to sit
    // one line outside this handler's try block, so the throw skipped the
    // catch entirely and became an unhandled rejection instead of the same
    // mapSftpError -> showErrorMessage path every other failure here takes.
    const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');
    const handler = handlers.get('gangway.uploadFolder')!;

    await handler({ connectionId: connection.id, entry: { path: '/etc/passwd', isDirectory: true, isSymbolicLink: false, size: 0 } });

    expect(errorSpy).toHaveBeenCalled();
    expect(fakeRawClient.list).not.toHaveBeenCalled();
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
    expect(fakeRawClient.posixRename).toHaveBeenCalledWith('/var/www/app/config.php.tmp', '/var/www/app/config.php');
  });

  describe('push through a link', () => {
    async function seedLinkFile(extra: Partial<SidecarMeta> = {}): Promise<string> {
      const localPath = path.join(tmpHome, 'linked-config.php');
      await fs.writeFile(localPath, 'edited content');
      await writeSidecar(localPath, {
        connectionId: connection.id,
        remotePath: '/var/www/app/config.php',
        realPath: '/var/www/shared/config.php',
        mtime: 1700000000000,
        size: 5,
        downloadedAt: Date.now(),
        ...extra,
      });
      fakeRawClient.stat.mockResolvedValue({ size: 5, modifyTime: 1700000000000, isDirectory: false, isSymbolicLink: false });
      vscode.window.activeTextEditor = { document: { uri: { fsPath: localPath } } } as unknown as vscode.TextEditor;
      return localPath;
    }

    it('writes the tmp file and renames at the real target, never at the clicked link path', async () => {
      const localPath = await seedLinkFile();
      fakeRawClient.realPath.mockImplementation(async (p: string) =>
        p === '/var/www/app/config.php' ? '/var/www/shared/config.php' : p,
      );

      await handlers.get('gangway.uploadFile')!();

      expect(fakeRawClient.stat).toHaveBeenCalledWith('/var/www/shared/config.php');
      expect(fakeRawClient.lstat).toHaveBeenCalledWith('/var/www/shared/config.php');
      expect(fakeRawClient.fastPut).toHaveBeenCalledWith(localPath, '/var/www/shared/config.php.tmp');
      expect(fakeRawClient.posixRename).toHaveBeenCalledWith(
        '/var/www/shared/config.php.tmp',
        '/var/www/shared/config.php',
      );
      const written = [...fakeRawClient.fastPut.mock.calls, ...fakeRawClient.posixRename.mock.calls].flat();
      expect(written.some((p) => String(p).startsWith('/var/www/app/config.php'))).toBe(false);
      const sidecar = await readSidecar(localPath);
      expect(sidecar!.remotePath).toBe('/var/www/app/config.php');
      expect(sidecar!.realPath).toBe('/var/www/shared/config.php');
    });

    it('warns and pushes nothing when the link now points somewhere else', async () => {
      await seedLinkFile();
      fakeRawClient.realPath.mockImplementation(async (p: string) =>
        p === '/var/www/app/config.php' ? '/var/www/shared/other.php' : p,
      );
      const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');

      await handlers.get('gangway.uploadFile')!();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('now points elsewhere'));
      expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
      expect(fakeRawClient.posixRename).not.toHaveBeenCalled();
    });

    it('asks before pushing outside the root and pushes nothing when declined', async () => {
      await seedLinkFile({ realPath: '/srv/shared/config.php' });
      fakeRawClient.realPath.mockImplementation(async (p: string) =>
        p === '/var/www/app/config.php' ? '/srv/shared/config.php' : p,
      );
      mockWindow.__test_queueWarning(undefined);

      await handlers.get('gangway.uploadFile')!();

      expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
    });

    it('pushes outside the root after a yes and remembers it in the sidecar', async () => {
      const localPath = await seedLinkFile({ realPath: '/srv/shared/config.php' });
      fakeRawClient.realPath.mockImplementation(async (p: string) =>
        p === '/var/www/app/config.php' ? '/srv/shared/config.php' : p,
      );
      mockWindow.__test_queueWarning('Push');

      await handlers.get('gangway.uploadFile')!();

      expect(fakeRawClient.posixRename).toHaveBeenCalledWith('/srv/shared/config.php.tmp', '/srv/shared/config.php');
      expect((await readSidecar(localPath))!.outsideRootConfirmedFor).toBe('/srv/shared/config.php');
    });
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

  /**
   * The worst outcome this tool can produce is pushing a hotfix to the wrong
   * server. Both no-args (keybinding) paths derive the remote path from the
   * open file's own sidecar; a stale tmp file left open from a
   * previously-bound connection would otherwise run against whatever
   * connection is active now, silently.
   */
  describe('stale tmp file from another connection', () => {
    async function seedForeignFile(name: string): Promise<string> {
      const localPath = path.join(tmpHome, name);
      await fs.writeFile(localPath, 'content from another server');
      await writeSidecar(localPath, {
        connectionId: 'a-different-connection-id',
        remotePath: '/var/www/app/config.php',
        mtime: 1700000000000,
        size: 5,
        downloadedAt: Date.now(),
      });
      vscode.window.activeTextEditor = { document: { uri: { fsPath: localPath } } } as unknown as vscode.TextEditor;
      return localPath;
    }

    it('gangway.uploadFile refuses to push a file belonging to a different connection', async () => {
      await seedForeignFile('foreign-upload.php');
      const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');

      await handlers.get('gangway.uploadFile')!();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('different connection'));
      expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
      expect(fakeRawClient.stat).not.toHaveBeenCalled();
    });

    it('gangway.downloadFile refuses to refresh a file belonging to a different connection', async () => {
      await seedForeignFile('foreign-download.php');
      const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');

      await handlers.get('gangway.downloadFile')!();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('different connection'));
      expect(fakeRawClient.fastGet).not.toHaveBeenCalled();
      expect(fakeRawClient.stat).not.toHaveBeenCalled();
    });
  });

  describe('frozen connection guard', () => {
    it('gangway.uploadFile stops on a frozen connection before any network mutation', async () => {
      const fresh = activate(fakeContext());
      const frozen = await fresh.connectionManager.add({
        name: 'prod',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        remotePath: '/var/www',
        authMethod: 'password',
        frozen: true,
      });
      await fresh.connectionManager.setWorkspaceBinding(frozen.id);
      const localPath = path.join(tmpHome, 'frozen.php');
      await fs.writeFile(localPath, 'hotfix');
      await writeSidecar(localPath, {
        connectionId: frozen.id,
        remotePath: '/var/www/app/f.php',
        mtime: 1,
        size: 6,
        downloadedAt: 1,
      });
      vscode.window.activeTextEditor = { document: { uri: { fsPath: localPath } } } as unknown as vscode.TextEditor;
      const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
      resetFakeClient();

      await handlers.get('gangway.uploadFile')!();

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('frozen'));
      expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
      expect(fakeRawClient.fastGet).not.toHaveBeenCalled();
      expect(fakeRawClient.stat).not.toHaveBeenCalled();
      infoSpy.mockRestore();
    });
  });

  describe('file commands', () => {
    function fileNode(remotePath: string) {
      return { connectionId: connection.id, entry: { path: remotePath, isDirectory: false, isSymbolicLink: false, size: 5 } };
    }

    function folderNode(remotePath: string) {
      return { connectionId: connection.id, entry: { path: remotePath, isDirectory: true, isSymbolicLink: false, size: 0 } };
    }

    async function activateFrozenConnection() {
      const fresh = activate(fakeContext());
      const frozen = await fresh.connectionManager.add({
        name: 'prod',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        remotePath: '/var/www',
        authMethod: 'password',
        frozen: true,
      });
      await fresh.connectionManager.setWorkspaceBinding(frozen.id);
      return frozen;
    }

    afterEach(() => {
      mockWindow.__test_resetAnswers();
    });

    it('gangway.deleteRemote cancels a folder delete when the typed name does not match', async () => {
      mockWindow.__test_queueInput('wrong-name');
      const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

      await handlers.get('gangway.deleteRemote')!(folderNode('/var/www/app/dir'));

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Delete cancelled'));
      expect(fakeRawClient.posixRename).not.toHaveBeenCalled();
      infoSpy.mockRestore();
    });

    it('gangway.deleteRemote hard-deletes a file with permanence copy and a delete audit line', async () => {
      mockWindow.__test_queueWarning('Delete');
      const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
      const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

      await handlers.get('gangway.deleteRemote')!(fileNode('/var/www/app/a.php'));

      expect(warnSpy).toHaveBeenCalledWith(
        'Permanently delete /var/www/app/a.php on "staging"? There is no undo.',
        'Delete',
        'Cancel',
      );
      expect(fakeRawClient.delete).toHaveBeenCalledWith('/var/www/app/a.php');
      expect(fakeRawClient.posixRename).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith('Permanently deleted /var/www/app/a.php.');
      const logPath = path.join(os.tmpdir(), 'gangway-global-storage', 'sftp-hotfix-uploads.log');
      const contents = await fs.readFile(logPath, 'utf8');
      expect(JSON.parse(contents.trim().split('\n').pop()!)).toMatchObject({
        connectionId: connection.id,
        remotePath: '/var/www/app/a.php',
        op: 'delete',
      });
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('gangway.deleteRemote recursive-rmdirs a folder after typed confirm', async () => {
      mockWindow.__test_queueInput('dir');
      const inputSpy = vi.spyOn(vscode.window, 'showInputBox');

      await handlers.get('gangway.deleteRemote')!(folderNode('/var/www/app/dir'));

      expect(inputSpy).toHaveBeenCalledWith({
        prompt: expect.stringContaining('permanently delete'),
      });
      expect(inputSpy.mock.calls[0][0]).toMatchObject({
        prompt: expect.stringContaining('There is no undo.'),
      });
      expect(fakeRawClient.rmdir).toHaveBeenCalledWith('/var/www/app/dir', true);
      inputSpy.mockRestore();
    });

    it('gangway.deleteRemote deletes the link, never recursing, for a symlink entry', async () => {
      mockWindow.__test_queueWarning('Delete');

      await handlers.get('gangway.deleteRemote')!({
        connectionId: connection.id,
        entry: { path: '/var/www/app/link', isDirectory: false, isSymbolicLink: true, size: 0 },
      });

      expect(fakeRawClient.delete).toHaveBeenCalledWith('/var/www/app/link');
      expect(fakeRawClient.rmdir).not.toHaveBeenCalled();
    });

    it('delete of a link never calls rmdir: a dir link is unlinked without counting or recursing', async () => {
      mockWindow.__test_queueWarning('Delete');
      const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
      const inputSpy = vi.spyOn(vscode.window, 'showInputBox');

      await handlers.get('gangway.deleteRemote')!({
        connectionId: connection.id,
        entry: { path: '/var/www/app/shared', isDirectory: true, isSymbolicLink: true, size: 0 },
      });

      expect(warnSpy).toHaveBeenCalledWith(
        'Delete the link shared? The target is not touched.',
        { modal: true },
        'Delete',
      );
      expect(inputSpy).not.toHaveBeenCalled();
      expect(fakeRawClient.list).not.toHaveBeenCalled();
      expect(fakeRawClient.rmdir).not.toHaveBeenCalled();
      expect(fakeRawClient.delete).toHaveBeenCalledTimes(1);
      expect(fakeRawClient.delete).toHaveBeenCalledWith('/var/www/app/shared');
      warnSpy.mockRestore();
      inputSpy.mockRestore();
    });

    it('deletes a dangling link by unlinking it: only the parent is resolved, never the link, never rmdir', async () => {
      const linkPath = '/var/www/app/dangling';
      fakeRawClient.lstat.mockImplementation(async (p: string) => {
        if (p === linkPath) return { size: 0, modifyTime: 0, isDirectory: false, isSymbolicLink: true };
        return { size: 0, modifyTime: 0, isDirectory: true, isSymbolicLink: false };
      });
      fakeRawClient.stat.mockImplementation(async (p: string) => {
        if (p === linkPath) throw Object.assign(new Error('No such file'), { code: 2 });
        return { size: 0, modifyTime: 0, isDirectory: true, isSymbolicLink: false };
      });
      fakeRawClient.realPath.mockImplementation(async (p: string) => {
        if (p === linkPath) throw Object.assign(new Error('No such file'), { code: 2 });
        return p;
      });
      const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
      mockWindow.__test_queueWarning('Delete');

      await handlers.get('gangway.deleteRemote')!({
        connectionId: connection.id,
        entry: { path: linkPath, isDirectory: false, isSymbolicLink: true, size: 0, link: { realPath: linkPath, kind: 'broken' } },
      });

      expect(warnSpy).toHaveBeenCalledWith(
        'Delete the link dangling? The target is not touched.',
        { modal: true },
        'Delete',
      );
      expect(fakeRawClient.delete).toHaveBeenCalledTimes(1);
      expect(fakeRawClient.delete).toHaveBeenCalledWith(linkPath);
      expect(fakeRawClient.rmdir).not.toHaveBeenCalled();
      expect(fakeRawClient.stat).not.toHaveBeenCalledWith(linkPath);
      expect(fakeRawClient.realPath).not.toHaveBeenCalledWith(linkPath);
      warnSpy.mockRestore();
    });

    it('delete re-checks with lstat: a folder row that is now a link is unlinked, not recursed', async () => {
      mockWindow.__test_queueWarning('Delete');
      fakeRawClient.lstat.mockResolvedValue({ size: 0, modifyTime: 0, isDirectory: false, isSymbolicLink: true });

      await handlers.get('gangway.deleteRemote')!(folderNode('/var/www/app/dir'));

      expect(fakeRawClient.list).not.toHaveBeenCalled();
      expect(fakeRawClient.rmdir).not.toHaveBeenCalled();
      expect(fakeRawClient.delete).toHaveBeenCalledWith('/var/www/app/dir');
    });

    it('a link inside an out-of-root dir link asks with the real path and unlinks the resolved path only after a yes', async () => {
      fakeRawClient.realPath.mockImplementation(async (p: string) =>
        p === '/var/www/app/shared' || p.startsWith('/var/www/app/shared/')
          ? `/srv/other${p.slice('/var/www/app/shared'.length)}`
          : p,
      );
      fakeRawClient.stat.mockResolvedValue({ size: 0, modifyTime: 0, isDirectory: true, isSymbolicLink: false });
      const linkNode = {
        connectionId: connection.id,
        entry: { path: '/var/www/app/shared/foo', isDirectory: false, isSymbolicLink: true, size: 0 },
      };
      const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');

      // Declined at the out-of-root gate: no link prompt, nothing unlinked.
      mockWindow.__test_queueWarning(undefined);
      await handlers.get('gangway.deleteRemote')!(linkNode);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        'This location is really /srv/other, outside the connection root. Continue?',
        { modal: true },
        'Continue',
      );
      expect(fakeRawClient.delete).not.toHaveBeenCalled();

      // Accepted at the gate but declined at the link prompt: nothing unlinked.
      warnSpy.mockClear();
      mockWindow.__test_queueWarning('Continue');
      mockWindow.__test_queueWarning(undefined);
      await handlers.get('gangway.deleteRemote')!(linkNode);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy.mock.calls[1][0]).toBe(
        'Delete the link foo (really /srv/other/foo)? The target is not touched.',
      );
      expect(fakeRawClient.delete).not.toHaveBeenCalled();

      // Accepted twice: the resolved path is unlinked, never the link text.
      mockWindow.__test_queueWarning('Continue');
      mockWindow.__test_queueWarning('Delete');
      await handlers.get('gangway.deleteRemote')!(linkNode);
      expect(fakeRawClient.delete).toHaveBeenCalledTimes(1);
      expect(fakeRawClient.delete).toHaveBeenCalledWith('/srv/other/foo');
      expect(fakeRawClient.rmdir).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('a link delete on a frozen connection stops before any prompt or network call', async () => {
      const frozen = await activateFrozenConnection();
      resetFakeClient();
      const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
      const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

      await handlers.get('gangway.deleteRemote')!({
        connectionId: frozen.id,
        entry: { path: '/var/www/app/shared/foo', isDirectory: false, isSymbolicLink: true, size: 0 },
      });

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('frozen'));
      expect(warnSpy).not.toHaveBeenCalled();
      expect(fakeRawClient.lstat).not.toHaveBeenCalled();
      expect(fakeRawClient.delete).not.toHaveBeenCalled();
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('a folder under an out-of-root dir link asks with the real path and rmdirs the resolved path only after a yes', async () => {
      fakeRawClient.realPath.mockImplementation(async (p: string) =>
        p === '/var/www/app/ext' || p.startsWith('/var/www/app/ext/') ? `/etc/ext${p.slice('/var/www/app/ext'.length)}` : p,
      );
      fakeRawClient.stat.mockResolvedValue({ size: 0, modifyTime: 0, isDirectory: true, isSymbolicLink: false });
      const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
      const inputSpy = vi.spyOn(vscode.window, 'showInputBox');

      // Declined: nothing listed, nothing deleted, no typed-name prompt.
      mockWindow.__test_queueWarning(undefined);
      await handlers.get('gangway.deleteRemote')!(folderNode('/var/www/app/ext/sub'));
      expect(warnSpy).toHaveBeenCalledWith(
        'This location is really /etc/ext, outside the connection root. Continue?',
        { modal: true },
        'Continue',
      );
      expect(inputSpy).not.toHaveBeenCalled();
      expect(fakeRawClient.rmdir).not.toHaveBeenCalled();
      expect(fakeRawClient.delete).not.toHaveBeenCalled();

      // Accepted: the typed-name prompt names the real path, rmdir hits it.
      mockWindow.__test_queueWarning('Continue');
      mockWindow.__test_queueInput('sub');
      await handlers.get('gangway.deleteRemote')!(folderNode('/var/www/app/ext/sub'));
      expect(inputSpy).toHaveBeenCalledWith({ prompt: expect.stringContaining('/etc/ext/sub') });
      expect(fakeRawClient.rmdir).toHaveBeenCalledTimes(1);
      expect(fakeRawClient.rmdir).toHaveBeenCalledWith('/etc/ext/sub', true);
      warnSpy.mockRestore();
      inputSpy.mockRestore();
    });

    it('a file under an in-root linked parent is deleted at its real path, and the prompt names it', async () => {
      fakeRawClient.realPath.mockImplementation(async (p: string) =>
        p === '/var/www/app/link' ? '/var/www/real' : p,
      );
      const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
      mockWindow.__test_queueWarning('Delete');

      await handlers.get('gangway.deleteRemote')!(fileNode('/var/www/app/link/a.php'));

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('/var/www/real/a.php');
      expect(fakeRawClient.delete).toHaveBeenCalledWith('/var/www/real/a.php');
      warnSpy.mockRestore();
    });

    it('a cancelled link delete touches nothing', async () => {
      mockWindow.__test_queueWarning(undefined);

      await handlers.get('gangway.deleteRemote')!({
        connectionId: connection.id,
        entry: { path: '/var/www/app/shared', isDirectory: true, isSymbolicLink: true, size: 0 },
      });

      expect(fakeRawClient.delete).not.toHaveBeenCalled();
      expect(fakeRawClient.rmdir).not.toHaveBeenCalled();
    });

    it('gangway.newFolder under an out-of-root dir link asks with the real path, per operation', async () => {
      fakeRawClient.realPath.mockImplementation(async (p: string) =>
        p === '/var/www/app/ext' ? '/etc/ext' : p,
      );
      fakeRawClient.stat.mockImplementation(async (p: string) => {
        if (p.endsWith('/new')) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return { size: 0, modifyTime: 0, isDirectory: true, isSymbolicLink: false };
      });
      const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');

      mockWindow.__test_queueInput('new');
      mockWindow.__test_queueWarning('Continue');
      await handlers.get('gangway.newFolder')!(folderNode('/var/www/app/ext'));
      expect(warnSpy).toHaveBeenCalledWith(
        'This location is really /etc/ext, outside the connection root. Continue?',
        { modal: true },
        'Continue',
      );
      expect(fakeRawClient.mkdir).toHaveBeenCalledWith('/etc/ext/new', false);

      // Never remembered: the next operation asks again, and a dismissal writes nothing.
      fakeRawClient.mkdir.mockClear();
      warnSpy.mockClear();
      mockWindow.__test_queueInput('new');
      mockWindow.__test_queueWarning(undefined);
      await handlers.get('gangway.newFolder')!(folderNode('/var/www/app/ext'));
      expect(warnSpy).toHaveBeenCalledWith(
        'This location is really /etc/ext, outside the connection root. Continue?',
        { modal: true },
        'Continue',
      );
      expect(fakeRawClient.mkdir).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('gangway.deleteRemote retries the whole flow on Retry: recount, reconfirm, then delete and audit', async () => {
      mockWindow.__test_queueInput('dir');
      mockWindow.__test_queueInput('dir');
      mockWindow.__test_queueError('Retry');
      fakeRawClient.rmdir.mockRejectedValueOnce(new Error('boom'));
      const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

      await handlers.get('gangway.deleteRemote')!(folderNode('/var/www/app/dir'));

      expect(fakeRawClient.rmdir).toHaveBeenCalledTimes(2);
      expect(fakeRawClient.rmdir).toHaveBeenLastCalledWith('/var/www/app/dir', true);
      expect(infoSpy).toHaveBeenCalledWith('Permanently deleted /var/www/app/dir.');
      const logPath = path.join(os.tmpdir(), 'gangway-global-storage', 'sftp-hotfix-uploads.log');
      const contents = await fs.readFile(logPath, 'utf8');
      expect(JSON.parse(contents.trim().split('\n').pop()!)).toMatchObject({
        remotePath: '/var/www/app/dir',
        op: 'delete',
      });
      infoSpy.mockRestore();
    });

    it('gangway.deleteRemote surfaces rmdir failure with no success message and no delete audit', async () => {
      mockWindow.__test_queueInput('dir');
      fakeRawClient.rmdir.mockRejectedValueOnce(new Error('boom'));
      const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');
      const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

      await handlers.get('gangway.deleteRemote')!(folderNode('/var/www/app/dir'));

      expect(errorSpy).toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('Permanently deleted'));
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('gangway.deleteRemote still reports success when the audit append fails', async () => {
      mockWindow.__test_queueWarning('Delete');
      const appendSpy = vi.spyOn(AuditLog.prototype, 'append').mockRejectedValueOnce(new Error('EACCES'));
      const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');
      const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

      await handlers.get('gangway.deleteRemote')!(fileNode('/var/www/app/a.php'));

      expect(infoSpy).toHaveBeenCalledWith('Permanently deleted /var/www/app/a.php.');
      expect(errorSpy).not.toHaveBeenCalled();
      appendSpy.mockRestore();
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it.each([
      ['gangway.newFile', { isDirectory: true, path: '/var/www/app' }],
      ['gangway.newFolder', { isDirectory: true, path: '/var/www/app' }],
      ['gangway.renameRemote', { isDirectory: false, path: '/var/www/app/a.php' }],
      ['gangway.deleteRemote', { isDirectory: false, path: '/var/www/app/a.php' }],
      ['gangway.duplicateRemote', { isDirectory: false, path: '/var/www/app/a.php' }],
      ['gangway.chmodRemote', { isDirectory: false, path: '/var/www/app/a.php' }],
    ])('%s stops on a frozen connection before any prompt or network call', async (commandId, entry) => {
      const frozen = await activateFrozenConnection();
      resetFakeClient();
      const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

      await handlers.get(commandId)!({ connectionId: frozen.id, entry });

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('frozen'));
      expect(fakeRawClient.posixRename).not.toHaveBeenCalled();
      expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
      expect(fakeRawClient.mkdir).not.toHaveBeenCalled();
      infoSpy.mockRestore();
    });
  });

  describe('clipboard commands', () => {
    async function activateFrozenConnection() {
      const fresh = activate(fakeContext());
      const frozen = await fresh.connectionManager.add({
        name: 'prod',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        remotePath: '/var/www',
        authMethod: 'password',
        frozen: true,
      });
      await fresh.connectionManager.setWorkspaceBinding(frozen.id);
      return frozen;
    }

    afterEach(() => {
      mockWindow.__test_resetAnswers();
    });

    it.each([['gangway.restoreFromTrash'], ['gangway.emptyTrash']])('%s is not registered', (id) => {
      expect(handlers.has(id)).toBe(false);
    });

    it.each([
      [1, 'This location is really /srv/1/a.php, outside the connection root. Continue?'],
      [2, 'These locations are really /srv/1/a.php and /srv/2/a.php, outside the connection root. Continue?'],
      [3, 'These locations are really /srv/1/a.php, /srv/2/a.php and /srv/3/a.php, outside the connection root. Continue?'],
      [5, 'These locations are really /srv/1/a.php, /srv/2/a.php, /srv/3/a.php and 2 more, outside the connection root. Continue?'],
    ])('names %i out-of-root path(s) in one modal', async (count, message) => {
      fakeRawClient.realPath.mockImplementation(async (p: string) => p.replace(/^\/var\/www\/app\/l(\d)/, '/srv/$1'));
      fakeRawClient.stat.mockImplementation(async (p: string) =>
        p === '/var/www/dest'
          ? { size: 0, modifyTime: 0, isDirectory: true, isSymbolicLink: false }
          : { size: 1, modifyTime: 1, isDirectory: false, isSymbolicLink: false },
      );
      const nodes = Array.from({ length: count }, (_, i) => ({
        connectionId: connection.id,
        entry: { path: `/var/www/app/l${i + 1}/a.php`, isDirectory: false, isSymbolicLink: false, size: 1 },
      }));
      const destNode = { connectionId: connection.id, entry: { path: '/var/www/dest', isDirectory: true, isSymbolicLink: false, size: 0 } };
      const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
      mockWindow.__test_queueWarning(undefined);

      await handlers.get('gangway.copyEntries')!(nodes);
      await handlers.get('gangway.pasteEntries')!(destNode);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(message, { modal: true }, 'Continue');
      warnSpy.mockRestore();
    });

    it('cut then paste moves server-side with no re-upload', async () => {
      fakeRawClient.stat.mockImplementation(async (p: string) => {
        if (p === '/var/www/other') return { size: 0, modifyTime: 0, isDirectory: true, isSymbolicLink: false };
        if (p === '/var/www/app/a.php') return { size: 3, modifyTime: 1, isDirectory: false, isSymbolicLink: false };
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });
      const cutNode = { connectionId: connection.id, entry: { path: '/var/www/app/a.php', isDirectory: false, isSymbolicLink: false, size: 3 } };
      const destNode = { connectionId: connection.id, entry: { path: '/var/www/other', isDirectory: true, isSymbolicLink: false, size: 0 } };

      await handlers.get('gangway.cutEntries')!(cutNode);
      await handlers.get('gangway.pasteEntries')!(destNode);

      expect(fakeRawClient.posixRename).toHaveBeenCalledWith('/var/www/app/a.php', '/var/www/other/a.php');
      expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
    });

    it.each([['gangway.pasteEntries']])(
      '%s stops on a frozen connection before any prompt or network call',
      async (commandId) => {
        const frozen = await activateFrozenConnection();
        resetFakeClient();
        const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

        const node = { connectionId: frozen.id, entry: { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 } };
        await handlers.get(commandId)!(commandId === 'gangway.pasteEntries' ? node : undefined);

        expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('frozen'));
        expect(fakeRawClient.list).not.toHaveBeenCalled();
        expect(fakeRawClient.posixRename).not.toHaveBeenCalled();
        infoSpy.mockRestore();
      },
    );
  });

  describe('copy remote path', () => {
    beforeEach(() => {
      mockEnv.__test_resetClipboard();
    });

    it('gangway.copyRemotePath copies the node path to the OS clipboard', async () => {
      const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
      const node = { connectionId: connection.id, entry: { path: '/var/www/app/a.php', isDirectory: false, isSymbolicLink: false, size: 3 } };

      await handlers.get('gangway.copyRemotePath')!(node);

      expect(mockEnv.__test_clipboardWrites).toEqual(['/var/www/app/a.php']);
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('/var/www/app/a.php'));
      // Read-only: no server round-trip, no freeze gate.
      expect(fakeRawClient.list).not.toHaveBeenCalled();
      expect(fakeRawClient.stat).not.toHaveBeenCalled();
      infoSpy.mockRestore();
    });

    it('gangway.copyRemotePath warns when invoked with no node', async () => {
      const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');

      await handlers.get('gangway.copyRemotePath')!();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Select a file or folder'));
      expect(mockEnv.__test_clipboardWrites).toEqual([]);
      warnSpy.mockRestore();
    });
  });

  describe('paste onto a file node', () => {
    it('gangway.pasteEntries pastes into the parent dir when invoked on a file', async () => {
      fakeRawClient.stat.mockImplementation(async (p: string) => {
        if (p === '/var/www/other') return { size: 0, modifyTime: 0, isDirectory: true, isSymbolicLink: false };
        if (p === '/var/www/app/a.php') return { size: 3, modifyTime: 1, isDirectory: false, isSymbolicLink: false };
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });
      const cutNode = { connectionId: connection.id, entry: { path: '/var/www/app/a.php', isDirectory: false, isSymbolicLink: false, size: 3 } };
      // The menu now offers Paste on files too: the destination is the
      // clicked file's parent dir, not the file itself.
      const fileNode = { connectionId: connection.id, entry: { path: '/var/www/other/b.php', isDirectory: false, isSymbolicLink: false, size: 1 } };

      await handlers.get('gangway.cutEntries')!(cutNode);
      await handlers.get('gangway.pasteEntries')!(fileNode);

      expect(fakeRawClient.posixRename).toHaveBeenCalledWith('/var/www/app/a.php', '/var/www/other/a.php');
      expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
    });
  });

  describe('sync folder', () => {
    async function activateFrozenConnection() {
      const fresh = activate(fakeContext());
      const frozen = await fresh.connectionManager.add({
        name: 'prod',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        remotePath: '/var/www',
        authMethod: 'password',
        frozen: true,
      });
      await fresh.connectionManager.setWorkspaceBinding(frozen.id);
      return frozen;
    }

    afterEach(() => {
      mockWindow.__test_resetAnswers();
    });

    it('gangway.syncFolder blocks the up direction on a frozen connection', async () => {
      const frozen = await activateFrozenConnection();
      resetFakeClient();
      mockWindow.__test_queuePick('Upload (local → server)');
      const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

      await handlers.get('gangway.syncFolder')!({
        connectionId: frozen.id,
        entry: { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 },
      });

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('frozen'));
      expect(fakeRawClient.list).not.toHaveBeenCalled();
      infoSpy.mockRestore();
    });

    it('gangway.syncFolder allows the down direction on a frozen connection', async () => {
      const frozen = await activateFrozenConnection();
      resetFakeClient();
      mockWindow.__test_queuePick('Download (server → local)');
      const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

      await handlers.get('gangway.syncFolder')!({
        connectionId: frozen.id,
        entry: { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 },
      });

      expect(fakeRawClient.list).toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('frozen'));
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('No differences'));
      infoSpy.mockRestore();
    });

    it('gangway.syncFolder states the excluded count and uploads only the picked files', async () => {
      const { tmpFilePathFor } = await import('../src/tmpPath');
      const localRoot = tmpFilePathFor(connection, '/var/www/app');
      await fs.mkdir(path.join(localRoot, 'node_modules'), { recursive: true });
      await fs.writeFile(path.join(localRoot, 'keep.php'), '<?php');
      await fs.writeFile(path.join(localRoot, 'node_modules', 'skip.js'), 'x');
      mockWindow.__test_queuePick('Upload (local → server)');
      mockWindow.__test_queueWarning('Proceed-excluded');
      mockWindow.__test_queuePick((items: unknown[]) => items);
      const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

      await handlers.get('gangway.syncFolder')!({
        connectionId: connection.id,
        entry: { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 },
      });

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Synced 1'));
      const puts = (fakeRawClient.fastPut as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string]>;
      expect(puts.some(([local]) => local.endsWith('keep.php'))).toBe(true);
      expect(puts.some(([local, remote]) => local.includes('skip.js') || remote.includes('skip.js'))).toBe(false);
      infoSpy.mockRestore();
    });
  });

  describe('sync workspace', () => {
    let workRoot: string;
    let previousFolders: unknown;

    beforeEach(async () => {
      workRoot = path.join(tmpHome, 'work');
      await fs.mkdir(workRoot, { recursive: true });
      previousFolders = vscode.workspace.workspaceFolders;
      (vscode.workspace as unknown as { workspaceFolders: { uri: { fsPath: string }; name: string }[] }).workspaceFolders = [{ uri: { fsPath: workRoot }, name: 'work' }];
    });

    afterEach(() => {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = previousFolders;
      mockWindow.__test_resetAnswers();
    });

    it('gangway.syncWorkspaceUp uploads a workspace file through the default mapping', async () => {
      await fs.writeFile(path.join(workRoot, 'hello.php'), '<?php');
      mockWindow.__test_queuePick((items: unknown[]) => items);
      const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

      await handlers.get('gangway.syncWorkspaceUp')!();

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Synced 1'));
      const puts = (fakeRawClient.fastPut as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string]>;
      expect(puts.some(([local, remote]) => local === path.join(workRoot, 'hello.php') && remote === '/var/www/hello.php.tmp')).toBe(true);
      infoSpy.mockRestore();
    });

    it('names the mapped root in the summary so unmapped roots are visible', async () => {
      await fs.writeFile(path.join(workRoot, 'hello.php'), '<?php');
      mockWindow.__test_queuePick((items: unknown[]) => items);
      const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

      await handlers.get('gangway.syncWorkspaceUp')!();

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining(`${workRoot} → /var/www`));
      infoSpy.mockRestore();
    });

    it('treats a missing remote root as empty, including numeric SFTP codes', async () => {
      await fs.writeFile(path.join(workRoot, 'hello.php'), '<?php');
      fakeRawClient.list.mockRejectedValue(Object.assign(new Error('list: No such file /var/www'), { code: '2' }));
      mockWindow.__test_queuePick((items: unknown[]) => items);
      const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

      await handlers.get('gangway.syncWorkspaceUp')!();

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Synced 1'));
      const puts = (fakeRawClient.fastPut as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string]>;
      expect(puts.some(([local]) => local === path.join(workRoot, 'hello.php'))).toBe(true);
      infoSpy.mockRestore();
    });

    it('picks between explicit mappings when several match', async () => {
      const subDir = path.join(workRoot, 'sub');
      await fs.mkdir(subDir, { recursive: true });
      await fs.writeFile(path.join(subDir, 'f.php'), '<?php');
      await connectionManager.update(connection.id, {
        mappings: [
          { localPath: workRoot, remotePath: '/var/www/app' },
          { localPath: subDir, remotePath: '/var/www/other' },
        ],
      });
      mockWindow.__test_queuePick((items: unknown[]) => (items as unknown[])[1]);
      mockWindow.__test_queuePick((items: unknown[]) => items);
      const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

      await handlers.get('gangway.syncWorkspaceUp')!();

      const puts = (fakeRawClient.fastPut as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string]>;
      expect(puts.some(([, remote]) => remote.startsWith('/var/www/other/'))).toBe(true);
      expect(puts.some(([, remote]) => remote.startsWith('/var/www/app/'))).toBe(false);
      infoSpy.mockRestore();
    });

    it('refuses a mapping whose remote sits outside the connection root', async () => {
      await connectionManager.update(connection.id, {
        mappings: [{ localPath: workRoot, remotePath: '/other/place' }],
      });
      const errSpy = vi.spyOn(vscode.window, 'showErrorMessage');

      await handlers.get('gangway.syncWorkspaceUp')!();

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('outside'));
      expect(fakeRawClient.list).not.toHaveBeenCalled();
      expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('sorts workspace-contained mappings ahead of outside ones', async () => {
      const outsideDir = path.join(tmpHome, 'outside');
      await fs.mkdir(outsideDir, { recursive: true });
      await connectionManager.update(connection.id, {
        mappings: [
          { localPath: outsideDir, remotePath: '/var/www/out' },
          { localPath: workRoot, remotePath: '/var/www/in' },
        ],
      });
      let offered: string[] = [];
      mockWindow.__test_queuePick((items: unknown[]) => {
        offered = (items as Array<{ label: string }>).map((i) => i.label);
        return (items as unknown[])[0];
      });

      await handlers.get('gangway.syncWorkspaceUp')!();

      expect(offered[0]).toContain(workRoot);
      expect(offered[1]).toContain(outsideDir);
    });
  });

  describe('freeze toggle', () => {
    it('gangway.toggleFreeze locks and unlocks, and the pick list shows the lock', async () => {
      const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
      const node = { connectionId: connection.id, entry: { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 } };

      await handlers.get('gangway.toggleFreeze')!(node);
      expect(connectionManager.list()[0].frozen).toBe(true);
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Locked'));

      await handlers.get('gangway.toggleFreeze')!(node);
      expect(connectionManager.list()[0].frozen).toBe(false);
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Unlocked'));
      infoSpy.mockRestore();
    });
  });

  /**
   * Conflict Guard, second half. Before this, a detected conflict showed a
   * warning telling the user to "Open the diff and choose Overwrite, Keep
   * server, or Cancel" and then simply returned: no diff was ever opened, no
   * choice was ever offered, and a conflicted file could not be pushed by any
   * means. These tests drive the three real outcomes.
   */
  describe('conflict diff and resolution', () => {
    // These tests replace `showWarningMessage`'s behaviour, so every spy is
    // tracked and restored afterwards. `vi.restoreAllMocks()` is off-limits
    // here: it would also tear down the hoisted fakeRawClient and the
    // connectionPool module mock (see the note in beforeEach above).
    const spies: Array<{ mockRestore: () => void }> = [];
    function track<T extends { mockRestore: () => void }>(spy: T): T {
      spies.push(spy);
      return spy;
    }

    afterEach(() => {
      while (spies.length) spies.pop()!.mockRestore();
    });

    async function seedConflictedFile(): Promise<string> {
      const localPath = path.join(tmpHome, 'conflicted.php');
      await fs.writeFile(localPath, 'local edit');
      await writeSidecar(localPath, {
        connectionId: connection.id,
        remotePath: '/var/www/app/config.php',
        mtime: 1700000000000,
        size: 5,
        downloadedAt: Date.now(),
      });
      // Server moved on since the download: different mtime -> conflict.
      fakeRawClient.stat.mockResolvedValue({
        size: 14,
        modifyTime: 1900000000000,
        isDirectory: false,
        isSymbolicLink: false,
      });
      vscode.window.activeTextEditor = { document: { uri: { fsPath: localPath } } } as unknown as vscode.TextEditor;
      return localPath;
    }

    it('forces the same review flow, instead of an unconditional overwrite, when the sidecar is missing/corrupt for a file that demonstrably exists locally', async () => {
      // No writeSidecar() call here: a torn write or a foreign file left the
      // tmp file without a usable sidecar, so there is no baseline to prove
      // the server hasn't changed since. This must fail closed into review,
      // never fall through to a silent overwrite. Invoked via a tree node
      // (not the no-args keybinding form) so remotePath comes from the node,
      // not from the very sidecar this test omits.
      const remotePath = '/var/www/app/no-sidecar.php';
      const localPath = tmpFilePathFor(connection, remotePath);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, 'local edit with no baseline');
      const execSpy = track(vi.spyOn(vscode.commands, 'executeCommand'));
      track(
        vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation((async (_msg: string, ...items: string[]) =>
          items.find((item) => /overwrite/i.test(item))) as never),
      );

      await handlers.get('gangway.uploadFile')!({
        connectionId: connection.id,
        entry: { path: remotePath, isDirectory: false, isSymbolicLink: false, size: 0 },
      });

      expect(execSpy).toHaveBeenCalledWith('vscode.diff', expect.anything(), expect.anything(), expect.any(String));
      expect(fakeRawClient.fastPut).toHaveBeenCalledWith(localPath, `${remotePath}.tmp`);
    });

    it('opens the native diff between the local file and a fresh server copy, then blocks the push on Cancel', async () => {
      const localPath = await seedConflictedFile();
      const execSpy = track(vi.spyOn(vscode.commands, 'executeCommand'));
      // An undismissed/dismissed warning returns undefined, which must mean cancel.
      track(vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never));

      await handlers.get('gangway.uploadFile')!();

      expect(execSpy).toHaveBeenCalledWith(
        'vscode.diff',
        expect.objectContaining({ fsPath: localPath }),
        expect.objectContaining({ fsPath: `${localPath}.gangway-server-fresh` }),
        expect.stringContaining('config.php'),
      );
      expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
      await expect(fs.readFile(localPath, 'utf8')).resolves.toBe('local edit');
    });

    it('pushes the local file anyway when the user chooses Overwrite', async () => {
      const localPath = await seedConflictedFile();
      track(
        vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation((async (_msg: string, ...items: string[]) =>
          items.find((item) => /overwrite/i.test(item))) as never),
      );

      await handlers.get('gangway.uploadFile')!();

      expect(fakeRawClient.fastPut).toHaveBeenCalledWith(localPath, '/var/www/app/config.php.tmp');
      expect(fakeRawClient.posixRename).toHaveBeenCalledWith(
        '/var/www/app/config.php.tmp',
        '/var/www/app/config.php',
      );
    });

    it('discards the local edits and does not push when the user chooses Keep server', async () => {
      const localPath = await seedConflictedFile();
      track(
        vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation((async (_msg: string, ...items: string[]) =>
          items.find((item) => /keep server/i.test(item))) as never),
      );

      await handlers.get('gangway.uploadFile')!();

      expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
      // The fake client's fastGet writes 'server content'.
      await expect(fs.readFile(localPath, 'utf8')).resolves.toBe('server content');
      // The throwaway copy must not survive the flow.
      await expect(fs.access(`${localPath}.gangway-server-fresh`)).rejects.toThrow();
    });

    it('wires a real per-file review into folder upload instead of silently skipping every conflict', async () => {
      // `runFolderUpload`'s reviewOneConflict parameter was never supplied at
      // the real call site, so "Review one by one" behaved exactly like
      // "Skip conflicted" -- the user was offered a choice that did nothing.
      fakeRawClient.list.mockImplementation(async (dirPath: string) =>
        dirPath === '/var/www/app' ? [{ name: 'conflicted.php', type: '-' }] : [],
      );
      fakeRawClient.stat.mockResolvedValue({
        size: 14,
        modifyTime: 1900000000000,
        isDirectory: false,
        isSymbolicLink: false,
      });
      const localFile = tmpFilePathFor(connection, '/var/www/app/conflicted.php');
      await fs.mkdir(path.dirname(localFile), { recursive: true });
      await fs.writeFile(localFile, 'local edit');
      await writeSidecar(localFile, {
        connectionId: connection.id,
        remotePath: '/var/www/app/conflicted.php',
        mtime: 1700000000000,
        size: 5,
        downloadedAt: Date.now(),
      });

      const execSpy = track(vi.spyOn(vscode.commands, 'executeCommand'));
      track(
        vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation((async (_msg: string, ...items: string[]) =>
          items.find((item) => /review one by one/i.test(item)) ??
          items.find((item) => /overwrite/i.test(item))) as never),
      );

      await handlers.get('gangway.uploadFolder')!({
        connectionId: connection.id,
        entry: { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 },
      });

      expect(execSpy).toHaveBeenCalledWith(
        'vscode.diff',
        expect.objectContaining({ fsPath: localFile }),
        expect.objectContaining({ fsPath: `${localFile}.gangway-server-fresh` }),
        expect.any(String),
      );
      expect(fakeRawClient.fastPut).toHaveBeenCalledWith(localFile, '/var/www/app/conflicted.php.tmp');
    });
  });

  it('writes the upload audit log under globalStorageUri, never the extension host process cwd', async () => {
    const localPath = path.join(tmpHome, 'audited.php');
    await fs.writeFile(localPath, 'audited content');
    await writeSidecar(localPath, {
      connectionId: connection.id,
      remotePath: '/var/www/app/audited.php',
      mtime: 0,
      size: 0,
      downloadedAt: Date.now(),
    });

    await handlers.get('gangway.uploadFile')!(localPath, '/var/www/app/audited.php');

    // os.tmpdir() is spied to tmpHome for this suite, so globalStorageUri
    // resolves inside the disposable per-test directory.
    const logPath = path.join(os.tmpdir(), 'gangway-global-storage', 'sftp-hotfix-uploads.log');
    const contents = await fs.readFile(logPath, 'utf8');
    expect(JSON.parse(contents.trim().split('\n').pop()!)).toMatchObject({
      connectionId: connection.id,
      remotePath: '/var/www/app/audited.php',
    });
  });

  it('gangway.uploadFile still accepts explicit localPath/remotePath arguments (Task 19 E2E contract)', async () => {
    const localPath = path.join(tmpHome, 'explicit.php');
    await fs.writeFile(localPath, 'explicit content');
    await writeSidecar(localPath, {
      connectionId: connection.id,
      remotePath: '/var/www/app/explicit.php',
      mtime: 0,
      size: 0,
      downloadedAt: Date.now(),
    });

    const handler = handlers.get('gangway.uploadFile')!;
    await handler(localPath, '/var/www/app/explicit.php');

    expect(fakeRawClient.fastPut).toHaveBeenCalledWith(localPath, '/var/www/app/explicit.php.tmp');
    expect(fakeRawClient.posixRename).toHaveBeenCalledWith('/var/www/app/explicit.php.tmp', '/var/www/app/explicit.php');
  });

  it('registers a FileDecorationProvider so a locally-modified tmp file shows a dirty badge', () => {
    // Full behavior (which files actually get badged) is covered in
    // test/dirtyState.test.ts and test/ui/dirtyDecoration.test.ts; this only
    // confirms activate() actually wires the provider into VS Code.
    const registerSpy = vi.spyOn(vscode.window, 'registerFileDecorationProvider');

    activate(fakeContext());

    expect(registerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ provideFileDecoration: expect.any(Function) }),
    );
  });

  /**
   * Govard remote import. The auto-scan is driven through the workspace
   * folder-change event (not the activate-time race) so every test is
   * deterministic: activate first with no folders, then set folders, write
   * the fixture, and fire the event. workspaceFolders is reset after each
   * test so no other suite ever sees a govard project.
   */
  describe('govard remote import', () => {
    const spies: Array<{ mockRestore: () => void }> = [];
    function track<T extends { mockRestore: () => void }>(spy: T): T {
      spies.push(spy);
      return spy;
    }
    afterEach(() => {
      while (spies.length) spies.pop()!.mockRestore();
      (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [];
    });

    // Give the activate-time auto-scan room to finish: inputs are always
    // stable before activate() here (folders + fixture preset, choices
    // mocked), so the sleep only waits out the implementation's own async
    // file read, never a race with the test body.
    const settleScan = () => new Promise((resolve) => setTimeout(resolve, 150));

    async function writeGovardFixture(dir: string): Promise<void> {
      await fs.writeFile(
        path.join(dir, '.govard.yml'),
        'project_name: myshop\n' +
          'remotes:\n' +
          '  staging:\n' +
          '    host: staging.example.com\n' +
          '    user: deploy\n' +
          '    path: /srv/www/staging\n' +
          '  prod:\n' +
          '    host: prod.example.com\n' +
          '    user: deploy\n' +
          '    path: /srv/www/prod\n',
        'utf8',
      );
    }

    function openProject(dir: string): void {
      (vscode.workspace as unknown as { workspaceFolders: { uri: { fsPath: string }; name: string }[] }).workspaceFolders = [
        { uri: { fsPath: dir }, name: 'myshop' },
      ];
    }

    it('prompts on activate and imports every fresh remote when Import all is chosen', async () => {
      openProject(tmpHome);
      await writeGovardFixture(tmpHome);
      const infoSpy = track(vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Import all (2)' as never));

      const second = activate(fakeContext());
      await settleScan();

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('staging'));
      expect(second.connectionManager.list().map((c) => c.name).sort()).toEqual(['myshop-prod', 'myshop-staging']);
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Imported 2'));
    });

    it('imports remotes with workspace scope, not global, so they only show up in this project', async () => {
      openProject(tmpHome);
      await writeGovardFixture(tmpHome);
      track(vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Import all (2)' as never));

      const second = activate(fakeContext());
      await settleScan();

      for (const c of second.connectionManager.list()) {
        expect(c.scope).toBe('workspace');
      }
    });

    it('stays silent when every govard hostname already exists as a connection', async () => {
      openProject(tmpHome);
      await writeGovardFixture(tmpHome);
      const second = activate(fakeContext());
      // No await: the fake memento applies update() synchronously, so both
      // records land before the auto-scan crosses its first async boundary
      // (the dynamic import). Awaiting here would hand the scan a window to
      // run first and prompt.
      void second.connectionManager.add({
        name: 'myshop-staging',
        host: 'staging.example.com',
        port: 22,
        username: 'deploy',
        remotePath: '/srv/www/staging',
        authMethod: 'agent',
      });
      void second.connectionManager.add({
        name: 'myshop-prod',
        host: 'prod.example.com',
        port: 22,
        username: 'deploy',
        remotePath: '/srv/www/prod',
        authMethod: 'agent',
      });
      const infoSpy = track(vi.spyOn(vscode.window, 'showInformationMessage'));
      await settleScan();

      expect(infoSpy).not.toHaveBeenCalled();
      expect(second.connectionManager.list()).toHaveLength(2);
    });

    it("respects Don't ask again and suppresses later scans", async () => {
      openProject(tmpHome);
      await writeGovardFixture(tmpHome);
      const infoSpy = track(vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue("Don't ask again" as never));
      // Both activations share one ExtensionContext, so the dismiss flag set
      // by the first scan is visible to the second: this is the production
      // shape (one context per window), and it keeps the outer beforeEach
      // activation's idle folder-listener out of the picture (it never fires
      // here, and its activate-time snapshot saw no folders).
      const sharedContext = fakeContext();
      activate(sharedContext);
      await settleScan();

      // The prompt appeared (proving the scan ran) and nothing was imported.
      // NOTE: toHaveBeenCalledWith needs the full 4-arg call (message + 3
      // buttons), so assert on the recorded first argument instead.
      expect(infoSpy.mock.calls[0][0]).toContain('myshop-staging');
      infoSpy.mockClear();

      activate(sharedContext);
      await settleScan();

      expect(infoSpy).not.toHaveBeenCalled();
    });

    it('manual command imports only the QuickPick subset and reports the already-present remainder', async () => {
      const second = activate(fakeContext());
      await second.connectionManager.add({
        name: 'myshop-staging',
        host: 'staging.example.com',
        port: 22,
        username: 'deploy',
        remotePath: '/srv/www/staging',
        authMethod: 'agent',
      });
      openProject(tmpHome);
      await writeGovardFixture(tmpHome);
      track(
        vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue([
          {
            label: 'myshop-prod',
            description: 'deploy@prod.example.com:/srv/www/prod',
            connection: {
              name: 'myshop-prod',
              host: 'prod.example.com',
              port: 22,
              username: 'deploy',
              remotePath: '/srv/www/prod',
              authMethod: 'agent',
              keyPath: undefined,
            },
          },
        ] as never),
      );
      const infoSpy = track(vi.spyOn(vscode.window, 'showInformationMessage'));

      await handlers.get('gangway.importGovardRemotes')!();

      expect(second.connectionManager.list().map((c) => c.name).sort()).toEqual(['myshop-prod', 'myshop-staging']);
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Already present'));
    });
  });

  /**
   * Command-layer wiring from the review pass: error actions that act,
   * single-item status bar, compare/refresh commands, upload-from-node, the
   * >5MB/binary open prompt, folder failure reports, and the keep-server
   * decoration refresh. Same track-and-restore discipline as the conflict
   * suite above (no global restore: the hoisted fakes must survive).
   */
  describe('command-layer wiring (review fixes)', () => {
    const spies: Array<{ mockRestore: () => void }> = [];
    function track<T extends { mockRestore: () => void }>(spy: T): T {
      spies.push(spy);
      return spy;
    }
    afterEach(() => {
      while (spies.length) spies.pop()!.mockRestore();
    });

    function nodeFor(remotePath: string, isDirectory = false) {
      return {
        connectionId: connection.id,
        entry: { path: remotePath, isDirectory, isSymbolicLink: false, size: 0 },
      };
    }

    function poolInstance(): { invalidate: ReturnType<typeof vi.fn>; getClient: ReturnType<typeof vi.fn> } {
      const mocked = vi.mocked(ConnectionPool);
      return mocked.mock.results[mocked.mock.results.length - 1].value as {
        invalidate: ReturnType<typeof vi.fn>;
        getClient: ReturnType<typeof vi.fn>;
      };
    }

    it('Retry from the error dialog re-runs the failed download and invalidates the dead client first', async () => {
      fakeRawClient.fastGet.mockRejectedValueOnce(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      );
      track(vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue('Retry' as never));

      await handlers.get('gangway.downloadFile')!(nodeFor('/var/www/app/config.php'));

      expect(fakeRawClient.fastGet).toHaveBeenCalledTimes(2);
      expect(poolInstance().invalidate).toHaveBeenCalledWith(connection.id);
    });

    it('Disconnect from the error dialog drops the client without retrying', async () => {
      fakeRawClient.fastGet.mockRejectedValueOnce(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      );
      track(vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue('Disconnect' as never));

      await handlers.get('gangway.downloadFile')!(nodeFor('/var/www/app/config.php'));

      expect(fakeRawClient.fastGet).toHaveBeenCalledTimes(1);
      expect(poolInstance().invalidate).toHaveBeenCalledWith(connection.id);
    });

    it('Open Output from the error dialog reveals the Gangway channel', async () => {
      const createSpy = track(vi.spyOn(vscode.window, 'createOutputChannel'));
      const second = activate(fakeContext());
      const conn2 = await second.connectionManager.add({
        name: 'staging2',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        remotePath: '/var/www',
        authMethod: 'password',
      });
      await second.connectionManager.setWorkspaceBinding(conn2.id);
      const channel = createSpy.mock.results[createSpy.mock.results.length - 1].value as {
        show: () => void;
      };
      const showSpy = track(vi.spyOn(channel, 'show'));
      track(vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue('Open Output' as never));
      fakeRawClient.fastGet.mockRejectedValueOnce(new Error('something exotic'));

      await handlers.get('gangway.downloadFile')!({
        connectionId: conn2.id,
        entry: { path: '/var/www/app/config.php', isDirectory: false, isSymbolicLink: false, size: 0 },
      });

      expect(showSpy).toHaveBeenCalledTimes(1);
      expect(fakeRawClient.fastGet).toHaveBeenCalledTimes(1);
    });

    it('gangway.compareFile diffs the tmp copy against fresh server bytes without pushing', async () => {
      const localFile = tmpFilePathFor(connection, '/var/www/app/config.php');
      await fs.mkdir(path.dirname(localFile), { recursive: true });
      await fs.writeFile(localFile, 'local content');
      const execSpy = track(vi.spyOn(vscode.commands, 'executeCommand'));

      await handlers.get('gangway.compareFile')!(nodeFor('/var/www/app/config.php'));

      expect(execSpy).toHaveBeenCalledWith(
        'vscode.diff',
        expect.objectContaining({ fsPath: localFile }),
        expect.objectContaining({ fsPath: `${localFile}.gangway-compare-fresh` }),
        expect.stringContaining('config.php'),
      );
      expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
    });

    it('gangway.compareFile warns instead of diffing a file that was never downloaded', async () => {
      const warnSpy = track(vi.spyOn(vscode.window, 'showWarningMessage'));
      const execSpy = track(vi.spyOn(vscode.commands, 'executeCommand'));

      await handlers.get('gangway.compareFile')!(nodeFor('/var/www/app/never.php'));

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no local copy'));
      expect(execSpy).not.toHaveBeenCalledWith('vscode.diff', expect.anything(), expect.anything(), expect.anything());
    });

    it('gangway.refreshExplorer refreshes the tree provider', async () => {
      const createSpy = track(vi.spyOn(vscode.window, 'createTreeView'));
      activate(fakeContext());
      const provider = (
        createSpy.mock.calls[createSpy.mock.calls.length - 1][1] as unknown as {
          treeDataProvider: { refresh: () => void };
        }
      ).treeDataProvider;
      const refreshSpy = track(vi.spyOn(provider, 'refresh'));

      await handlers.get('gangway.refreshExplorer')!();

      expect(refreshSpy).toHaveBeenCalledTimes(1);
    });

    it('caches link resolution across listings until the Refresh command clears it', async () => {
      const provider = capturedProvider;
      fakeRawClient.list.mockResolvedValue([{ name: 'ln', type: 'l' }]);
      const dir = nodeFor('/var/www/app', true);

      await provider.getChildren(dir);
      const first = fakeRawClient.realPath.mock.calls.length;
      expect(first).toBeGreaterThan(0);
      await provider.getChildren(dir);
      expect(fakeRawClient.realPath.mock.calls.length).toBe(first);

      await handlers.get('gangway.refreshExplorer')!();
      await provider.getChildren(dir);
      expect(fakeRawClient.realPath.mock.calls.length).toBeGreaterThan(first);
    });

    describe('link resolution cancellation', () => {
      const manyLinks = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `ln${i}`, type: 'l' }));
      function gatedRealPath() {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        fakeRawClient.realPath.mockImplementation(async (p: string) => {
          await gate;
          return p;
        });
        return release;
      }
      const settle = () => new Promise((r) => setTimeout(r, 0));

      it('a second listing of the same directory aborts the first, whose result carries no link info', async () => {
        const provider = capturedProvider as { getChildren: (n?: unknown) => Promise<Array<{ entry: { link?: unknown } }>> };
        fakeRawClient.list.mockResolvedValue(manyLinks(20));
        const release = gatedRealPath();
        const dir = nodeFor('/var/www/app', true);

        const first = provider.getChildren(dir);
        await settle();
        const second = provider.getChildren(dir);
        await settle();
        release();
        const [a, b] = await Promise.all([first, second]);

        expect(a.every((n) => n.entry.link === undefined)).toBe(true);
        expect(b.every((n) => n.entry.link !== undefined)).toBe(true);
        // 8 in flight for the superseded batch, then all 20 for the winner.
        expect(fakeRawClient.realPath.mock.calls.length).toBe(8 + 20);
      });

      it('Refresh aborts an in-flight batch so its pre-refresh results are never cached', async () => {
        const provider = capturedProvider as { getChildren: (n?: unknown) => Promise<unknown[]> };
        fakeRawClient.list.mockResolvedValue(manyLinks(4));
        const release = gatedRealPath();
        const dir = nodeFor('/var/www/app', true);

        const pending = provider.getChildren(dir);
        await settle();
        await handlers.get('gangway.refreshExplorer')!();
        release();
        await pending;

        fakeRawClient.realPath.mockClear().mockImplementation(async (p: string) => p);
        await provider.getChildren(dir);
        expect(fakeRawClient.realPath.mock.calls.length).toBe(4);
      });

      it('disposing the extension aborts in-flight resolution and caches nothing', async () => {
        const ctx = fakeContext();
        const second = activate(ctx);
        const conn = await second.connectionManager.add({
          name: 'other',
          host: 'example.org',
          port: 22,
          username: 'deploy',
          remotePath: '/var/www',
          authMethod: 'password',
        });
        const provider = capturedProvider as { getChildren: (n?: unknown) => Promise<unknown[]> };
        fakeRawClient.list.mockResolvedValue(manyLinks(20));
        const release = gatedRealPath();
        const dir = { connectionId: conn.id, entry: { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 } };

        const pending = provider.getChildren(dir);
        await settle();
        for (const d of ctx.subscriptions) d.dispose();
        release();
        await pending;
        expect(fakeRawClient.realPath.mock.calls.length).toBe(8);

        fakeRawClient.realPath.mockClear().mockImplementation(async (p: string) => p);
        await provider.getChildren(dir);
        expect(fakeRawClient.realPath.mock.calls.length).toBe(20);
      });
    });

    it('gangway.uploadFile accepts a tree file node, resolving paths through the tmp mirror', async () => {
      const localFile = tmpFilePathFor(connection, '/var/www/app/config.php');
      await fs.mkdir(path.dirname(localFile), { recursive: true });
      await fs.writeFile(localFile, 'edited content');
      await writeSidecar(localFile, {
        connectionId: connection.id,
        remotePath: '/var/www/app/config.php',
        mtime: 1700000000000,
        size: 14,
        downloadedAt: Date.now(),
      });
      fakeRawClient.stat.mockResolvedValue({ size: 14, modifyTime: 1700000000000, isDirectory: false, isSymbolicLink: false });

      await handlers.get('gangway.uploadFile')!(nodeFor('/var/www/app/config.php'));

      expect(fakeRawClient.fastPut).toHaveBeenCalledWith(localFile, '/var/www/app/config.php.tmp');
    });

    it('gangway.uploadFile warns instead of pushing a tree file that was never downloaded', async () => {
      const warnSpy = track(vi.spyOn(vscode.window, 'showWarningMessage'));

      await handlers.get('gangway.uploadFile')!(nodeFor('/var/www/app/never.php'));

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no local copy'));
      expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
    });

    it('gangway.uploadFile refuses an explicit path whose sidecar belongs to another connection', async () => {
      const localPath = path.join(tmpHome, 'foreign-explicit.php');
      await fs.writeFile(localPath, 'content from another server');
      await writeSidecar(localPath, {
        connectionId: 'a-different-connection-id',
        remotePath: '/var/www/app/config.php',
        mtime: 1700000000000,
        size: 5,
        downloadedAt: Date.now(),
      });
      const warnSpy = track(vi.spyOn(vscode.window, 'showWarningMessage'));

      await handlers.get('gangway.uploadFile')!(localPath, '/var/www/app/config.php');

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('different connection'));
      expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
    });

    it('prompts instead of auto-opening a download over 5MB, and opens on confirmation', async () => {
      fakeRawClient.stat.mockResolvedValue({
        size: 6 * 1024 * 1024,
        modifyTime: 1700000000000,
        isDirectory: false,
        isSymbolicLink: false,
      });
      const warnSpy = track(vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never));
      const showDocSpy = track(vi.spyOn(vscode.window, 'showTextDocument'));

      await handlers.get('gangway.downloadFile')!(nodeFor('/var/www/app/big.bin'));

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('exceeds the 5 MB'), 'Open anyway', 'Keep closed');
      expect(showDocSpy).not.toHaveBeenCalled();

      warnSpy.mockResolvedValue('Open anyway' as never);
      await handlers.get('gangway.downloadFile')!(nodeFor('/var/www/app/big.bin'));
      expect(showDocSpy).toHaveBeenCalledTimes(1);
    });

    it('prompts instead of auto-opening a binary download even when it is small', async () => {
      fakeRawClient.stat.mockResolvedValue({ size: 64, modifyTime: 1700000000000, isDirectory: false, isSymbolicLink: false });
      fakeRawClient.fastGet.mockImplementationOnce(async (_remotePath: string, localPath: string) => {
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await fs.writeFile(localPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
      });
      const warnSpy = track(vi.spyOn(vscode.window, 'showWarningMessage'));
      const showDocSpy = track(vi.spyOn(vscode.window, 'showTextDocument'));

      await handlers.get('gangway.downloadFile')!(nodeFor('/var/www/app/app.bin'));

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('binary'), 'Open anyway', 'Keep closed');
      expect(showDocSpy).not.toHaveBeenCalled();
    });

    it('refreshes the dirty badge when Keep server discards local edits', async () => {
      const { DirtyDecorationProvider } = await import('../src/ui/dirtyDecoration');
      const localPath = path.join(tmpHome, 'keepserver.php');
      await fs.writeFile(localPath, 'local edit');
      await writeSidecar(localPath, {
        connectionId: connection.id,
        remotePath: '/var/www/app/config.php',
        mtime: 1700000000000,
        size: 5,
        downloadedAt: Date.now(),
      });
      fakeRawClient.stat.mockResolvedValue({ size: 14, modifyTime: 1900000000000, isDirectory: false, isSymbolicLink: false });
      vscode.window.activeTextEditor = { document: { uri: { fsPath: localPath } } } as unknown as vscode.TextEditor;
      track(
        vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation((async (_msg: string, ...items: string[]) =>
          items.find((item) => /keep server/i.test(item))) as never),
      );
      const refreshSpy = track(vi.spyOn(DirtyDecorationProvider.prototype, 'refresh'));

      await handlers.get('gangway.uploadFile')!();

      expect(refreshSpy).toHaveBeenCalled();
    });

    it('owns a single status item across downloads and hides it when leaving tmp files', async () => {
      const createSpy = track(vi.spyOn(vscode.window, 'createStatusBarItem'));

      await handlers.get('gangway.downloadFile')!(nodeFor('/var/www/app/a.php'));
      await handlers.get('gangway.downloadFile')!(nodeFor('/var/www/app/b.php'));

      expect(createSpy).toHaveBeenCalledTimes(1);
      const item = createSpy.mock.results[0].value as { hide: () => void; show: () => void };
      const hideSpy = track(vi.spyOn(item, 'hide'));
      (vscode.window as unknown as { __test_fireDidChangeActiveTextEditor: (e: unknown) => void }).__test_fireDidChangeActiveTextEditor(undefined);
      expect(hideSpy).toHaveBeenCalled();
    });

    it('reports per-file folder failures and retries only the failed subset', async () => {
      fakeRawClient.list.mockImplementation(async (dirPath: string) =>
        dirPath === '/var/www/app'
          ? [
              { name: 'bad.php', type: '-' },
              { name: 'ok.php', type: '-' },
            ]
          : [],
      );
      fakeRawClient.fastGet.mockRejectedValueOnce(new Error('fastGet: Failure'));
      track(vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Retry failed' as never));

      await handlers.get('gangway.downloadFolder')!(nodeFor('/var/www/app', true));

      const badCalls = (fakeRawClient.fastGet.mock.calls as Array<[string, string]>).filter(([r]) => r === '/var/www/app/bad.php');
      const okCalls = (fakeRawClient.fastGet.mock.calls as Array<[string, string]>).filter(([r]) => r === '/var/www/app/ok.php');
      expect(badCalls).toHaveLength(2);
      expect(okCalls).toHaveLength(1);
    });

    it('warns that downloaded symlinks arrived as plain files', async () => {
      fakeRawClient.list.mockImplementation(async (dirPath: string) =>
        dirPath === '/var/www/app' ? [{ name: 'link.php', type: 'l' }] : [],
      );
      const warnSpy = track(vi.spyOn(vscode.window, 'showWarningMessage'));
      const infoSpy = track(vi.spyOn(vscode.window, 'showInformationMessage'));

      await handlers.get('gangway.downloadFolder')!(nodeFor('/var/www/app', true));

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('plain files'));
      expect(infoSpy).not.toHaveBeenCalled();
    });

    it('connects behind a cancellable progress notification naming the host', async () => {
      const seen: unknown[] = [];
      const originalWithProgress = vscode.window.withProgress;
      vscode.window.withProgress = ((opts: unknown, task: never) => {
        seen.push(opts);
        return originalWithProgress(opts as never, task);
      }) as typeof originalWithProgress;
      try {
        await handlers.get('gangway.downloadFile')!(nodeFor('/var/www/app/config.php'));
      } finally {
        vscode.window.withProgress = originalWithProgress;
      }

      expect(seen).toContainEqual(
        expect.objectContaining({ cancellable: true, title: expect.stringContaining('example.com') }),
      );
    });

    it('cancelling the connect progress aborts with a plain Cancelled notice, never an error dialog', async () => {
      poolInstance().getClient.mockImplementationOnce(() => new Promise(() => {}));
      const listeners: Array<() => void> = [];
      const originalWithProgress = vscode.window.withProgress;
      type ProgressTask = (
        progress: { report: (value: unknown) => void },
        token: { isCancellationRequested: boolean; onCancellationRequested: (listener: () => void) => { dispose: () => void } },
      ) => Promise<unknown>;
      vscode.window.withProgress = ((_opts: never, task: ProgressTask) => {
        const pending = task(
          { report: () => {} },
          {
            isCancellationRequested: false,
            onCancellationRequested: (listener: () => void) => {
              listeners.push(listener);
              return { dispose: () => {} };
            },
          },
        );
        for (const listener of listeners) listener();
        return pending;
      }) as unknown as typeof originalWithProgress;
      const infoSpy = track(vi.spyOn(vscode.window, 'showInformationMessage'));
      const errorSpy = track(vi.spyOn(vscode.window, 'showErrorMessage'));
      try {
        await handlers.get('gangway.downloadFile')!(nodeFor('/var/www/app/config.php'));
      } finally {
        vscode.window.withProgress = originalWithProgress;
      }

      expect(infoSpy).toHaveBeenCalledWith('Cancelled.');
      expect(errorSpy).not.toHaveBeenCalled();
      expect(fakeRawClient.stat).not.toHaveBeenCalled();
    });
  });

  describe('tree view: double click opens, single click only selects', () => {
    function nodeFor(remotePath: string, isDirectory = false) {
      return {
        connectionId: connection.id,
        entry: { path: remotePath, isDirectory, isSymbolicLink: false, size: 0 },
      };
    }

    // Driven through the registered 'gangway.internalFileClick' command --
    // the same thing VS Code invokes for every click on a TreeItem that
    // carries a `command` (gangwayTreeProvider.ts) -- rather than
    // `treeView.onDidChangeSelection`. A real TreeView only fires that
    // selection event when the selection actually changes, so it never
    // fires a second time for a real double click on an already-selected
    // item; driving these tests off it once hid exactly that bug (the
    // fixture fired the mock event manually regardless of whether the
    // selection "changed").
    function click(node: ReturnType<typeof nodeFor>) {
      handlers.get('gangway.internalFileClick')!(node);
    }

    it('clicking an unresolved link warns without Retry or any path and never downloads', async () => {
      const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
      const node = {
        connectionId: connection.id,
        entry: {
          path: '/var/www/app/shared/ln',
          isDirectory: false,
          isSymbolicLink: true,
          size: 0,
          link: { realPath: '/var/www/app/shared/ln', kind: 'unresolved' as const },
        },
      };
      click(node);
      click(node);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy.mock.calls[0]).toEqual(['ln could not be resolved right now. Refresh to try again.']);
      expect(fakeRawClient.stat).not.toHaveBeenCalled();
      expect(fakeRawClient.fastGet).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('a single click does not download or open the file', () => {
      click(nodeFor('/var/www/app/config.php'));

      expect(fakeRawClient.stat).not.toHaveBeenCalled();
    });

    it('clicking the same file node twice in quick succession downloads and opens it (double click)', async () => {
      const node = nodeFor('/var/www/app/config.php');
      click(node);
      click(node);
      // The handler is fired synchronously but runs async; let it settle.
      await vi.waitFor(() => expect(fakeRawClient.stat).toHaveBeenCalled());

      expect(fakeRawClient.stat).toHaveBeenCalledWith('/var/www/app/config.php');
      expect(fakeRawClient.fastGet).toHaveBeenCalledWith('/var/www/app/config.php', expect.any(String));
    });

    it('clicking two different file nodes in a row does not count as a double click on either', async () => {
      click(nodeFor('/var/www/app/a.php'));
      click(nodeFor('/var/www/app/b.php'));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fakeRawClient.stat).not.toHaveBeenCalled();
    });

    it('clicking a folder node never triggers a download, even twice in a row', async () => {
      const folder = nodeFor('/var/www/app', true);
      click(folder);
      click(folder);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fakeRawClient.stat).not.toHaveBeenCalled();
    });
  });

  describe('edit session: warns instead of silently opening a file another live session owns', () => {
    function nodeFor(remotePath: string, isDirectory = false) {
      return {
        connectionId: connection.id,
        entry: { path: remotePath, isDirectory, isSymbolicLink: false, size: 0 },
      };
    }

    it('opens normally when no other session has the file', async () => {
      fakeRawClient.stat.mockResolvedValue({ size: 5, modifyTime: 1700000000000, isDirectory: false, isSymbolicLink: false });
      const showDocSpy = vi.spyOn(vscode.window, 'showTextDocument');
      const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
      try {
        await handlers.get('gangway.downloadFile')!(nodeFor('/var/www/app/config.php'));
        expect(showDocSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        showDocSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it('warns, and does not open, when another live process already holds the edit session for this file', async () => {
      fakeRawClient.stat.mockResolvedValue({ size: 5, modifyTime: 1700000000000, isDirectory: false, isSymbolicLink: false });
      const localPath = tmpFilePathFor(connection, '/var/www/app/config.php');
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      // A different, still-running pid than this test process.
      const foreignPid = process.pid === 1 ? 2 : 1;
      await fs.writeFile(
        `${localPath}.gangway-session.json`,
        JSON.stringify({ pid: foreignPid, startedAt: Date.now() }),
        'utf8',
      );
      const showDocSpy = vi.spyOn(vscode.window, 'showTextDocument');
      const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);
      try {
        await handlers.get('gangway.downloadFile')!(nodeFor('/var/www/app/config.php'));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already open for editing in another Gangway session'), expect.anything(), 'Open here anyway');
        expect(showDocSpy).not.toHaveBeenCalled();
      } finally {
        showDocSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it('opens anyway once the user confirms past the other-session warning', async () => {
      fakeRawClient.stat.mockResolvedValue({ size: 5, modifyTime: 1700000000000, isDirectory: false, isSymbolicLink: false });
      const localPath = tmpFilePathFor(connection, '/var/www/app/config.php');
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      const foreignPid = process.pid === 1 ? 2 : 1;
      await fs.writeFile(
        `${localPath}.gangway-session.json`,
        JSON.stringify({ pid: foreignPid, startedAt: Date.now() }),
        'utf8',
      );
      const showDocSpy = vi.spyOn(vscode.window, 'showTextDocument');
      const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Open here anyway' as never);
      try {
        await handlers.get('gangway.downloadFile')!(nodeFor('/var/www/app/config.php'));
        expect(showDocSpy).toHaveBeenCalledTimes(1);
      } finally {
        showDocSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });

  describe('bulk destinations and open through links', () => {
    let lines: string[];
    let dnd: {
      handleDrag: (source: unknown[], dataTransfer: unknown, token: unknown) => Promise<void>;
      handleDrop: (target: unknown, dataTransfer: unknown, token: unknown) => Promise<void>;
    };
    let treeOptions: { canSelectMany?: boolean };
    let activated: ReturnType<typeof activate>;
    let conn: ConnectionConfig;
    let workRoot: string;
    let previousFolders: unknown;
    let errorSpy: MockInstance<typeof vscode.window.showErrorMessage>;
    let warnSpy: MockInstance<typeof vscode.window.showWarningMessage>;
    let infoSpy: MockInstance<typeof vscode.window.showInformationMessage>;

    /** Every path at or below `link` really lives below `real`; the rest resolves to itself. */
    function linkDir(link: string, real: string): void {
      fakeRawClient.realPath.mockImplementation(async (p: string) =>
        p === link || p.startsWith(`${link}/`) ? `${real}${p.slice(link.length)}` : p,
      );
    }

    beforeEach(async () => {
      lines = [];
      const outputSpy = vi.spyOn(vscode.window, 'createOutputChannel').mockReturnValue({
        appendLine: (line: string) => {
          lines.push(line);
        },
        show: () => {},
        dispose: () => {},
      } as never);
      const originalCreateTreeView = vscode.window.createTreeView;
      const treeSpy = vi.spyOn(vscode.window, 'createTreeView').mockImplementation(((id: string, options: never) => {
        dnd = (options as { dragAndDropController: typeof dnd }).dragAndDropController;
        treeOptions = options as typeof treeOptions;
        return originalCreateTreeView(id, options);
      }) as never);
      const fresh = activate(fakeContext());
      activated = fresh;
      outputSpy.mockRestore();
      treeSpy.mockRestore();
      conn = await fresh.connectionManager.add({
        name: 'linked',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        remotePath: '/var/www',
        authMethod: 'password',
      });
      await fresh.connectionManager.setWorkspaceBinding(conn.id);
      workRoot = path.join(tmpHome, 'work');
      await fs.mkdir(path.join(workRoot, 'sub'), { recursive: true });
      await fs.writeFile(path.join(workRoot, 'ok.php'), '<?php // ok');
      await fs.writeFile(path.join(workRoot, 'sub', 'x.php'), '<?php // x');
      previousFolders = vscode.workspace.workspaceFolders;
      (vscode.workspace as unknown as { workspaceFolders: { uri: { fsPath: string }; name: string }[] }).workspaceFolders = [
        { uri: { fsPath: workRoot }, name: 'work' },
      ];
      errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');
      warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
      infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
    });

    afterEach(() => {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = previousFolders;
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      infoSpy.mockRestore();
      mockWindow.__test_resetAnswers();
    });

    const putTargets = (): string[] => (fakeRawClient.fastPut.mock.calls as Array<[string, string]>).map(([, remote]) => remote);

    describe('drag and drop inside the tree', () => {
      const file = (p: string) => ({ connectionId: conn.id, entry: { path: p, isDirectory: false, isSymbolicLink: false, size: 1 } });
      const dir = (p: string, isSymbolicLink = false) => ({ connectionId: conn.id, entry: { path: p, isDirectory: true, isSymbolicLink, size: 0 } });
      const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const stats = (files: string[], dirs: string[]) =>
        fakeRawClient.stat.mockImplementation(async (p: string) => {
          if (dirs.includes(p)) return { size: 0, modifyTime: 0, isDirectory: true, isSymbolicLink: false };
          if (files.includes(p)) return { size: 1, modifyTime: 1, isDirectory: false, isSymbolicLink: false };
          throw enoent();
        });
      /** Drags `paths` out of the tree and drops them on `target`, through the real controller. */
      const dragAndDrop = async (paths: string[], target: unknown, connectionId = conn.id) => {
        const store = new Map<string, { asString(): Promise<string> }>();
        await dnd.handleDrag(
          paths.map((p) => ({ connectionId, entry: { path: p, isDirectory: false, isSymbolicLink: false, size: 1 } })),
          { set: (m: string, item: { asString(): Promise<string> }) => void store.set(m, item) },
          {},
        );
        await dnd.handleDrop(target, { get: (m: string) => store.get(m) }, {});
      };
      const moveModals = () =>
        warnSpy.mock.calls.filter((c) => typeof c[0] === 'string' && (c[0] as string).startsWith('Move '));

      afterEach(() => {
        (vscode.workspace as unknown as { __test_setConfig: (k: string, v: unknown) => void }).__test_setConfig(
          'gangway.confirmDragAndDrop',
          undefined,
        );
      });

      it('turns on multi-select for the tree', () => {
        expect(treeOptions.canSelectMany).toBe(true);
      });

      it('asks once, then moves every dragged item server-side', async () => {
        stats(['/var/www/a.php', '/var/www/b.php'], ['/var/www/dest']);
        mockWindow.__test_queueWarning('Move');

        await dragAndDrop(['/var/www/a.php', '/var/www/b.php'], dir('/var/www/dest'));

        expect(warnSpy).toHaveBeenCalledWith('Move 2 item(s) into /var/www/dest?', { modal: true }, 'Move');
        expect(fakeRawClient.posixRename).toHaveBeenCalledWith('/var/www/a.php', '/var/www/dest/a.php');
        expect(fakeRawClient.posixRename).toHaveBeenCalledWith('/var/www/b.php', '/var/www/dest/b.php');
        expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
        expect(infoSpy).toHaveBeenCalledWith('Moved 2 item(s).');
      });

      it('moves nothing when the confirmation is dismissed', async () => {
        stats(['/var/www/a.php'], ['/var/www/dest']);
        mockWindow.__test_queueWarning(undefined);
        await dragAndDrop(['/var/www/a.php'], dir('/var/www/dest'));
        expect(fakeRawClient.posixRename).not.toHaveBeenCalled();
      });

      it('skips the confirmation when gangway.confirmDragAndDrop is false', async () => {
        (vscode.workspace as unknown as { __test_setConfig: (k: string, v: unknown) => void }).__test_setConfig(
          'gangway.confirmDragAndDrop',
          false,
        );
        stats(['/var/www/a.php'], ['/var/www/dest']);
        await dragAndDrop(['/var/www/a.php'], dir('/var/www/dest'));
        expect(moveModals()).toHaveLength(0);
        expect(fakeRawClient.posixRename).toHaveBeenCalledWith('/var/www/a.php', '/var/www/dest/a.php');
      });

      it('drops on a file target into that file\'s parent folder', async () => {
        stats(['/var/www/a.php', '/var/www/dest/x.php'], ['/var/www/dest']);
        mockWindow.__test_queueWarning('Move');
        await dragAndDrop(['/var/www/a.php'], file('/var/www/dest/x.php'));
        expect(fakeRawClient.posixRename).toHaveBeenCalledWith('/var/www/a.php', '/var/www/dest/a.php');
      });

      it('drops on empty tree space into the connection root', async () => {
        stats(['/var/www/sub/a.php'], ['/var/www', '/var/www/sub']);
        mockWindow.__test_queueWarning('Move');
        await dragAndDrop(['/var/www/sub/a.php'], undefined);
        expect(fakeRawClient.posixRename).toHaveBeenCalledWith('/var/www/sub/a.php', '/var/www/a.php');
      });

      it('drops into a link folder inside the root, landing on the real folder', async () => {
        linkDir('/var/www/current', '/var/www/releases/42');
        stats(['/var/www/a.php'], ['/var/www/current', '/var/www/releases/42']);
        mockWindow.__test_queueWarning('Move');
        await dragAndDrop(['/var/www/a.php'], dir('/var/www/current', true));
        expect(fakeRawClient.posixRename).toHaveBeenCalledWith('/var/www/a.php', '/var/www/releases/42/a.php');
      });

      it('writes nothing when the destination link leaves the root and is not confirmed', async () => {
        linkDir('/var/www/shared', '/etc/ext');
        stats(['/var/www/a.php'], ['/var/www/shared', '/etc/ext']);
        mockWindow.__test_queueWarning('Move', undefined);
        await dragAndDrop(['/var/www/a.php'], dir('/var/www/shared', true));
        expect(fakeRawClient.posixRename).not.toHaveBeenCalled();
        expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
      });

      it('refuses on a frozen connection and moves nothing', async () => {
        const frozen = await activated.connectionManager.add({
          name: 'prod',
          host: 'example.com',
          port: 22,
          username: 'deploy',
          remotePath: '/var/www',
          authMethod: 'password',
          frozen: true,
        });
        await activated.connectionManager.setWorkspaceBinding(frozen.id);
        stats(['/var/www/a.php'], ['/var/www/dest']);
        const target = { connectionId: frozen.id, entry: { path: '/var/www/dest', isDirectory: true, isSymbolicLink: false, size: 0 } };
        await dragAndDrop(['/var/www/a.php'], target, frozen.id);
        expect(fakeRawClient.posixRename).not.toHaveBeenCalled();
        expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/frozen/i));
      });

      it('ignores items that belong to another connection', async () => {
        stats(['/var/www/a.php'], ['/var/www/dest']);
        await dragAndDrop(['/var/www/a.php'], dir('/var/www/dest'), 'some-other-connection');
        expect(fakeRawClient.posixRename).not.toHaveBeenCalled();
      });

      it('asks once for several conflicts and never downloads a skipped source', async () => {
        const names = ['a.php', 'b.php', 'c.php'];
        stats(
          [...names.map((n) => `/var/www/${n}`), ...names.map((n) => `/var/www/dest/${n}`)],
          ['/var/www/dest'],
        );
        mockWindow.__test_queueWarning('Move', 'Skip the conflicting items');

        await dragAndDrop(names.map((n) => `/var/www/${n}`), dir('/var/www/dest'));

        const conflictCalls = warnSpy.mock.calls.filter((c) => String(c[0]).includes('already exist'));
        expect(conflictCalls).toHaveLength(1);
        expect(String(conflictCalls[0][0])).toContain('a.php, b.php and c.php');
        expect(conflictCalls[0].slice(2)).toEqual(['Review each', 'Skip the conflicting items']);
        expect(fakeRawClient.posixRename).not.toHaveBeenCalled();
        expect(fakeRawClient.fastGet).not.toHaveBeenCalled();
      });

      it('cancelling the conflict prompt moves nothing', async () => {
        const names = ['a.php', 'b.php'];
        stats(
          [...names.map((n) => `/var/www/${n}`), ...names.map((n) => `/var/www/dest/${n}`)],
          ['/var/www/dest'],
        );
        mockWindow.__test_queueWarning('Move', undefined);
        await dragAndDrop(names.map((n) => `/var/www/${n}`), dir('/var/www/dest'));
        expect(fakeRawClient.posixRename).not.toHaveBeenCalled();
      });
    });

    it('a folder upload whose destination is an out-of-root link writes nothing and reports the failure', async () => {
      linkDir('/var/www/app', '/etc/ext');
      fakeRawClient.list.mockImplementation(async (dirPath: string) =>
        dirPath === '/var/www/app' ? [{ name: 'clean.php', type: '-' }] : [],
      );
      const localFile = tmpFilePathFor(conn, '/var/www/app/clean.php');
      await fs.mkdir(path.dirname(localFile), { recursive: true });
      await fs.writeFile(localFile, 'clean content');
      await writeSidecar(localFile, {
        connectionId: conn.id,
        remotePath: '/var/www/app/clean.php',
        mtime: 0,
        size: 0,
        downloadedAt: Date.now(),
      });

      await handlers.get('gangway.uploadFolder')!({
        connectionId: conn.id,
        entry: { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 },
      });

      expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
      expect(fakeRawClient.mkdir).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('1 file(s) failed'), 'Retry failed', 'Dismiss');
      expect(lines.some((l) => l.includes('/var/www/app/clean.php') && /outside/.test(l))).toBe(true);
    });

    it('a sync upload refuses only the files under an out-of-root link and uploads the rest', async () => {
      linkDir('/var/www/sub', '/etc/ext');
      mockWindow.__test_queuePick((items: unknown[]) => items);

      await handlers.get('gangway.syncWorkspaceUp')!();

      expect(putTargets()).toContain('/var/www/ok.php.tmp');
      expect(putTargets().some((p) => p.startsWith('/var/www/sub/'))).toBe(false);
      expect(fakeRawClient.mkdir).not.toHaveBeenCalledWith('/var/www/sub', true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('1 file(s) failed'), 'Retry failed', 'Dismiss');
      expect(lines.some((l) => l.includes('/var/www/sub/x.php') && /outside/.test(l))).toBe(true);
    });

    it('a sync upload of a new nested folder under an out-of-root link writes nothing there', async () => {
      fakeRawClient.realPath.mockImplementation(async (p: string) => {
        if (p === '/var/www/shared') return '/etc/ext';
        // The new folders do not exist yet on the server: realpath reports missing.
        if (p.startsWith('/var/www/shared/')) return undefined;
        return p;
      });
      fakeRawClient.lstat.mockImplementation(async (p: string) => {
        if (p.startsWith('/var/www/shared/')) throw Object.assign(new Error('No such file'), { code: 2 });
        return { size: 0, modifyTime: 0, isDirectory: true, isSymbolicLink: p === '/var/www/shared' };
      });
      await fs.mkdir(path.join(workRoot, 'shared', 'new', 'sub'), { recursive: true });
      await fs.writeFile(path.join(workRoot, 'shared', 'new', 'sub', 'x.php'), '<?php // nested');
      mockWindow.__test_queuePick((items: unknown[]) => items);

      await handlers.get('gangway.syncWorkspaceUp')!();

      expect(putTargets().some((p) => p.startsWith('/var/www/shared/'))).toBe(false);
      expect((fakeRawClient.mkdir.mock.calls as Array<[string]>).some(([p]) => p.startsWith('/var/www/shared'))).toBe(false);
      expect(lines.some((l) => l.includes('/var/www/shared/new/sub/x.php') && /outside/.test(l))).toBe(true);
    });

    it('a mapped single-file push into an out-of-root link directory writes nothing', async () => {
      linkDir('/var/www/sub', '/etc/ext');
      mockWindow.__test_queueWarning('Upload');

      await handlers.get('gangway.uploadMappedFile')!({ fsPath: path.join(workRoot, 'sub', 'x.php') });

      expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
      expect(fakeRawClient.mkdir).not.toHaveBeenCalled();
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('"/var/www/sub"');
    });

    it('a mapped folder push refuses the out-of-root link directory per file and pushes the rest', async () => {
      linkDir('/var/www/sub', '/etc/ext');
      mockWindow.__test_queueWarning('Upload 2 files');

      await handlers.get('gangway.uploadMappedFolder')!({ fsPath: workRoot });

      expect(putTargets()).toEqual(['/var/www/ok.php.tmp']);
      expect(lines.some((l) => l.includes('/var/www/sub/x.php') && /outside/.test(l))).toBe(true);
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('1 failed'));
    });

    it('opening a broken link shows the broken-link message, offers no Retry, and writes nothing to disk', async () => {
      const gone = '/var/www/app/gone.php';
      fakeRawClient.realPath.mockImplementation(async (p: string) => (p === gone ? undefined : p));
      fakeRawClient.lstat.mockImplementation(async (p: string) => ({
        size: 0,
        modifyTime: 0,
        isDirectory: false,
        isSymbolicLink: p === gone,
      }));

      await handlers.get('gangway.downloadFile')!({
        connectionId: conn.id,
        entry: { path: gone, isDirectory: false, isSymbolicLink: true, size: 0 },
      });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]).toEqual(['gone.php is a broken link']);
      expect(fakeRawClient.fastGet).not.toHaveBeenCalled();
      await expect(fs.stat(tmpFilePathFor(conn, gone))).rejects.toThrow();
      await expect(fs.stat(path.dirname(tmpFilePathFor(conn, gone)))).rejects.toThrow();
    });

    it('opening a link loop shows the loop message and offers no Retry', async () => {
      const loop = '/var/www/app/loop.php';
      fakeRawClient.realPath.mockImplementation(async (p: string) => {
        if (p === loop) throw Object.assign(new Error('Too many levels of symbolic links'), { code: 'ELOOP' });
        return p;
      });

      await handlers.get('gangway.downloadFile')!({
        connectionId: conn.id,
        entry: { path: loop, isDirectory: false, isSymbolicLink: true, size: 0 },
      });

      expect(errorSpy.mock.calls).toEqual([['loop.php is a symbolic link loop']]);
      expect(fakeRawClient.fastGet).not.toHaveBeenCalled();
    });
  });
});

describe('activate - the connection selector (pickConnection) and Manage Remotes page', () => {
  let tmpHome: string;
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  let osTmpdirSpy: ReturnType<typeof vi.spyOn>;
  let result: ReturnType<typeof activate>;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gangway-tree-cmd-test-'));
    osTmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(tmpHome);
    resetFakeClient();
    vscode.window.activeTextEditor = undefined;

    handlers = new Map();
    const original = vscode.commands.registerCommand;
    vscode.commands.registerCommand = (id: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(id, handler);
      return original(id, handler);
    };

    result = activate(fakeContext());
  });

  afterEach(async () => {
    osTmpdirSpy.mockRestore();
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('gangway.pickConnection binds the connection the user picked from the QuickPick', async () => {
    const staging = await result.connectionManager.add({
      name: 'staging',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      remotePath: '/var/www',
      authMethod: 'password',
    });
    await result.connectionManager.add({
      name: 'prod',
      host: 'prod.example.com',
      port: 22,
      username: 'deploy',
      remotePath: '/var/www',
      authMethod: 'agent',
    });
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation(
      (async (items: Array<{ label: string; connectionId?: string }>) =>
        items.find((i) => i.label === 'staging')) as never,
    );

    await handlers.get('gangway.pickConnection')!();

    expect(result.connectionManager.getWorkspaceBinding()).toBe(staging.id);
  });

  it('gangway.pickConnection opens a blank Manage Remotes page for "Add New Remote..."', async () => {
    const createPanelSpy = vi.spyOn(vscode.window, 'createWebviewPanel');
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation(
      (async (items: Array<{ label: string; action?: string }>) => items.find((i) => i.action === 'add')) as never,
    );

    await handlers.get('gangway.pickConnection')!();

    const rawPanel = createPanelSpy.mock.results[0]!.value as { webview: { html: string } };
    expect(rawPanel.webview.html).toContain('data-connection-id=""');
    expect(rawPanel.webview.html).toContain('New Connection');
  });

  it('gangway.pickConnection opens Manage Remotes pre-filled with the bound connection for "Manage Remotes..."', async () => {
    const staging = await result.connectionManager.add({
      name: 'staging',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      remotePath: '/var/www',
      authMethod: 'password',
    });
    await result.connectionManager.setWorkspaceBinding(staging.id);
    const createPanelSpy = vi.spyOn(vscode.window, 'createWebviewPanel');
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation(
      (async (items: Array<{ label: string; action?: string }>) => items.find((i) => i.action === 'manage')) as never,
    );

    await handlers.get('gangway.pickConnection')!();

    const rawPanel = createPanelSpy.mock.results[0]!.value as { webview: { html: string } };
    expect(rawPanel.webview.html).toContain(`data-connection-id="${staging.id}"`);
    expect(rawPanel.webview.html).toContain('value="staging"');
  });

  it('gangway.manageRemotes opens the page with every saved connection embedded for the sidebar, and deleting one from it clears its workspace binding', async () => {
    const staging = await result.connectionManager.add({
      name: 'staging',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      remotePath: '/var/www',
      authMethod: 'key',
      keyPath: '/home/deploy/.ssh/id_ed25519',
    });
    const prod = await result.connectionManager.add({
      name: 'prod',
      host: 'prod.example.com',
      port: 22,
      username: 'deploy',
      remotePath: '/var/www',
      authMethod: 'agent',
    });
    await result.connectionManager.setWorkspaceBinding(staging.id);
    const createPanelSpy = vi.spyOn(vscode.window, 'createWebviewPanel');
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as never);

    handlers.get('gangway.manageRemotes')!();

    const rawPanel = createPanelSpy.mock.results[0]!.value as {
      webview: { html: string };
      __test_fireMessage: (m: unknown) => Promise<void>;
    };
    // Pre-filled with the bound connection.
    expect(rawPanel.webview.html).toContain(`data-connection-id="${staging.id}"`);
    // Both connections' non-secret fields are embedded for the sidebar list.
    expect(rawPanel.webview.html).toContain('"name":"staging"');
    expect(rawPanel.webview.html).toContain('"name":"prod"');

    const nonceMatch = rawPanel.webview.html.match(/data-nonce="([^"]+)"/)!;
    await rawPanel.__test_fireMessage({ nonce: nonceMatch[1], type: 'deleteConnection', payload: { id: staging.id } });

    expect(result.connectionManager.list().map((c) => c.id)).toEqual([prod.id]);
    expect(result.connectionManager.getWorkspaceBinding()).toBeUndefined();
  });
});

/**
 * Every test above pre-binds a connection directly via connectionManager.add
 * + setWorkspaceBinding in beforeEach, bypassing gangway.manageRemotes
 * and its real ConnectionFormPanel entirely. That exact seam (real webview
 * panel -> saveConnection message -> workspace binding -> a command that
 * depends on it) is what hid three Critical, whole-branch-review-only bugs:
 * a dead Save button, no workspace binding call anywhere in production code,
 * and no credential fields on the form. This suite drives that seam for
 * real, through the actual command handler activate() registers, instead of
 * calling ConnectionManager/ConnectionFormPanel directly.
 */
describe('activate - end to end via the real connection form panel', () => {
  let tmpHome: string;
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  let osTmpdirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gangway-form-e2e-'));
    osTmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(tmpHome);
    resetFakeClient();
    vscode.window.activeTextEditor = undefined;

    handlers = new Map();
    const original = vscode.commands.registerCommand;
    vscode.commands.registerCommand = (id: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(id, handler);
      return original(id, handler);
    };
  });

  afterEach(async () => {
    osTmpdirSpy.mockRestore();
    vscode.window.activeTextEditor = undefined;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('a connection saved through the real webview panel is immediately usable by gangway.downloadFile, with no manual binding step anywhere in this test', async () => {
    const result = activate(fakeContext());

    const createPanelSpy = vi.spyOn(vscode.window, 'createWebviewPanel');
    handlers.get('gangway.manageRemotes')!();
    const rawPanel = createPanelSpy.mock.results[0]!.value as {
      webview: { html: string };
      __test_fireMessage: (message: unknown) => Promise<void>;
    };
    createPanelSpy.mockRestore();

    // The nonce is generated per-panel inside ConnectionFormPanel and never
    // exposed directly; the real webview only ever learns it by reading
    // data-nonce off the HTML activate() actually set, so the test does too.
    const nonceMatch = rawPanel.webview.html.match(/data-nonce="([^"]+)"/);
    expect(nonceMatch).toBeTruthy();

    fakeRawClient.stat.mockResolvedValue({ size: 5, modifyTime: 1700000000000, isDirectory: false, isSymbolicLink: false });

    await rawPanel.__test_fireMessage({
      nonce: nonceMatch![1],
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

    const createdConnectionId = result.connectionManager.list()[0]!.id;
    const handler = handlers.get('gangway.downloadFile')!;
    await handler({
      connectionId: createdConnectionId,
      entry: { path: '/var/www/app/config.php', isDirectory: false, isSymbolicLink: false, size: 5 },
    });

    expect(fakeRawClient.fastGet).toHaveBeenCalledWith('/var/www/app/config.php', expect.any(String));
  });
});
