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
// posixRename/list. Real SFTP `stat()` returns `modifyTime`, never `mtime` --
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
  posixRename: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
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
    type ProgressOptions = { cancellable?: boolean; location?: vscode.ProgressLocation | { viewId: string } };
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

    expect(progressOptions).toHaveLength(2);
    for (const options of progressOptions) {
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
