import { describe, it, expect, vi } from 'vitest';
import { planDropMove } from '../src/dropMove';
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
