import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
// Relative mock import for the test-only answer queues (__test_queue*):
// same runtime instance the handlers use, full types under tsc.
import { window as mockWindow, workspace as mockWorkspace } from './mocks/vscode';

/**
 * Mapped-file commands (spec §3–§4): the thin handlers in `src/extension.ts`
 * that resolve a workspace path through the connection's mappings and then
 * transfer one file. The harness mirrors `test/extension.test.ts` (same
 * connectionPool module mock so the full stack runs -- adapter translation +
 * mappedTransfer -- with no network) but seeds an *explicit* mapping so the
 * resolver, not the default rule, picks the remote path.
 */

// Same shared fake raw SFTP client as extension.test.ts, created via
// vi.hoisted so both the vi.mock(...) factory and the test bodies reference
// the exact same object. `fastGet` writes 'server content' so a download can
// be asserted on real bytes; `modifyTime` (never `mtime`) matches what the
// adapter expects to translate.
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

// activate() builds its own ConnectionPool internally (not injectable), and
// the real pool would construct a real ssh2-sftp-client that attempts a real
// SSH handshake. Replacing the whole module lets the handlers below run the
// full command body -- adapter translation + the real mappedTransfer
// primitives -- without any network I/O. `hasClient: true` skips the
// connecting-progress wrapper, so a handler call resolves the pooled client
// in the same tick.
vi.mock('../src/transfer/connectionPool', () => ({
  ConnectionPool: vi.fn().mockImplementation(() => ({
    getClient: vi.fn().mockResolvedValue(fakeRawClient),
    invalidate: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
    hasClient: vi.fn().mockReturnValue(true),
  })),
}));

import { activate } from '../src/extension';
import { tmpFilePathFor } from '../src/tmpPath';
import { writeSidecar } from '../src/tmpStore';
import type { ConnectionManager } from '../src/connectionManager';
import type { RemoteTreeNode } from '../src/ui/gangwayTreeProvider';
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

/**
 * `globalStorageUri` is the real, always-writable per-extension directory VS
 * Code hands every extension (the audit log lives under it); pointing it at
 * the per-test tmp dir keeps a run self-contained and lets the pure-B pins
 * assert that no audit file was ever created.
 */
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

function remoteNode(remotePath: string): RemoteTreeNode {
  return {
    connectionId: connection.id,
    entry: { path: remotePath, isDirectory: false, isSymbolicLink: false, size: 5 },
  };
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gangway-mapped-test-'));
  wsRoot = path.join(tmpHome, 'proj');
  globalStorageDir = path.join(tmpHome, 'global-storage');
  await fs.mkdir(wsRoot, { recursive: true });
  // Deliberately a targeted spy restored by its own reference, never
  // `vi.restoreAllMocks()`: that global call also tears down the
  // connectionPool module mock and the hoisted fakeRawClient vi.fn()s.
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

describe('mapped single file commands', () => {
  it('uploads the clicked explorer file on Upload, through a temp put + posix rename', async () => {
    const localFile = path.join(wsRoot, 'app.php');
    await fs.writeFile(localFile, '<?php echo 1;');
    mockWindow.__test_queueWarning('Upload');
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

    await handlers.get('gangway.uploadMappedFile')!({ fsPath: localFile });

    expect(fakeRawClient.fastPut).toHaveBeenCalledWith(localFile, '/var/www/app.php.tmp');
    expect(fakeRawClient.posixRename).toHaveBeenCalledWith('/var/www/app.php.tmp', '/var/www/app.php');
    expect(infoSpy).toHaveBeenCalledWith(`Uploaded ${localFile} → /var/www/app.php.`);
    infoSpy.mockRestore();
  });

  it('states source, destination, and the overwrite consequence in the confirm', async () => {
    const localFile = path.join(wsRoot, 'app.php');
    await fs.writeFile(localFile, '<?php echo 1;');
    mockWindow.__test_queueWarning('Upload');
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');

    await handlers.get('gangway.uploadMappedFile')!({ fsPath: localFile });

    expect(warnSpy).toHaveBeenCalledWith(
      `Upload ${localFile} → /var/www/app.php on "staging"? This overwrites the server copy.`,
      'Upload',
      'Cancel',
    );
    warnSpy.mockRestore();
  });

  it('uploads nothing when the confirm is dismissed', async () => {
    const localFile = path.join(wsRoot, 'app.php');
    await fs.writeFile(localFile, '<?php echo 1;');
    // Nothing queued: the prompt resolves undefined, i.e. the user dismissed it.
    await handlers.get('gangway.uploadMappedFile')!({ fsPath: localFile });

    expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
    expect(fakeRawClient.posixRename).not.toHaveBeenCalled();
  });

  it('warns with the effective default and offers Open Mappings when the file sits outside every mapping', async () => {
    const outside = path.join(tmpHome, 'elsewhere', 'app.php');
    await fs.mkdir(path.dirname(outside), { recursive: true });
    await fs.writeFile(outside, '<?php echo 1;');
    mockWindow.__test_queueWarning('Open Mappings');
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    const execSpy = vi.spyOn(vscode.commands, 'executeCommand');

    await handlers.get('gangway.uploadMappedFile')!({ fsPath: outside });

    expect(warnSpy).toHaveBeenCalledWith(
      `${outside} is not inside any path mapping of "staging" (default: ${wsRoot} → /var/www).`,
      'Open Mappings',
      'Cancel',
    );
    expect(execSpy).toHaveBeenCalledWith('gangway.manageRemotes');
    expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    execSpy.mockRestore();
  });

  it('downloads the mapped remote file over the local file, leaving no staging sibling', async () => {
    const localFile = path.join(wsRoot, 'app.php');
    await fs.writeFile(localFile, 'stale local content');
    mockWindow.__test_queueWarning('Download');
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

    await handlers.get('gangway.downloadMappedFile')!({ fsPath: localFile });

    expect(fakeRawClient.fastGet).toHaveBeenCalledWith('/var/www/app.php', `${localFile}.gangway-downloading`);
    expect(await fs.readFile(localFile, 'utf8')).toBe('server content');
    expect(await fs.readdir(wsRoot)).toEqual(['app.php']);
    expect(infoSpy).toHaveBeenCalledWith(`Downloaded /var/www/app.php → ${localFile}.`);
    infoSpy.mockRestore();
  });

  it('downloads nothing when the download confirm is dismissed', async () => {
    const localFile = path.join(wsRoot, 'app.php');
    await fs.writeFile(localFile, 'stale local content');

    await handlers.get('gangway.downloadMappedFile')!({ fsPath: localFile });

    expect(fakeRawClient.fastGet).not.toHaveBeenCalled();
    expect(await fs.readFile(localFile, 'utf8')).toBe('stale local content');
  });

  it('downloads a remote tree item into the mapped workspace file', async () => {
    const localFile = path.join(wsRoot, 'nested', 'config.php');
    mockWindow.__test_queueWarning('Download');
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

    await handlers.get('gangway.downloadToWorkspaceFile')!(remoteNode('/var/www/nested/config.php'));

    expect(warnSpy).toHaveBeenCalledWith(
      `Download /var/www/nested/config.php on "staging" → ${localFile}? This overwrites your local file.`,
      'Download',
      'Cancel',
    );
    expect(fakeRawClient.fastGet).toHaveBeenCalledWith('/var/www/nested/config.php', `${localFile}.gangway-downloading`);
    expect(await fs.readFile(localFile, 'utf8')).toBe('server content');
    expect(infoSpy).toHaveBeenCalledWith(`Downloaded /var/www/nested/config.php → ${localFile}.`);
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('stays silent for a remote tree item outside every mapping (the menu is the gate)', async () => {
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');

    await handlers.get('gangway.downloadToWorkspaceFile')!(remoteNode('/etc/passwd'));

    expect(warnSpy).not.toHaveBeenCalled();
    expect(fakeRawClient.fastGet).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

/**
 * Mapped-folder commands (spec §4 folder bullet): the count-confirm, the
 * fresh walk that feeds it, exclude/symlink accounting, the not-found
 * tolerant remote scan (a mapping may point at a directory the server does
 * not have yet), and cancellation reporting what already landed. Same
 * harness as the single-file block above.
 */
describe('mapped folder commands', () => {
  /** Creates `<wsRoot>/app/<rel>` for every rel and returns the local root. */
  async function makeLocalFolder(...rels: string[]): Promise<string> {
    const localRoot = path.join(wsRoot, 'app');
    await fs.mkdir(localRoot, { recursive: true });
    for (const rel of rels) {
      const full = path.join(localRoot, ...rel.split('/'));
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, `content of ${rel}`);
    }
    return localRoot;
  }

  function folderNode(remotePath: string): RemoteTreeNode {
    return {
      connectionId: connection.id,
      entry: { path: remotePath, isDirectory: true, isSymbolicLink: false, size: 0 },
    };
  }

  it('uploads every file of a mapped folder, temp put + posix rename per file', async () => {
    const localRoot = await makeLocalFolder('one.php', 'sub/two.php');
    mockWindow.__test_queueWarning('Upload 2 files');
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

    await handlers.get('gangway.uploadMappedFolder')!({ fsPath: localRoot });

    expect(warnSpy).toHaveBeenCalledWith(
      `Upload 2 file(s) in ${localRoot} → /var/www/app? Server copies will be overwritten.`,
      'Upload 2 files',
      'Cancel',
    );
    expect(fakeRawClient.fastPut).toHaveBeenCalledWith(path.join(localRoot, 'one.php'), '/var/www/app/one.php.tmp');
    expect(fakeRawClient.fastPut).toHaveBeenCalledWith(path.join(localRoot, 'sub', 'two.php'), '/var/www/app/sub/two.php.tmp');
    expect(fakeRawClient.posixRename).toHaveBeenCalledWith('/var/www/app/one.php.tmp', '/var/www/app/one.php');
    expect(fakeRawClient.posixRename).toHaveBeenCalledWith('/var/www/app/sub/two.php.tmp', '/var/www/app/sub/two.php');
    expect(infoSpy).toHaveBeenCalledWith('Uploaded 2 file(s) to /var/www/app.');
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('uploads nothing when the folder confirm is dismissed', async () => {
    const localRoot = await makeLocalFolder('one.php', 'two.php');
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

    // Nothing queued: the prompt resolves undefined, i.e. the user dismissed it.
    await handlers.get('gangway.uploadMappedFolder')!({ fsPath: localRoot });

    expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
    expect(fakeRawClient.posixRename).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    infoSpy.mockRestore();
  });

  it('reports a symlinked local entry instead of uploading it', async () => {
    const localRoot = await makeLocalFolder('real.php');
    await fs.symlink('real.php', path.join(localRoot, 'link.php'));
    mockWindow.__test_queueWarning('Upload 1 files');
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

    await handlers.get('gangway.uploadMappedFolder')!({ fsPath: localRoot });

    expect(warnSpy).toHaveBeenCalledWith(
      `Upload 1 file(s) in ${localRoot} → /var/www/app? Server copies will be overwritten. (+1 symlinks skipped)`,
      'Upload 1 files',
      'Cancel',
    );
    expect(fakeRawClient.fastPut).toHaveBeenCalledTimes(1);
    expect(fakeRawClient.fastPut).toHaveBeenCalledWith(path.join(localRoot, 'real.php'), '/var/www/app/real.php.tmp');
    expect(infoSpy).toHaveBeenCalledWith('Uploaded 1 file(s) to /var/www/app. 1 symlink(s) skipped.');
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('counts an excluded file in the confirm but never transfers it', async () => {
    const localRoot = await makeLocalFolder('one.php', 'node_modules/pkg/index.js');
    mockWindow.__test_queueWarning('Upload 1 files');
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

    await handlers.get('gangway.uploadMappedFolder')!({ fsPath: localRoot });

    expect(warnSpy).toHaveBeenCalledWith(
      `Upload 1 file(s) in ${localRoot} → /var/www/app? Server copies will be overwritten. (+1 excluded)`,
      'Upload 1 files',
      'Cancel',
    );
    expect(fakeRawClient.fastPut).toHaveBeenCalledTimes(1);
    expect(fakeRawClient.fastPut).toHaveBeenCalledWith(path.join(localRoot, 'one.php'), '/var/www/app/one.php.tmp');
    expect(infoSpy).toHaveBeenCalledWith('Uploaded 1 file(s) to /var/www/app. 1 file(s) excluded by patterns.');
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('uploads nothing and says why when every file is excluded', async () => {
    const localRoot = await makeLocalFolder('node_modules/pkg/index.js');
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

    await handlers.get('gangway.uploadMappedFolder')!({ fsPath: localRoot });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      `Nothing to upload for ${localRoot} → /var/www/app. 1 file(s) excluded by patterns.`,
    );
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('walks former trash dirs as ordinary remote dirs (nothing is reserved)', async () => {
    // No remote footprint anymore: a `.trash-gangway` left by an old version
    // is just another directory, so a mapped download pulls its contents like
    // any other file. Listed explicitly, so the inclusion is the (absent)
    // filter at work -- not a listing that simply never mentioned the tree.
    const localRoot = path.join(wsRoot, 'app');
    fakeRawClient.list.mockImplementation(async (dirPath: string) =>
      dirPath === '/var/www/app'
        ? [
            { name: 'one.php', type: '-', size: 5 },
            { name: '.trash-gangway', type: 'd' },
          ]
        : dirPath === '/var/www/app/.trash-gangway'
          ? [{ name: 'deleted.php', type: '-', size: 9 }]
          : [],
    );
    mockWindow.__test_queueWarning('Download 2 files');
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

    await handlers.get('gangway.downloadMappedFolder')!({ fsPath: localRoot });

    // Both files are tasks now: the confirm describes the two user files
    // that will move.
    expect(warnSpy).toHaveBeenCalledWith(
      `Download 2 file(s) from /var/www/app → ${localRoot}? This overwrites your local files.`,
      'Download 2 files',
      'Cancel',
    );
    expect(fakeRawClient.fastGet).toHaveBeenCalledTimes(2);
    expect(fakeRawClient.fastGet).toHaveBeenCalledWith(
      '/var/www/app/one.php',
      `${path.join(localRoot, 'one.php')}.gangway-downloading`,
    );
    expect(fakeRawClient.fastGet).toHaveBeenCalledWith(
      '/var/www/app/.trash-gangway/deleted.php',
      `${path.join(localRoot, '.trash-gangway', 'deleted.php')}.gangway-downloading`,
    );
    expect(infoSpy).toHaveBeenCalledWith(`Downloaded 2 file(s) into ${localRoot}.`);
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('materializes a remote directory that holds no file at all', async () => {
    // An empty remote directory has no task of its own, and pullMappedFile
    // only mkdirs a transferred file's parent -- so without the plan's dirs
    // the directory would silently never appear locally.
    const localRoot = path.join(wsRoot, 'app');
    fakeRawClient.list.mockImplementation(async (dirPath: string) =>
      dirPath === '/var/www/app'
        ? [
            { name: 'one.php', type: '-', size: 5 },
            { name: 'empty', type: 'd' },
            { name: 'nested', type: 'd' },
          ]
        : dirPath === '/var/www/app/nested'
          ? [{ name: 'deeper', type: 'd' }]
          : [],
    );
    mockWindow.__test_queueWarning('Download 1 files');

    await handlers.get('gangway.downloadMappedFolder')!({ fsPath: localRoot });

    expect((await fs.stat(path.join(localRoot, 'empty'))).isDirectory()).toBe(true);
    expect((await fs.stat(path.join(localRoot, 'nested', 'deeper'))).isDirectory()).toBe(true);
    expect(await fs.readdir(path.join(localRoot, 'empty'))).toEqual([]);
  });

  it('downloads the mapped remote folder into the workspace tree, skipping a symlinked entry', async () => {
    const localRoot = path.join(wsRoot, 'app');
    fakeRawClient.list.mockImplementation(async (dirPath: string) =>
      dirPath === '/var/www/app'
        ? [
            { name: 'one.php', type: '-', size: 5 },
            { name: 'link.php', type: 'l', size: 3 },
          ]
        : [],
    );
    mockWindow.__test_queueWarning('Download 1 files');
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

    await handlers.get('gangway.downloadMappedFolder')!({ fsPath: localRoot });

    expect(warnSpy).toHaveBeenCalledWith(
      `Download 1 file(s) from /var/www/app → ${localRoot}? This overwrites your local files. (+1 symlinks skipped)`,
      'Download 1 files',
      'Cancel',
    );
    expect(fakeRawClient.fastGet).toHaveBeenCalledWith(
      '/var/www/app/one.php',
      `${path.join(localRoot, 'one.php')}.gangway-downloading`,
    );
    expect(await fs.readFile(path.join(localRoot, 'one.php'), 'utf8')).toBe('server content');
    // The symlink is reported, never materialized as a regular file.
    expect(fakeRawClient.fastGet).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(`Downloaded 1 file(s) into ${localRoot}. 1 symlink(s) skipped.`);
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('counts an excluded remote file in the confirm but never downloads it', async () => {
    const localRoot = path.join(wsRoot, 'app');
    fakeRawClient.list.mockImplementation(async (dirPath: string) =>
      dirPath === '/var/www/app'
        ? [
            { name: 'one.php', type: '-', size: 5 },
            { name: 'var', type: 'd' },
          ]
        : dirPath === '/var/www/app/var'
          ? [{ name: 'cache.php', type: '-', size: 9 }]
          : [],
    );
    mockWindow.__test_queueWarning('Download 1 files');
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

    await handlers.get('gangway.downloadMappedFolder')!({ fsPath: localRoot });

    expect(warnSpy).toHaveBeenCalledWith(
      `Download 1 file(s) from /var/www/app → ${localRoot}? This overwrites your local files. (+1 excluded)`,
      'Download 1 files',
      'Cancel',
    );
    expect(fakeRawClient.fastGet).toHaveBeenCalledTimes(1);
    expect(fakeRawClient.fastGet).toHaveBeenCalledWith(
      '/var/www/app/one.php',
      `${path.join(localRoot, 'one.php')}.gangway-downloading`,
    );
    expect(infoSpy).toHaveBeenCalledWith(`Downloaded 1 file(s) into ${localRoot}. 1 file(s) excluded by patterns.`);
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('downloads a remote tree folder into its mapped workspace folder', async () => {
    fakeRawClient.list.mockImplementation(async (dirPath: string) =>
      dirPath === '/var/www/app' ? [{ name: 'one.php', type: '-', size: 5 }] : [],
    );
    mockWindow.__test_queueWarning('Download 1 files');

    await handlers.get('gangway.downloadToWorkspaceFolder')!(folderNode('/var/www/app'));

    expect(fakeRawClient.fastGet).toHaveBeenCalledWith(
      '/var/www/app/one.php',
      `${path.join(wsRoot, 'app', 'one.php')}.gangway-downloading`,
    );
    expect(await fs.readFile(path.join(wsRoot, 'app', 'one.php'), 'utf8')).toBe('server content');
  });

  it('stays silent for a remote tree folder outside every mapping', async () => {
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');

    await handlers.get('gangway.downloadToWorkspaceFolder')!(folderNode('/etc'));

    expect(warnSpy).not.toHaveBeenCalled();
    expect(fakeRawClient.list).not.toHaveBeenCalled();
    expect(fakeRawClient.fastGet).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('treats a mapped remote root the server does not have yet as empty, not as a failure', async () => {
    // A fresh workspace mapping routinely points at a directory the server
    // has not created yet; the real server reports SFTP status '2'.
    await connectionManager.update(connection.id, {
      mappings: [{ localPath: wsRoot, remotePath: '/var/www/missing' }],
    });
    fakeRawClient.list.mockRejectedValue(Object.assign(new Error('No such file'), { code: '2' }));
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
    const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');

    await handlers.get('gangway.downloadMappedFolder')!({ fsPath: path.join(wsRoot, 'app') });

    expect(infoSpy).toHaveBeenCalledWith('Nothing on the server under /var/www/missing/app yet.');
    expect(fakeRawClient.fastGet).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('stops a cancelled folder upload at the stop point and reports what already landed', async () => {
    const localRoot = await makeLocalFolder('one.php', 'two.php');
    mockWindow.__test_queueWarning('Upload 2 files');
    // The mock's default token never cancels, so this test installs its own
    // and fires it from inside the first put: cancellation is honoured
    // between files, so the first file must land and the second must not.
    const listeners: Array<() => void> = [];
    const originalWithProgress = vscode.window.withProgress;
    type ProgressTask = (
      progress: { report: (value: unknown) => void },
      token: { isCancellationRequested: boolean; onCancellationRequested: (listener: () => void) => { dispose: () => void } },
    ) => Promise<unknown>;
    vscode.window.withProgress = ((_opts: never, task: ProgressTask) =>
      task(
        { report: () => {} },
        {
          isCancellationRequested: false,
          onCancellationRequested: (listener: () => void) => {
            listeners.push(listener);
            return { dispose: () => {} };
          },
        },
      )) as unknown as typeof originalWithProgress;
    fakeRawClient.fastPut.mockImplementationOnce(async () => {
      for (const listener of listeners) listener();
    });
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
    try {
      await handlers.get('gangway.uploadMappedFolder')!({ fsPath: localRoot });
    } finally {
      vscode.window.withProgress = originalWithProgress;
    }

    expect(fakeRawClient.fastPut).toHaveBeenCalledTimes(1);
    expect(fakeRawClient.posixRename).toHaveBeenCalledTimes(1);
    const summary = infoSpy.mock.calls.map((call) => String(call[0])).find((message) => message.startsWith('Cancelled'));
    expect(summary).toBe('Cancelled after uploading 1 file(s).');
    // There is no backup under pure B, so nothing may claim a rollback.
    expect(summary).not.toMatch(/rollback|restor|backup/i);
    infoSpy.mockRestore();
  });
});

/**
 * Pure-B anti-regression pins (spec §4 carve-out).
 *
 * Tasks 4–5 built the mapped commands; this block freezes the deliberate
 * *absences* that make them pure B -- no backup staging, no audit line, no
 * frozen gate on the mapped path -- plus the refusals that keep the carve-out
 * safe (an escape-root mapping, an unmapped second workspace root, a server
 * symlink, a failed download). Every pin asserts an observable effect only
 * (fakeRawClient calls, bytes on disk, prompt copy, the Output channel), so a
 * refactor that keeps the behaviour stays green while a regression that
 * reintroduces the hotfix safety net -- or drops a refusal -- fails loudly.
 * The same harness as the blocks above; the one test that needs the Output
 * channel re-activates with a spy in place, exactly like
 * `test/extension.test.ts`'s "Open Output from the error dialog" test.
 */
describe('pure-B pins (spec §4 carve-out)', () => {
  /** The connection shape `beforeEach` seeds, re-seeded by the frozen pin. */
  function seedAttrs() {
    return {
      name: 'staging',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      remotePath: '/var/www',
      authMethod: 'password' as const,
      scope: 'workspace' as const,
      mappings: [{ localPath: wsRoot, remotePath: '/var/www' }],
    };
  }

  it('pure-B pin: mapped upload writes no backup and no audit line', async () => {
    const localFile = path.join(wsRoot, 'app.php');
    await fs.writeFile(localFile, '<?php echo 1;');
    // Created up front so the readdir below is a real read of a real
    // directory: on a missing path it would resolve to [] for the wrong
    // reason and the pin would pass vacuously.
    await fs.mkdir(globalStorageDir, { recursive: true });
    mockWindow.__test_queueWarning('Upload');

    await handlers.get('gangway.uploadMappedFile')!({ fsPath: localFile });

    expect(fakeRawClient.fastPut).toHaveBeenCalledTimes(1);
    expect(fakeRawClient.fastPut).toHaveBeenCalledWith(localFile, '/var/www/app.php.tmp');
    // The only mkdir is the best-effort parent of the target: a positive
    // assertion first, so the negative one below cannot pass because nothing
    // ran at all.
    expect(fakeRawClient.mkdir).toHaveBeenCalledWith('/var/www', true);
    // No backup staging anywhere under the connection root (the hotfix path
    // creates `.gangway-backup-<slug>` through remoteOps; pure B must not).
    expect(fakeRawClient.mkdir).not.toHaveBeenCalledWith(
      expect.stringContaining('.gangway-backup-'),
      expect.anything(),
    );
    // No audit line either: AuditLog.append would mkdir globalStorageDir and
    // drop `sftp-hotfix-uploads.log` there.
    const globalStorageEntries = await fs.readdir(globalStorageDir);
    expect(globalStorageEntries.filter((name) => name.endsWith('.log'))).toEqual([]);
  });

  it('pure-B pin: frozen connection still allows mapped upload but blocks hotfix upload', async () => {
    const localFile = path.join(wsRoot, 'app.php');
    await fs.writeFile(localFile, '<?php echo 1;');
    // Flip frozen through the ConnectionManager itself -- the same mechanism
    // test/extension.test.ts's 'frozen connection guard' uses. There is no
    // setFrozen() API, and inventing one here would pin nothing real.
    const frozen = await connectionManager.add({ ...seedAttrs(), frozen: true });
    await connectionManager.setWorkspaceBinding(frozen.id);
    mockWindow.__test_queueWarning('Upload');
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

    await handlers.get('gangway.uploadMappedFile')!({ fsPath: localFile });

    // The mapped path is pure B by design: it never consults `frozen`.
    expect(fakeRawClient.fastPut).toHaveBeenCalledWith(localFile, '/var/www/app.php.tmp');
    expect(infoSpy).toHaveBeenCalledWith(`Uploaded ${localFile} → /var/www/app.php.`);

    // ...while the hotfix path on that SAME connection still refuses before
    // any network mutation. Seed the tmp mirror + sidecar a tree-node upload
    // derives its local path from (the extension.test.ts pattern), so the
    // refusal is proven to come from the frozen gate, not from a missing
    // sidecar.
    const hotfixLocalPath = tmpFilePathFor(frozen, '/var/www/app.php');
    await fs.mkdir(path.dirname(hotfixLocalPath), { recursive: true });
    await fs.writeFile(hotfixLocalPath, 'hotfix');
    await writeSidecar(hotfixLocalPath, {
      connectionId: frozen.id,
      remotePath: '/var/www/app.php',
      mtime: 1,
      size: 6,
      downloadedAt: 1,
    });
    const putsBefore = fakeRawClient.fastPut.mock.calls.length;

    await handlers.get('gangway.uploadFile')!({
      connectionId: frozen.id,
      entry: { path: '/var/www/app.php', isDirectory: false, isSymbolicLink: false, size: 1 },
    });

    expect(fakeRawClient.fastPut.mock.calls.length).toBe(putsBefore);
    expect(fakeRawClient.posixRename).toHaveBeenCalledTimes(1); // the mapped put only
    // The frozen gate precedes the conflict-guard stat, so "nothing was put"
    // is the freeze refusing, not the un-answered conflict prompt blocking a
    // transfer that had already inspected the server copy: nothing was
    // inspected at all.
    expect(fakeRawClient.stat).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('frozen'));
    infoSpy.mockRestore();
  });

  it('pure-B pin: an unmapped second workspace root offers Open Mappings', async () => {
    // Only workspaceRoots[0] gets the zero-config default, so a file in a
    // second root is unmapped until the user writes an explicit row.
    const secondRoot = path.join(tmpHome, 'other-proj');
    await fs.mkdir(secondRoot, { recursive: true });
    const unmappedFile = path.join(secondRoot, 'app.php');
    await fs.writeFile(unmappedFile, '<?php echo 1;');
    mockWorkspace.workspaceFolders = [
      { uri: { fsPath: wsRoot }, name: 'proj' },
      { uri: { fsPath: secondRoot }, name: 'other' },
    ];
    mockWindow.__test_queueWarning('Open Mappings');
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    const execSpy = vi.spyOn(vscode.commands, 'executeCommand');

    await handlers.get('gangway.uploadMappedFile')!({ fsPath: unmappedFile });

    expect(warnSpy).toHaveBeenCalledWith(
      `${unmappedFile} is not inside any path mapping of "staging" (default: ${wsRoot} → /var/www).`,
      'Open Mappings',
      'Cancel',
    );
    // The offered action must actually do something: a button that discards
    // the choice is a bug, not a TODO.
    expect(execSpy).toHaveBeenCalledWith('gangway.manageRemotes');
    expect(handlers.has('gangway.manageRemotes')).toBe(true);
    expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
    expect(fakeRawClient.mkdir).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    execSpy.mockRestore();
  });

  it('pure-B pin: an escape-root mapping refuses instead of falling back', async () => {
    const localRoot = path.join(wsRoot, 'app');
    const localFile = path.join(localRoot, 'deep.php');
    await fs.mkdir(localRoot, { recursive: true });
    await fs.writeFile(localFile, '<?php echo 1;');
    // The longer explicit row wins the longest-prefix match, and its remote
    // side resolves out of the connection root ('/var/www/../etc' normalizes
    // to '/var/etc', so the file lands at '/var/etc/deep.php'). The refusal
    // is the whole point: it must stop, never silently fall back to the
    // shorter default row ('/var/www/app/deep.php') the user did not select.
    await connectionManager.update(connection.id, {
      mappings: [{ localPath: localRoot, remotePath: '/var/www/../etc' }],
    });
    mockWindow.__test_queueWarning('Open Mappings');
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');

    await handlers.get('gangway.uploadMappedFile')!({ fsPath: localFile });

    expect(warnSpy).toHaveBeenCalledWith(
      `${localFile} is not inside any path mapping of "staging" (default: ${wsRoot} → /var/www).`,
      'Open Mappings',
      'Cancel',
    );
    expect(fakeRawClient.fastPut).not.toHaveBeenCalled();
    expect(fakeRawClient.posixRename).not.toHaveBeenCalled();
    expect(fakeRawClient.mkdir).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('pure-B pin: a skipped symlink download is reported in the Output channel', async () => {
    const createSpy = vi.spyOn(vscode.window, 'createOutputChannel');
    const fresh = activate(fakeContext());
    const freshConnection = await fresh.connectionManager.add(seedAttrs());
    await fresh.connectionManager.setWorkspaceBinding(freshConnection.id);
    const channel = createSpy.mock.results[createSpy.mock.results.length - 1].value as {
      appendLine: (line: string) => void;
      show: () => void;
    };
    const logged: string[] = [];
    const appendSpy = vi.spyOn(channel, 'appendLine').mockImplementation((line: string) => {
      logged.push(line);
    });
    const showSpy = vi.spyOn(channel, 'show');
    fakeRawClient.list.mockImplementation(async (dirPath: string) =>
      dirPath === '/var/www/app'
        ? [
            { name: 'one.php', type: '-', size: 5 },
            { name: 'link.php', type: 'l', size: 3 },
          ]
        : [],
    );
    mockWindow.__test_queueWarning('Download 1 files');
    const localRoot = path.join(wsRoot, 'app');

    await handlers.get('gangway.downloadMappedFolder')!({ fsPath: localRoot });

    // The confirm names the skip; the Output channel carries the per-entry
    // reason and is revealed, so a "1 symlink(s) skipped" count is never the
    // only trace of a file the user expected to arrive.
    expect(logged).toContain('Download skipped /var/www/app/link.php: symlink (skipped, not materialized)');
    expect(showSpy).toHaveBeenCalled();
    expect(fakeRawClient.fastGet).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(localRoot)).toEqual(['one.php']);
    appendSpy.mockRestore();
    showSpy.mockRestore();
    createSpy.mockRestore();
  });

  it('pure-B pin: a failed download leaves the workspace file byte-identical', async () => {
    const localFile = path.join(wsRoot, 'app.php');
    const stagingPath = `${localFile}.gangway-downloading`;
    await fs.writeFile(localFile, 'stale local content');
    mockWindow.__test_queueWarning('Download');
    // The real fastGet truncates its destination before writing, so a direct
    // write onto the workspace file would leave a truncated fragment here --
    // with no backup under pure B. Reproducing that truncation makes the pin
    // discriminate: drop the staging sibling in pullMappedFile and the
    // byte-identity assertion below fails instead of passing vacuously.
    fakeRawClient.fastGet.mockImplementationOnce(async (_remotePath: string, destination: string) => {
      await fs.writeFile(destination, '');
      throw new Error('connection lost');
    });
    const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');

    await handlers.get('gangway.downloadMappedFile')!({ fsPath: localFile });

    // The claim first: the previous bytes survived a failed overwrite...
    expect(await fs.readFile(localFile, 'utf8')).toBe('stale local content');
    // ...because the transfer staged into the sibling, never onto the
    // workspace file...
    expect(fakeRawClient.fastGet).toHaveBeenCalledWith('/var/www/app.php', stagingPath);
    // ...and the half-written staging file was cleaned up, not left as litter.
    await expect(fs.access(stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(wsRoot)).toEqual(['app.php']);
    expect(fakeRawClient.posixRename).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
