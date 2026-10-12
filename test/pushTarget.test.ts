import { describe, expect, it, vi } from 'vitest';
import { preparePush } from '../src/pushTarget';
import { LinkRetargetedError, type TargetClient } from '../src/realTarget';
import type { ConnectionConfig, RemoteStat, SidecarMeta } from '../src/types';

const base: ConnectionConfig = {
  id: 'c1',
  name: 'p',
  host: 'h',
  port: 22,
  username: 'u',
  remotePath: '/srv/app',
  authMethod: 'agent',
};

const fileStat: RemoteStat = { mtime: 0, size: 1, isDirectory: false, isSymbolicLink: false };
const notFound = (): Error => Object.assign(new Error('No such file'), { code: 2 });

/**
 * Fake server: `map` lists every existing path and its real path. Without
 * `links`, a path is a link when its real path differs; with `links`, only
 * the listed paths are links (a file below a linked parent is not one).
 */
function client(map: Record<string, string>, links?: Set<string>): TargetClient {
  return {
    realPath: async (p) => map[p],
    stat: async (p) => {
      if (p in map) return fileStat;
      throw notFound();
    },
    lstat: async (p) => {
      if (!(p in map)) throw notFound();
      return { ...fileStat, isSymbolicLink: links ? links.has(p) : map[p] !== p };
    },
  };
}

function sidecar(extra: Partial<SidecarMeta> = {}): SidecarMeta {
  return { connectionId: 'c1', remotePath: '/srv/app/link.php', mtime: 0, size: 1, downloadedAt: 1, ...extra };
}

const linkInside = { '/srv/app': '/srv/app', '/srv/app/link.php': '/srv/app/shared/real.php' };
const linkOutside = { '/srv/app': '/srv/app', '/srv/app/link.php': '/srv/shared/real.php' };

describe('preparePush', () => {
  it('preparePush returns the real path for a link', async () => {
    const confirm = vi.fn();
    const result = await preparePush(
      client(linkInside),
      base,
      sidecar({ realPath: '/srv/app/shared/real.php' }),
      '/srv/app/link.php',
      confirm,
    );
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.target.realPath).toBe('/srv/app/shared/real.php');
    expect(result.target.clickedPath).toBe('/srv/app/link.php');
    expect(result.target.viaLink).toBe(true);
    expect(result.sidecarUpdate).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('preparePush throws LinkRetargetedError when stored realPath differs', async () => {
    const err = await preparePush(
      client(linkInside),
      base,
      sidecar({ realPath: '/srv/app/shared/old.php' }),
      '/srv/app/link.php',
      vi.fn(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinkRetargetedError);
    const retargeted = err as LinkRetargetedError;
    expect(retargeted.clickedPath).toBe('/srv/app/link.php');
    expect(retargeted.storedRealPath).toBe('/srv/app/shared/old.php');
    expect(retargeted.currentRealPath).toBe('/srv/app/shared/real.php');
  });

  it('link replaced by a regular file counts as retargeted', async () => {
    const replaced = { '/srv/app': '/srv/app', '/srv/app/link.php': '/srv/app/link.php' };
    await expect(
      preparePush(client(replaced), base, sidecar({ realPath: '/srv/app/shared/real.php' }), '/srv/app/link.php', vi.fn()),
    ).rejects.toBeInstanceOf(LinkRetargetedError);
  });

  it('a plain file replaced by a link after download stops the push', async () => {
    // Downloaded as a plain file (no realPath stored), now a link elsewhere.
    const err = await preparePush(
      client(linkInside),
      base,
      sidecar({ remotePath: '/srv/app/link.php' }),
      '/srv/app/link.php',
      vi.fn(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinkRetargetedError);
    const retargeted = err as LinkRetargetedError;
    expect(retargeted.storedRealPath).toBe('/srv/app/link.php');
    expect(retargeted.currentRealPath).toBe('/srv/app/shared/real.php');
  });

  it('legacy sidecar without realPath for a path that is not a link pushes normally', async () => {
    const plain = { '/srv/app': '/srv/app', '/srv/app/a.php': '/srv/app/a.php' };
    const result = await preparePush(client(plain), base, sidecar({ remotePath: '/srv/app/a.php' }), '/srv/app/a.php', vi.fn());
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.target.realPath).toBe('/srv/app/a.php');
    expect(result.target.viaLink).toBe(false);
  });

  it('legacy sidecar without realPath below a linked parent pushes to the fresh real path', async () => {
    // A bulk download stores no realPath; the file itself is not a link, only
    // its parent is, so this is not a retarget.
    const linkedParent = {
      '/srv/app': '/srv/app',
      '/srv/app/current': '/srv/app/releases/42',
      '/srv/app/current/a.php': '/srv/app/releases/42/a.php',
    };
    const result = await preparePush(
      client(linkedParent, new Set(['/srv/app/current'])),
      base,
      sidecar({ remotePath: '/srv/app/current/a.php' }),
      '/srv/app/current/a.php',
      vi.fn(),
    );
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.target.realPath).toBe('/srv/app/releases/42/a.php');
    expect(result.target.viaLink).toBe(true);
  });

  it('outside root asks once then remembers via sidecarUpdate', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const first = await preparePush(
      client(linkOutside),
      base,
      sidecar({ realPath: '/srv/shared/real.php' }),
      '/srv/app/link.php',
      confirm,
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith('/srv/shared/real.php');
    expect(first.status).toBe('ready');
    if (first.status !== 'ready') return;
    expect(first.sidecarUpdate).toEqual({ outsideRootConfirmedFor: '/srv/shared/real.php' });

    const second = await preparePush(
      client(linkOutside),
      base,
      sidecar({ realPath: '/srv/shared/real.php', ...first.sidecarUpdate }),
      '/srv/app/link.php',
      confirm,
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(second.status).toBe('ready');
    if (second.status !== 'ready') return;
    expect(second.sidecarUpdate).toBeUndefined();
  });

  it('asks again when the remembered confirmation was for a different real path', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    await preparePush(
      client(linkOutside),
      base,
      sidecar({ realPath: '/srv/shared/real.php', outsideRootConfirmedFor: '/srv/other/real.php' }),
      '/srv/app/link.php',
      confirm,
    );
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('declined returns declined', async () => {
    const result = await preparePush(
      client(linkOutside),
      base,
      sidecar({ realPath: '/srv/shared/real.php' }),
      '/srv/app/link.php',
      vi.fn().mockResolvedValue(false),
    );
    expect(result).toEqual({ status: 'declined' });
  });

  it('frozen outside root returns blocked', async () => {
    const confirm = vi.fn();
    const result = await preparePush(
      client(linkOutside),
      { ...base, frozen: true },
      sidecar({ realPath: '/srv/shared/real.php', outsideRootConfirmedFor: '/srv/shared/real.php' }),
      '/srv/app/link.php',
      confirm,
    );
    expect(result).toEqual({ status: 'blocked' });
    expect(confirm).not.toHaveBeenCalled();
  });
});
