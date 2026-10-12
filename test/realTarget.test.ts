import { describe, expect, it } from 'vitest';
import {
  gateWriteTarget,
  LinkRetargetedError,
  resolveTarget,
  type ResolvedTarget,
  type TargetClient,
} from '../src/realTarget';
import type { ConnectionConfig, RemoteStat } from '../src/types';

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

/** Fake server: `map` lists every existing path and its real path. */
function client(map: Record<string, string>, failing: string[] = []): TargetClient {
  return {
    realPath: async (p) => {
      if (failing.includes(p)) throw new Error('Permission denied');
      return map[p];
    },
    stat: async (p) => {
      if (p in map) return fileStat;
      throw Object.assign(new Error('No such file'), { code: 2 });
    },
  };
}

describe('resolveTarget', () => {
  it('plain file resolves to itself with viaLink false', async () => {
    const c = client({ '/srv/app': '/srv/app', '/srv/app/a.php': '/srv/app/a.php' });
    expect(await resolveTarget(c, base, '/srv/app/a.php')).toEqual({
      clickedPath: '/srv/app/a.php',
      realPath: '/srv/app/a.php',
      viaLink: false,
      insideRoot: true,
      resolved: true,
    });
  });

  it('deploy layout root current->releases/42 keeps files inside root', async () => {
    const connection = { ...base, remotePath: '/srv/app/current' };
    const c = client({
      '/srv/app/current': '/srv/app/releases/42',
      '/srv/app/current/foo.php': '/srv/app/releases/42/foo.php',
    });
    const target = await resolveTarget(c, connection, '/srv/app/current/foo.php');
    expect(target.realPath).toBe('/srv/app/releases/42/foo.php');
    expect(target.viaLink).toBe(true);
    expect(target.insideRoot).toBe(true);
    expect(gateWriteTarget(connection, target)).toBe('allow');
  });

  it('link out of root is outside and gates to confirm', async () => {
    const c = client({ '/srv/app': '/srv/app', '/srv/app/shared.ini': '/etc/php/shared.ini' });
    const target = await resolveTarget(c, base, '/srv/app/shared.ini');
    expect(target.realPath).toBe('/etc/php/shared.ini');
    expect(target.viaLink).toBe(true);
    expect(target.insideRoot).toBe(false);
    expect(gateWriteTarget(base, target)).toBe('confirm');
  });

  it('same on frozen connection gates to block', async () => {
    const frozen = { ...base, frozen: true };
    const c = client({ '/srv/app': '/srv/app', '/srv/app/shared.ini': '/etc/php/shared.ini' });
    const target = await resolveTarget(c, frozen, '/srv/app/shared.ini');
    expect(gateWriteTarget(frozen, target)).toBe('block');
  });

  it('new file under a link dir resolves via parent', async () => {
    const c = client({ '/srv/app': '/srv/app', '/srv/app/media': '/data/media' });
    const target = await resolveTarget(c, base, '/srv/app/media/new.png');
    expect(target).toEqual({
      clickedPath: '/srv/app/media/new.png',
      realPath: '/data/media/new.png',
      viaLink: true,
      insideRoot: false,
      resolved: true,
    });
  });

  it('realpath failure falls back to the clicked path with resolved false', async () => {
    const c = client({ '/srv/app': '/srv/app', '/srv/app/a.php': '/srv/app/a.php' }, ['/srv/app/a.php']);
    expect(await resolveTarget(c, base, '/srv/app/a.php')).toEqual({
      clickedPath: '/srv/app/a.php',
      realPath: '/srv/app/a.php',
      viaLink: false,
      insideRoot: true,
      resolved: false,
    });
  });

  it('root realpath failure falls back lexically for the root only', async () => {
    const c = client({ '/srv/app/a.php': '/srv/app/a.php' }, ['/srv/app']);
    const target = await resolveTarget(c, base, '/srv/app/a.php');
    expect(target.resolved).toBe(true);
    expect(target.insideRoot).toBe(true);
  });
});

describe('gateWriteTarget', () => {
  const inside: ResolvedTarget = {
    clickedPath: '/srv/app/a.php',
    realPath: '/srv/app/a.php',
    viaLink: false,
    insideRoot: true,
    resolved: true,
  };

  it('inside root allows', () => {
    expect(gateWriteTarget(base, inside)).toBe('allow');
  });
});

describe('LinkRetargetedError', () => {
  it('LinkRetargetedError names the three paths', () => {
    const err = new LinkRetargetedError('/srv/app/conf.ini', '/etc/a/conf.ini', '/etc/b/conf.ini');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LinkRetargetedError');
    expect(err.message).toContain('/srv/app/conf.ini');
    expect(err.message).toContain('/etc/a/conf.ini');
    expect(err.message).toContain('/etc/b/conf.ini');
    expect(err.message).toMatch(/now points elsewhere/);
  });
});
