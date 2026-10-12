import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { moveByDrop, planDropMove, type DropMoveDeps } from '../src/dropMove';
import { FrozenError } from '../src/remoteOps';
import { TransferCancelledError } from '../src/folderQueue';
import type { AuditLog } from '../src/auditLog';
import type { ConnectionConfig } from '../src/types';

const connection: ConnectionConfig = {
  id: 'c1',
  name: 'staging',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  remotePath: '/srv/app',
  authMethod: 'password',
};

const plain = { mtime: 1, size: 1, isDirectory: false, isSymbolicLink: false };
const asLink = { ...plain, isSymbolicLink: true };

/** Every path is its own real path unless `real` rewrites it; `links` lists link entries. */
function client(real: Record<string, string> = {}, links: string[] = []) {
  return {
    lstat: vi.fn().mockImplementation(async (p: string) => (links.includes(p) ? asLink : plain)),
    realPath: vi.fn().mockImplementation(async (p: string) => {
      for (const [from, to] of Object.entries(real)) {
        if (p === from) return to;
        if (p.startsWith(`${from}/`)) return to + p.slice(from.length);
      }
      return p;
    }),
  };
}

describe('planDropMove', () => {
  it('returns empty arrays for no sources', async () => {
    expect(await planDropMove(client() as never, connection, [], '/srv/app/dest')).toEqual({ movable: [], skipped: [] });
  });

  it('keeps a plain source that moves to another folder', async () => {
    const plan = await planDropMove(client() as never, connection, ['/srv/app/a.php'], '/srv/app/dest');
    expect(plan).toEqual({ movable: ['/srv/app/a.php'], skipped: [] });
  });

  it('silently drops a source already in the destination folder', async () => {
    const plan = await planDropMove(client() as never, connection, ['/srv/app/dest/a.php', '/srv/app/b.php'], '/srv/app/dest');
    expect(plan).toEqual({ movable: ['/srv/app/b.php'], skipped: [] });
  });

  it('refuses a folder dropped on itself', async () => {
    const plan = await planDropMove(client() as never, connection, ['/srv/app/dir'], '/srv/app/dir');
    expect(plan.movable).toEqual([]);
    expect(plan.skipped).toEqual([{ path: '/srv/app/dir', reason: 'cannot move a folder into itself' }]);
  });

  it('refuses a folder dropped on one of its own descendants', async () => {
    const plan = await planDropMove(client() as never, connection, ['/srv/app/dir'], '/srv/app/dir/sub/deeper');
    expect(plan.movable).toEqual([]);
    expect(plan.skipped[0]).toMatchObject({ path: '/srv/app/dir', reason: 'cannot move a folder into itself' });
  });

  it('does not treat a sibling that shares a name prefix as an ancestor', async () => {
    const plan = await planDropMove(client() as never, connection, ['/srv/app/a/b'], '/srv/app/a/bc');
    expect(plan).toEqual({ movable: ['/srv/app/a/b'], skipped: [] });
  });

  it('refuses a destination that really lies inside the source through a link', async () => {
    const c = client({ '/srv/app/shortcut': '/srv/app/dir/sub' });
    const plan = await planDropMove(c as never, connection, ['/srv/app/dir'], '/srv/app/shortcut');
    expect(plan.movable).toEqual([]);
    expect(plan.skipped[0]).toMatchObject({ path: '/srv/app/dir', reason: 'cannot move a folder into itself' });
  });

  it('treats a drop onto a link to the current parent as a no-op', async () => {
    const c = client({ '/srv/app/here': '/srv/app/dir' });
    const plan = await planDropMove(c as never, connection, ['/srv/app/dir/a.php'], '/srv/app/here');
    expect(plan).toEqual({ movable: [], skipped: [] });
  });

  it('leaves a link source to pasteEntries, which skips it with its own reason', async () => {
    const c = client({ '/srv/app/ln': '/srv/app/dir/sub' }, ['/srv/app/ln']);
    const plan = await planDropMove(c as never, connection, ['/srv/app/ln'], '/srv/app/dir');
    expect(plan).toEqual({ movable: ['/srv/app/ln'], skipped: [] });
  });

  it('falls back to the lexical result when realPath fails', async () => {
    const c = {
      lstat: vi.fn().mockResolvedValue(plain),
      realPath: vi.fn().mockRejectedValue(new Error('realpath unsupported')),
    };
    const plan = await planDropMove(c as never, connection, ['/srv/app/dir', '/srv/app/b.php'], '/srv/app/dir/sub');
    expect(plan.movable).toEqual(['/srv/app/b.php']);
    expect(plan.skipped).toHaveLength(1);
  });
});

const dirEntry = { ...plain, size: 0, isDirectory: true };
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

/**
 * A fake server: `files` are plain files, `dirs` are folders, `links` are links.
 * Everything else is missing. Every path is its own real path.
 */
function server(opts: { files?: string[]; dirs?: string[]; links?: string[]; real?: Record<string, string> } = {}) {
  const files = new Set(opts.files ?? []);
  const dirs = new Set(opts.dirs ?? []);
  const links = new Set(opts.links ?? []);
  const kind = (p: string) => (links.has(p) ? asLink : dirs.has(p) ? dirEntry : files.has(p) ? plain : undefined);
  return {
    stat: vi.fn().mockImplementation(async (p: string) => {
      const found = kind(p);
      if (!found) throw enoent();
      return { ...found, isSymbolicLink: false };
    }),
    lstat: vi.fn().mockImplementation(async (p: string) => {
      const found = kind(p);
      if (!found) throw enoent();
      return found;
    }),
    realPath: vi.fn().mockImplementation(async (p: string) => {
      for (const [from, to] of Object.entries(opts.real ?? {})) {
        if (p === from) return to;
        if (p.startsWith(`${from}/`)) return to + p.slice(from.length);
      }
      return p;
    }),
    posixRename: vi.fn().mockResolvedValue(undefined),
    fastGet: vi.fn().mockImplementation(async (_r: string, l: string) => {
      await fs.mkdir(path.dirname(l), { recursive: true });
      await fs.writeFile(l, 'server');
    }),
    fastPut: vi.fn().mockResolvedValue(undefined),
  };
}

function deps(choice: 'review' | 'skip' | 'cancel' = 'review', decision: 'overwrite' | 'keepServer' | 'cancel' = 'overwrite') {
  return {
    confirmOverwrite: vi.fn().mockResolvedValue(decision),
    chooseConflictPolicy: vi.fn().mockResolvedValue(choice),
    auditLog: { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog,
  } satisfies DropMoveDeps;
}

describe('moveByDrop', () => {
  const base = { dirs: ['/srv/app', '/srv/app/dest'] };

  it('moves every source and never asks about conflicts when there are none', async () => {
    const c = server({ ...base, files: ['/srv/app/a.php', '/srv/app/b.php'] });
    const d = deps();
    const result = await moveByDrop(c as never, connection, ['/srv/app/a.php', '/srv/app/b.php'], '/srv/app/dest', d);
    expect(result.pasted).toEqual(['/srv/app/dest/a.php', '/srv/app/dest/b.php']);
    expect(c.posixRename).toHaveBeenCalledTimes(2);
    expect(d.chooseConflictPolicy).not.toHaveBeenCalled();
    expect(d.confirmOverwrite).not.toHaveBeenCalled();
  });

  it('sends a single conflict to the per-file overwrite flow, not the batch prompt', async () => {
    const c = server({ ...base, files: ['/srv/app/a.php', '/srv/app/dest/a.php'] });
    const d = deps('review', 'keepServer');
    const result = await moveByDrop(c as never, connection, ['/srv/app/a.php'], '/srv/app/dest', d);
    expect(d.chooseConflictPolicy).not.toHaveBeenCalled();
    expect(d.confirmOverwrite).toHaveBeenCalledTimes(1);
    expect(result.pasted).toEqual([]);
    expect(c.posixRename).not.toHaveBeenCalled();
  });

  const three = ['/srv/app/a.php', '/srv/app/b.php', '/srv/app/c.php'];
  const withThreeConflicts = () =>
    server({ ...base, files: [...three, '/srv/app/dest/a.php', '/srv/app/dest/b.php', '/srv/app/dest/c.php'] });

  it('asks once with every conflicting destination when there are three', async () => {
    const d = deps('review', 'keepServer');
    await moveByDrop(withThreeConflicts() as never, connection, three, '/srv/app/dest', d);
    expect(d.chooseConflictPolicy).toHaveBeenCalledTimes(1);
    expect(d.chooseConflictPolicy).toHaveBeenCalledWith([
      '/srv/app/dest/a.php',
      '/srv/app/dest/b.php',
      '/srv/app/dest/c.php',
    ]);
  });

  it('skip moves only the clean items and never downloads a conflicting source', async () => {
    const c = server({
      ...base,
      files: [...three, '/srv/app/dest/a.php', '/srv/app/dest/b.php'],
    });
    const d = deps('skip');
    const result = await moveByDrop(c as never, connection, three, '/srv/app/dest', d);
    expect(result.pasted).toEqual(['/srv/app/dest/c.php']);
    expect(result.skipped.map((s) => s.path)).toEqual(['/srv/app/a.php', '/srv/app/b.php']);
    expect(result.skipped[0].reason).toContain('/srv/app/dest/a.php');
    expect(c.fastGet).not.toHaveBeenCalled();
    expect(d.confirmOverwrite).not.toHaveBeenCalled();
  });

  it('cancel rejects before any write', async () => {
    const c = withThreeConflicts();
    await expect(moveByDrop(c as never, connection, three, '/srv/app/dest', deps('cancel'))).rejects.toBeInstanceOf(
      TransferCancelledError,
    );
    expect(c.posixRename).not.toHaveBeenCalled();
    expect(c.fastGet).not.toHaveBeenCalled();
  });

  it('review falls through to the per-file confirmation for each conflict', async () => {
    const d = deps('review', 'keepServer');
    await moveByDrop(withThreeConflicts() as never, connection, three, '/srv/app/dest', d);
    expect(d.confirmOverwrite).toHaveBeenCalledTimes(3);
  });

  it('refuses on a frozen connection without touching the server', async () => {
    const c = server({ ...base, files: ['/srv/app/a.php'] });
    await expect(
      moveByDrop(c as never, { ...connection, frozen: true }, ['/srv/app/a.php'], '/srv/app/dest', deps()),
    ).rejects.toBeInstanceOf(FrozenError);
    expect(c.posixRename).not.toHaveBeenCalled();
  });

  it('refuses a destination outside the connection root', async () => {
    const c = server({ files: ['/srv/app/a.php'], dirs: ['/srv/app', '/srv/other'] });
    await expect(moveByDrop(c as never, connection, ['/srv/app/a.php'], '/srv/other', deps())).rejects.toThrow(/outside/);
    expect(c.posixRename).not.toHaveBeenCalled();
  });

  it('writes nothing and shows no prompt when everything already sits in the destination', async () => {
    const c = server({ ...base, files: ['/srv/app/dest/a.php'] });
    const d = deps();
    const result = await moveByDrop(c as never, connection, ['/srv/app/dest/a.php'], '/srv/app/dest', d);
    expect(result).toEqual({ pasted: [], skipped: [] });
    expect(c.posixRename).not.toHaveBeenCalled();
    expect(d.chooseConflictPolicy).not.toHaveBeenCalled();
  });

  it('reports a folder dropped on its own descendant and moves nothing', async () => {
    const c = server({ dirs: ['/srv/app', '/srv/app/dir', '/srv/app/dir/sub'] });
    const result = await moveByDrop(c as never, connection, ['/srv/app/dir'], '/srv/app/dir/sub', deps());
    expect(result.pasted).toEqual([]);
    expect(result.skipped[0].reason).toBe('cannot move a folder into itself');
    expect(c.posixRename).not.toHaveBeenCalled();
  });

  it('skips a link source with the paste reason', async () => {
    const c = server({ ...base, links: ['/srv/app/ln'] });
    const result = await moveByDrop(c as never, connection, ['/srv/app/ln'], '/srv/app/dest', deps());
    expect(result.pasted).toEqual([]);
    expect(result.skipped).toEqual([{ path: '/srv/app/ln', reason: 'is a symlink' }]);
    expect(c.posixRename).not.toHaveBeenCalled();
  });

  it('asks for the out-of-root confirmation and writes nothing without it', async () => {
    const c = server({
      files: ['/srv/app/a.php'],
      dirs: ['/srv/app', '/srv/app/ext', '/etc/ext'],
      links: ['/srv/app/ext'],
      real: { '/srv/app/ext': '/etc/ext' },
    });
    await expect(moveByDrop(c as never, connection, ['/srv/app/a.php'], '/srv/app/ext', deps())).rejects.toThrow(
      /outside/,
    );
    expect(c.posixRename).not.toHaveBeenCalled();
  });
});
