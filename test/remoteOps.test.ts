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
  assertWritableTarget,
  chmodRemote,
  chooseDeleteMode,
  collectDropUploads,
  createRemote,
  duplicateRemote,
  FrozenError,
  guardUploadTarget,
  isLexicallyInside,
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

  it('isLexicallyInside accepts the root and descendants, rejects escapes and siblings', () => {
    expect(isLexicallyInside('/srv/app', '/srv/app')).toBe(true);
    expect(isLexicallyInside('/srv/app', '/srv/app/a/b.php')).toBe(true);
    expect(isLexicallyInside('/srv/app', '/srv/app/../other')).toBe(false);
    expect(isLexicallyInside('/srv/app', '/srv/application/x')).toBe(false);
    expect(isLexicallyInside('/srv/app', '/srv')).toBe(false);
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
    // Plain defaults: no path is a link and every path is its own real path.
    lstat: vi.fn().mockResolvedValue({ mtime: 1, size: 1, isDirectory: false, isSymbolicLink: false }),
    realPath: vi.fn().mockImplementation(async (p: string) => p),
    chmod: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

/** realPath that rewrites any path at or below a link key to its target. */
function realPathThrough(links: Record<string, string>) {
  return vi.fn().mockImplementation(async (p: string) => {
    for (const [link, target] of Object.entries(links)) {
      if (p === link) return target;
      if (p.startsWith(`${link}/`)) return target + p.slice(link.length);
    }
    return p;
  });
}

const dirStat = { mtime: 1, size: 0, isDirectory: true, isSymbolicLink: false };
const fileStat = { mtime: 1, size: 3, isDirectory: false, isSymbolicLink: false };
const linkLstat = { mtime: 1, size: 0, isDirectory: false, isSymbolicLink: true };

describe('typedConfirmMatches', () => {
  it('is exact and case-sensitive, dismissed means no', () => {
    expect(typedConfirmMatches('EMPTY TRASH', 'EMPTY TRASH')).toBe(true);
    expect(typedConfirmMatches('EMPTY TRASH', 'empty trash')).toBe(false);
    expect(typedConfirmMatches('EMPTY TRASH', undefined)).toBe(false);
    expect(typedConfirmMatches('mydir', 'mydir ')).toBe(false);
  });
});

describe('renameRemote', () => {
  it('refuses a parent that really lives outside the root when nothing confirms it', async () => {
    const client = fakeOpsClient({
      realPath: realPathThrough({ '/srv/app/ext': '/etc/ext' }),
      stat: vi.fn().mockImplementation(async (p: string) => {
        if (p === '/srv/app/ext/b.php' || p === '/etc/ext/b.php') throw enoent();
        return fileStat;
      }),
    });
    const auditLog = fakeAuditLog();
    await expect(renameRemote(client as never, connection, '/srv/app/ext/a.php', 'b.php', auditLog)).rejects.toThrow(
      /outside/,
    );
    expect(client.posixRename).not.toHaveBeenCalled();
  });

  it('rename inside a symlinked parent uses the resolved parent', async () => {
    const client = fakeOpsClient({
      realPath: realPathThrough({ '/srv/app/link': '/srv/app/real' }),
      // The library stat follows links, so it never reports the parent as one.
      stat: vi.fn().mockImplementation(async (p: string) => {
        if (p === '/srv/app/link' || p === '/srv/app/real') return dirStat;
        if (p.endsWith('/b.php')) throw enoent();
        return fileStat;
      }),
    });
    const auditLog = fakeAuditLog();
    const { newPath } = await renameRemote(client as never, connection, '/srv/app/link/a.php', 'b.php', auditLog);
    expect(newPath).toBe('/srv/app/link/b.php');
    expect(client.posixRename).toHaveBeenCalledWith('/srv/app/real/a.php', '/srv/app/real/b.php');
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

  it('duplicate of a file link writes a regular copy of the target content', async () => {
    const staged: string[] = [];
    const client = fakeOpsClient({
      realPath: realPathThrough({ '/srv/app/link.php': '/srv/app/real.php' }),
      lstat: vi.fn().mockImplementation(async (p: string) => (p === '/srv/app/link.php' ? linkLstat : fileStat)),
      stat: vi.fn().mockImplementation(async (p: string) => {
        if (p === '/srv/app') return dirStat;
        if (p.includes(' copy')) throw enoent();
        return fileStat;
      }),
      fastGet: vi.fn().mockImplementation(async (_r: string, l: string) => {
        await fs.mkdir(path.dirname(l), { recursive: true });
        await fs.writeFile(l, 'target content');
      }),
      fastPut: vi.fn().mockImplementation(async (l: string) => {
        staged.push(await fs.readFile(l, 'utf8'));
      }),
    });
    const { path: dupPath } = await duplicateRemote(client as never, connection, '/srv/app/link.php', fakeAuditLog());
    expect(dupPath).toBe('/srv/app/link copy.php');
    expect(client.fastPut).toHaveBeenCalledWith(expect.any(String), '/srv/app/link copy.php');
    expect(staged).toEqual(['target content']);
  });

  it('duplicate of a dir link is refused', async () => {
    const client = fakeOpsClient({
      realPath: realPathThrough({ '/srv/app/shared': '/srv/app/real' }),
      lstat: vi.fn().mockImplementation(async (p: string) => (p === '/srv/app/shared' ? linkLstat : dirStat)),
      stat: vi.fn().mockResolvedValue(dirStat),
    });
    await expect(duplicateRemote(client as never, connection, '/srv/app/shared', fakeAuditLog())).rejects.toThrow(
      /link to a folder/,
    );
    expect(client.fastGet).not.toHaveBeenCalled();
    expect(client.fastPut).not.toHaveBeenCalled();
  });

  it('asks before duplicating into a directory that really lives outside the root', async () => {
    const client = fakeOpsClient({
      realPath: realPathThrough({ '/srv/app/ext': '/etc/ext' }),
      stat: vi.fn().mockImplementation(async (p: string) => {
        if (p.includes(' copy')) throw enoent();
        return fileStat;
      }),
      fastGet: vi.fn().mockImplementation(async (_r: string, l: string) => {
        await fs.mkdir(path.dirname(l), { recursive: true });
        await fs.writeFile(l, 'src');
      }),
    });
    await expect(duplicateRemote(client as never, connection, '/srv/app/ext/a.php', fakeAuditLog())).rejects.toThrow(
      /outside/,
    );
    expect(client.fastPut).not.toHaveBeenCalled();
    const confirmOutsideRoot = vi.fn().mockResolvedValue(true);
    const { path: dupPath } = await duplicateRemote(client as never, connection, '/srv/app/ext/a.php', fakeAuditLog(), {
      confirmOutsideRoot,
    });
    expect(confirmOutsideRoot).toHaveBeenCalledTimes(1);
    expect(confirmOutsideRoot).toHaveBeenCalledWith('/etc/ext');
    expect(dupPath).toBe('/srv/app/ext/a copy.php');
    expect(client.fastPut).toHaveBeenCalledWith(expect.any(String), '/etc/ext/a copy.php');
  });
});

describe('chooseDeleteMode', () => {
  it('chooseDeleteMode returns link for a dir link and a file link', () => {
    expect(chooseDeleteMode({ isDirectory: true, isSymbolicLink: true })).toBe('link');
    expect(chooseDeleteMode({ isDirectory: false, isSymbolicLink: true })).toBe('link');
    expect(chooseDeleteMode({ isDirectory: true, isSymbolicLink: false })).toBe('folder');
    expect(chooseDeleteMode({ isDirectory: false, isSymbolicLink: false })).toBe('file');
  });
});

describe('assertWritableTarget', () => {
  const outsideClient = () => fakeOpsClient({ realPath: realPathThrough({ '/srv/app/ext': '/etc/ext' }) });

  it('allows an in-root target without asking', async () => {
    const confirmOutsideRoot = vi.fn();
    const target = await assertWritableTarget(fakeOpsClient() as never, connection, '/srv/app/dir', {
      confirmOutsideRoot,
    });
    expect(target.realPath).toBe('/srv/app/dir');
    expect(confirmOutsideRoot).not.toHaveBeenCalled();
  });

  it('fails closed on an out-of-root target with no confirm callback', async () => {
    await expect(assertWritableTarget(outsideClient() as never, connection, '/srv/app/ext', {})).rejects.toThrow(
      /outside/,
    );
  });

  it('throws when the user declines the confirmation', async () => {
    await expect(
      assertWritableTarget(outsideClient() as never, connection, '/srv/app/ext', {
        confirmOutsideRoot: vi.fn().mockResolvedValue(false),
      }),
    ).rejects.toThrow(/outside/);
  });

  it('blocks a frozen connection before resolving anything', async () => {
    const client = outsideClient();
    const confirmOutsideRoot = vi.fn().mockResolvedValue(true);
    await expect(
      assertWritableTarget(client as never, frozenConnection, '/srv/app/ext', { confirmOutsideRoot }),
    ).rejects.toThrow(/frozen/);
    expect(confirmOutsideRoot).not.toHaveBeenCalled();
    expect(client.realPath).not.toHaveBeenCalled();
  });
});

describe('createRemote through links', () => {
  const linkedClient = () =>
    fakeOpsClient({
      realPath: realPathThrough({ '/srv/app/ext': '/etc/ext' }),
      stat: vi.fn().mockImplementation(async (p: string) => {
        if (p.endsWith('/new')) throw enoent();
        return dirStat;
      }),
    });

  it('createRemote under an out-of-root dir link is refused without confirm', async () => {
    const client = linkedClient();
    await expect(createRemote(client as never, connection, '/srv/app/ext', 'new', 'dir', fakeAuditLog())).rejects.toThrow(
      /outside/,
    );
    expect(client.mkdir).not.toHaveBeenCalled();
    expect(client.fastPut).not.toHaveBeenCalled();
  });

  it('same with confirm true proceeds and writes to the resolved directory', async () => {
    const client = linkedClient();
    const confirmOutsideRoot = vi.fn().mockResolvedValue(true);
    const { path: created } = await createRemote(client as never, connection, '/srv/app/ext', 'new', 'dir', fakeAuditLog(), {
      confirmOutsideRoot,
    });
    expect(confirmOutsideRoot).toHaveBeenCalledWith('/etc/ext');
    expect(client.mkdir).toHaveBeenCalledWith('/etc/ext/new', false);
    expect(created).toBe('/srv/app/ext/new');
  });

  it('frozen connection blocks even with confirm', async () => {
    const client = linkedClient();
    const confirmOutsideRoot = vi.fn().mockResolvedValue(true);
    await expect(
      createRemote(client as never, frozenConnection, '/srv/app/ext', 'new', 'dir', fakeAuditLog(), { confirmOutsideRoot }),
    ).rejects.toThrow(/frozen/);
    expect(confirmOutsideRoot).not.toHaveBeenCalled();
    expect(client.mkdir).not.toHaveBeenCalled();
  });
});

describe('chmodRemote through links', () => {
  it('changes the mode of the real target and asks for an out-of-root one', async () => {
    const client = fakeOpsClient({ realPath: realPathThrough({ '/srv/app/conf.php': '/etc/conf.php' }) });
    await expect(chmodRemote(client as never, connection, '/srv/app/conf.php', '644', fakeAuditLog())).rejects.toThrow(
      /outside/,
    );
    expect(client.chmod).not.toHaveBeenCalled();
    const confirmOutsideRoot = vi.fn().mockResolvedValue(true);
    await chmodRemote(client as never, connection, '/srv/app/conf.php', '644', fakeAuditLog(), { confirmOutsideRoot });
    expect(confirmOutsideRoot).toHaveBeenCalledWith('/etc/conf.php');
    expect(client.chmod).toHaveBeenCalledWith('/etc/conf.php', '644');
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

  function outsideLinkClient(puts: string[]) {
    return fakeOpsClient({
      realPath: realPathThrough({ '/srv/app/ext': '/etc/ext' }),
      stat: vi.fn().mockImplementation(async (p: string) => {
        if (p === '/srv/app/ext' || p === '/etc/ext') return dirStat;
        if (p === '/srv/app/a.php' || p === '/srv/app/b.php') return fileStat;
        throw enoent();
      }),
      lstat: vi.fn().mockImplementation(async (p: string) => {
        if (p === '/srv/app/a.php' || p === '/srv/app/b.php') return fileStat;
        throw enoent();
      }),
      fastGet: vi.fn().mockImplementation(async (_r: string, l: string) => {
        await fs.mkdir(path.dirname(l), { recursive: true });
        await fs.writeFile(l, 'src');
      }),
      fastPut: vi.fn().mockImplementation(async (_l: string, r: string) => {
        puts.push(r);
      }),
    });
  }

  it('refuses to paste into an out-of-root dir link when nothing confirms it', async () => {
    const puts: string[] = [];
    const client = outsideLinkClient(puts);
    const deps = { confirmOverwrite: vi.fn(), auditLog: fakeAuditLog() };
    const clipboard = { connectionId: 'c1', paths: ['/srv/app/a.php'], cut: false };
    await expect(pasteEntries(client as never, connection, clipboard, '/srv/app/ext', deps)).rejects.toThrow(
      /outside/,
    );
    expect(puts).toEqual([]);
  });

  it('paste into an out-of-root dir link asks once per operation', async () => {
    const puts: string[] = [];
    const client = outsideLinkClient(puts);
    const deps = { confirmOverwrite: vi.fn(), auditLog: fakeAuditLog() };
    const clipboard = { connectionId: 'c1', paths: ['/srv/app/a.php', '/srv/app/b.php'], cut: false };
    const confirmOutsideRoot = vi.fn().mockResolvedValue(true);
    const result = await pasteEntries(client as never, connection, clipboard, '/srv/app/ext', deps, {
      confirmOutsideRoot,
    });
    expect(confirmOutsideRoot).toHaveBeenCalledTimes(1);
    expect(confirmOutsideRoot).toHaveBeenCalledWith('/etc/ext');
    expect(puts).toEqual(['/etc/ext/a.php', '/etc/ext/b.php']);
    expect(result.skipped).toEqual([]);
  });

  it('paste into a frozen connection is blocked even with confirm', async () => {
    const puts: string[] = [];
    const client = outsideLinkClient(puts);
    const deps = { confirmOverwrite: vi.fn(), auditLog: fakeAuditLog() };
    const clipboard = { connectionId: 'c1', paths: ['/srv/app/a.php'], cut: true };
    const confirmOutsideRoot = vi.fn().mockResolvedValue(true);
    await expect(
      pasteEntries(client as never, frozenConnection, clipboard, '/srv/app/ext', deps, { confirmOutsideRoot }),
    ).rejects.toThrow(/frozen/);
    expect(confirmOutsideRoot).not.toHaveBeenCalled();
    expect(client.posixRename).not.toHaveBeenCalled();
  });

  /**
   * The library stat follows links, so a destination that is itself a link
   * looks like a plain file to stat; only lstat tells the truth.
   */
  function destLinkClient() {
    return fakeOpsClient({
      stat: vi.fn().mockImplementation(async (p: string) => {
        if (p === '/srv/app/dest') return dirStat;
        return fileStat;
      }),
      lstat: vi.fn().mockImplementation(async (p: string) => (p === '/srv/app/dest/a.php' ? linkLstat : fileStat)),
      fastGet: vi.fn().mockImplementation(async (_r: string, l: string) => {
        await fs.mkdir(path.dirname(l), { recursive: true });
        await fs.writeFile(l, 'src');
      }),
    });
  }

  it.each([
    ['copy', false],
    ['cut', true],
  ])('link detection uses lstat: a %s paste onto a destination that is a link is refused', async (_label, cut) => {
    const client = destLinkClient();
    const deps = { confirmOverwrite: vi.fn().mockResolvedValue('overwrite'), auditLog: fakeAuditLog() };
    const clipboard = { connectionId: 'c1', paths: ['/srv/app/a.php'], cut };
    const result = await pasteEntries(client as never, connection, clipboard, '/srv/app/dest', deps);
    expect(result.pasted).toEqual([]);
    expect(result.skipped).toEqual([{ path: '/srv/app/a.php', reason: expect.stringMatching(/symlink/) }]);
    expect(client.posixRename).not.toHaveBeenCalled();
    expect(client.fastPut).not.toHaveBeenCalled();
    expect(deps.confirmOverwrite).not.toHaveBeenCalled();
  });

  it('link detection uses lstat: a source that is a link is skipped', async () => {
    const client = fakeOpsClient({
      stat: vi.fn().mockImplementation(async (p: string) => {
        if (p === '/srv/app/dest') return dirStat;
        if (p === '/srv/app/link.php') return fileStat;
        throw enoent();
      }),
      lstat: vi.fn().mockImplementation(async (p: string) => {
        if (p === '/srv/app/link.php') return linkLstat;
        throw enoent();
      }),
    });
    const deps = { confirmOverwrite: vi.fn(), auditLog: fakeAuditLog() };
    const clipboard = { connectionId: 'c1', paths: ['/srv/app/link.php'], cut: true };
    const result = await pasteEntries(client as never, connection, clipboard, '/srv/app/dest', deps);
    expect(result.skipped).toEqual([{ path: '/srv/app/link.php', reason: 'is a symlink' }]);
    expect(client.posixRename).not.toHaveBeenCalled();
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
