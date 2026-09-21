import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// The mock module imported relatively: at runtime vitest aliases bare
// 'vscode' to this same file, so this is the identical module instance the
// code under test uses — but only the relative import carries the
// test-only __test_* queue helpers in tsc (which typechecks bare 'vscode'
// against the real @types/vscode, like every other test file).
import { window as mockWindow } from './mocks/vscode';
import { tmpFilePathFor } from '../src/tmpPath';
import {
  assertInsideRoot,
  assertMutatingAllowed,
  chmodRemote,
  collectDropUploads,
  createRemote,
  duplicateRemote,
  FrozenError,
  guardUploadTarget,
  parseUriList,
  pasteEntries,
  renameRemote,
  typedConfirmMatches,
  WrongServerError,
} from '../src/remoteOps';
import { AuditLog } from '../src/auditLog';
import { readSidecar, writeSidecar } from '../src/tmpStore';
import type { ConnectionConfig } from '../src/types';

const connection: ConnectionConfig = {
  id: 'c1',
  name: 'p',
  host: 'h',
  port: 22,
  username: 'u',
  remotePath: '/srv/app',
  authMethod: 'agent',
};

const frozenConnection: ConnectionConfig = { ...connection, frozen: true };

function fakeAuditLog() {
  return { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;
}

describe('remoteOps paths', () => {
  it('refuses paths outside the root', () => {
    expect(() => assertInsideRoot(connection, '/srv/other/x.php')).toThrow(/outside/);
  });

  it('blocks every mutating op while frozen', () => {
    expect(() => assertMutatingAllowed(frozenConnection)).toThrow(FrozenError);
    expect(() => assertMutatingAllowed(frozenConnection)).toThrow(/Toggle Freeze/);
    expect(() => assertMutatingAllowed(connection)).not.toThrow();
  });

  it('guards upload targets wrong-server-first, frozen-second', () => {
    const sidecarA = { connectionId: 'c1', remotePath: '/srv/app/a.php', mtime: 1, size: 1, downloadedAt: 1 };
    const sidecarB = { ...sidecarA, connectionId: 'c2' };
    expect(() => guardUploadTarget(connection, sidecarB)).toThrow(WrongServerError);
    expect(() => guardUploadTarget(frozenConnection, sidecarA)).toThrow(FrozenError);
    expect(() => guardUploadTarget(connection, sidecarA)).not.toThrow();
    expect(() => guardUploadTarget(connection, undefined)).not.toThrow();
  });
});

describe('vscode mock answer queues', () => {
  it('drives showInputBox from a FIFO queue, empty queue means dismissed', async () => {
    mockWindow.__test_queueInput('myname');
    mockWindow.__test_queueInput(undefined);
    await expect(mockWindow.showInputBox({})).resolves.toBe('myname');
    await expect(mockWindow.showInputBox({})).resolves.toBeUndefined();
    await expect(mockWindow.showInputBox({})).resolves.toBeUndefined();
    mockWindow.__test_resetAnswers();
  });
});

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}

function fakeOpsClient(overrides: Record<string, unknown> = {}) {
  return {
    mkdir: vi.fn().mockResolvedValue(undefined),
    posixRename: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    rmdir: vi.fn().mockResolvedValue(undefined),
    fastGet: vi.fn().mockResolvedValue(undefined),
    fastPut: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ mtime: 1, size: 1, isDirectory: false, isSymbolicLink: false }),
    chmod: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('typedConfirmMatches', () => {
  it('is exact and case-sensitive, dismissed means no', () => {
    expect(typedConfirmMatches('EMPTY TRASH', 'EMPTY TRASH')).toBe(true);
    expect(typedConfirmMatches('EMPTY TRASH', 'empty trash')).toBe(false);
    expect(typedConfirmMatches('EMPTY TRASH', undefined)).toBe(false);
    expect(typedConfirmMatches('mydir', 'mydir ')).toBe(false);
  });
});

describe('renameRemote', () => {
  it('refuses symlink destination parents without touching the server', async () => {
    const client = fakeOpsClient({
      stat: vi.fn().mockImplementation(async (p: string) => {
        if (p === '/srv/app') return { mtime: 1, size: 0, isDirectory: true, isSymbolicLink: true };
        return { mtime: 1, size: 1, isDirectory: false, isSymbolicLink: false };
      }),
    });
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;
    await expect(renameRemote(client as never, connection, '/srv/app/a.php', 'b.php', auditLog)).rejects.toThrow(
      /symlink/,
    );
    expect(client.posixRename).not.toHaveBeenCalled();
  });

  it('remaps nested sidecars when a folder is renamed', async () => {
    const client = fakeOpsClient({
      stat: vi.fn().mockImplementation(async (p: string) => {
        if (p === '/srv/app/dir') return { mtime: 1, size: 0, isDirectory: true, isSymbolicLink: false };
        if (p === '/srv/app/renamed') throw enoent();
        return { mtime: 1, size: 1, isDirectory: false, isSymbolicLink: false };
      }),
    });
    // Local tmp mirror with sidecars under the old folder name.
    const oldFile = tmpFilePathFor(connection, '/srv/app/dir/inner.php');
    await fs.mkdir(path.dirname(oldFile), { recursive: true });
    await fs.writeFile(oldFile, 'x');
    await writeSidecar(oldFile, {
      connectionId: 'c1',
      remotePath: '/srv/app/dir/inner.php',
      mtime: 1,
      size: 1,
      downloadedAt: 1,
    });
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;
    try {
      const { newPath } = await renameRemote(client as never, connection, '/srv/app/dir', 'renamed', auditLog);
      expect(newPath).toBe('/srv/app/renamed');
      const newFile = tmpFilePathFor(connection, '/srv/app/renamed/inner.php');
      expect(await readSidecar(newFile)).toMatchObject({ remotePath: '/srv/app/renamed/inner.php' });
      expect(await readSidecar(oldFile)).toBeUndefined();
      expect(auditLog.append).toHaveBeenCalledWith(expect.objectContaining({ op: 'rename' }));
    } finally {
      await fs.rm(tmpFilePathFor(connection, '/srv/app/renamed').split(path.sep).slice(0, -1).join(path.sep), {
        recursive: true,
        force: true,
      }).catch(() => {});
    }
  });
});

describe('duplicateRemote', () => {
  it('never overwrites: a clashing copy name gets a numeric suffix', async () => {
    const client = fakeOpsClient({
      stat: vi.fn().mockImplementation(async (p: string) => {
        if (p === '/srv/app/a copy.php') return { mtime: 1, size: 1, isDirectory: false, isSymbolicLink: false };
        if (p === '/srv/app/a copy-2.php') throw enoent();
        return { mtime: 1, size: 1, isDirectory: false, isSymbolicLink: false };
      }),
      fastGet: vi.fn().mockImplementation(async (_r: string, l: string) => {
        await fs.mkdir(path.dirname(l), { recursive: true });
        await fs.writeFile(l, 'orig');
      }),
    });
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;
    const { path: dupPath } = await duplicateRemote(client as never, connection, '/srv/app/a.php', auditLog);
    expect(dupPath).toBe('/srv/app/a copy-2.php');
    expect(auditLog.append).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'duplicate', remotePath: '/srv/app/a copy-2.php' }),
    );
  });
});

describe('createRemote and chmodRemote validation', () => {
  it('rejects illegal names without touching the server', async () => {
    const client = fakeOpsClient();
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;
    await expect(createRemote(client as never, connection, '/srv/app', '../evil', 'file', auditLog)).rejects.toThrow();
    expect(client.mkdir).not.toHaveBeenCalled();
    expect(client.fastPut).not.toHaveBeenCalled();
  });

  it('rejects non-octal chmod modes without touching the server', async () => {
    const client = fakeOpsClient();
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;
    await expect(chmodRemote(client as never, connection, '/srv/app/a.php', '888', auditLog)).rejects.toThrow(
      /octal/,
    );
    expect(client.chmod).not.toHaveBeenCalled();
  });
});

describe('drop helpers', () => {
  it('parseUriList decodes file URIs and skips the rest', () => {
    expect(parseUriList('file:///tmp/a.php\nfile:///tmp/with%20space.js\nhttps://x/y\n')).toEqual([
      '/tmp/a.php',
      '/tmp/with space.js',
    ]);
    expect(parseUriList('')).toEqual([]);
  });

  it('collectDropUploads flags large and binary files, throws on missing ones', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-test-'));
    const small = path.join(dir, 'a.php');
    const binary = path.join(dir, 'b.bin');
    await fs.writeFile(small, '<?php echo 1;');
    await fs.writeFile(binary, Buffer.from([0, 1, 2, 3, 0, 255, 254]));
    try {
      const collected = await collectDropUploads([small, binary]);
      expect(collected.find((c) => c.localPath === small)!.needsPrompt).toBe(false);
      expect(collected.find((c) => c.localPath === binary)!.needsPrompt).toBe(true);
      await expect(collectDropUploads([path.join(dir, 'nope.php')])).rejects.toThrow(/does not exist/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('pasteEntries', () => {
  it('refuses cross-connection entries', async () => {
    const clipboard = { connectionId: 'other', paths: ['/srv/app/a.php'], cut: false };
    const deps = {
      confirmOverwrite: vi.fn(),
      auditLog: { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog,
    };
    await expect(
      pasteEntries(fakeOpsClient() as never, connection, clipboard, '/srv/app', deps),
    ).rejects.toThrow(/different connection/);
  });

  it('copies a new file via staging and audits op duplicate', async () => {
    const puts: string[] = [];
    const client = fakeOpsClient({
      stat: vi.fn().mockImplementation(async (p: string) => {
        if (p === '/srv/app' || p === '/srv/app/dest') {
          return { mtime: 1, size: 0, isDirectory: true, isSymbolicLink: false };
        }
        if (p === '/srv/app/a.php') return { mtime: 1, size: 3, isDirectory: false, isSymbolicLink: false };
        throw enoent();
      }),
      fastGet: vi.fn().mockImplementation(async (_r: string, l: string) => {
        await fs.mkdir(path.dirname(l), { recursive: true });
        await fs.writeFile(l, 'src');
      }),
      fastPut: vi.fn().mockImplementation(async (l: string, r: string) => {
        puts.push(`${l}->${r}`);
      }),
    });
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;
    const deps = { confirmOverwrite: vi.fn(), auditLog };
    const clipboard = { connectionId: 'c1', paths: ['/srv/app/a.php'], cut: false };
    const result = await pasteEntries(client as never, connection, clipboard, '/srv/app/dest', deps);
    expect(result.pasted).toEqual(['/srv/app/dest/a.php']);
    expect(puts[0]).toMatch(/->\/srv\/app\/dest\/a\.php$/);
    expect(auditLog.append).toHaveBeenCalledWith(expect.objectContaining({ op: 'duplicate' }));
    expect(deps.confirmOverwrite).not.toHaveBeenCalled();
  });

  it('refuses symlink destination parents', async () => {
    const client = fakeOpsClient({
      stat: vi.fn().mockImplementation(async (p: string) => {
        if (p === '/srv/app/dest') return { mtime: 1, size: 0, isDirectory: true, isSymbolicLink: true };
        return { mtime: 1, size: 3, isDirectory: false, isSymbolicLink: false };
      }),
    });
    const deps = {
      confirmOverwrite: vi.fn(),
      auditLog: { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog,
    };
    const clipboard = { connectionId: 'c1', paths: ['/srv/app/a.php'], cut: false };
    await expect(pasteEntries(client as never, connection, clipboard, '/srv/app/dest', deps)).rejects.toThrow(
      /symlink/,
    );
  });
});

describe('isNotFoundError', () => {
  it('accepts node ENOENT, numeric SFTP codes, and no-such-file text', async () => {
    const { isNotFoundError } = await import('../src/remoteOps');
    expect(isNotFoundError(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))).toBe(true);
    expect(isNotFoundError(Object.assign(new Error('list: No such file /x'), { code: '2' }))).toBe(true);
    expect(isNotFoundError(new Error('list: No such file /x'))).toBe(true);
    expect(isNotFoundError(Object.assign(new Error('Permission denied'), { code: '3' }))).toBe(false);
    expect(isNotFoundError(new Error('boom'))).toBe(false);
  });
});
