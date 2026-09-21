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
