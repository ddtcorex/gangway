import { describe, expect, it } from 'vitest';
import {
  BrokenLinkError,
  gateWriteTarget,
  LinkLoopError,
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

interface FakeOptions {
  /** realPath rejects with this error for the given path. */
  realPathErrors?: Record<string, Error>;
  /** stat rejects with this error for the given path (else stat succeeds when known). */
  statErrors?: Record<string, Error>;
  /** Paths that exist as symlinks (lstat says isSymbolicLink) but realPath returns undefined. */
  dangling?: string[];
}

const notFound = (): Error => Object.assign(new Error('No such file'), { code: 2 });

/** Fake server: `map` lists every existing path and its real path. */
function client(map: Record<string, string>, options: FakeOptions = {}): TargetClient {
  const known = (p: string): boolean => p in map || (options.dangling ?? []).includes(p);
  return {
    realPath: async (p) => {
      const err = options.realPathErrors?.[p];
      if (err) throw err;
      return map[p];
    },
    stat: async (p) => {
      const err = options.statErrors?.[p];
      if (err) throw err;
      if (p in map) return fileStat;
      throw notFound();
    },
    lstat: async (p) => {
      if (!known(p)) throw notFound();
      return { ...fileStat, isSymbolicLink: (options.dangling ?? []).includes(p) };
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
    const c = client(
      { '/srv/app': '/srv/app', '/srv/app/a.php': '/srv/app/a.php' },
      { realPathErrors: { '/srv/app/a.php': new Error('Permission denied') } },
    );
    expect(await resolveTarget(c, base, '/srv/app/a.php')).toEqual({
      clickedPath: '/srv/app/a.php',
      realPath: '/srv/app/a.php',
      viaLink: false,
      insideRoot: true,
      resolved: false,
    });
  });

  it('root realpath failure falls back lexically for the root only', async () => {
    const c = client(
      { '/srv/app': '/srv/app', '/srv/app/a.php': '/srv/app/a.php' },
      { realPathErrors: { '/srv/app': new Error('Permission denied') } },
    );
    const target = await resolveTarget(c, base, '/srv/app/a.php');
    expect(target.resolved).toBe(true);
    expect(target.insideRoot).toBe(true);
  });
});

describe('resolveTarget fails closed', () => {
  it('dangling link is refused, not treated as a new file', async () => {
    const c = client({ '/srv/app': '/srv/app' }, { dangling: ['/srv/app/config.php'] });
    const err = await resolveTarget(c, base, '/srv/app/config.php').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokenLinkError);
    expect((err as BrokenLinkError).clickedPath).toBe('/srv/app/config.php');
  });

  it('genuinely new file under a real parent still resolves via the parent', async () => {
    const c = client({ '/srv/app': '/srv/app', '/srv/app/dir': '/srv/app/dir' });
    expect(await resolveTarget(c, base, '/srv/app/dir/new.php')).toEqual({
      clickedPath: '/srv/app/dir/new.php',
      realPath: '/srv/app/dir/new.php',
      viaLink: false,
      insideRoot: true,
      resolved: true,
    });
  });

  it('loop error on realpath throws LinkLoopError', async () => {
    const loop = Object.assign(new Error('Too many levels of symbolic links'), { code: 'ELOOP' });
    const c = client(
      { '/srv/app': '/srv/app' },
      { realPathErrors: { '/srv/app/loop': loop }, statErrors: { '/srv/app/loop': loop } },
    );
    const err = await resolveTarget(c, base, '/srv/app/loop').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinkLoopError);
    expect((err as LinkLoopError).clickedPath).toBe('/srv/app/loop');
  });

  it('loop reported as a generic failure is caught by the stat probe', async () => {
    const c = client(
      { '/srv/app': '/srv/app' },
      {
        realPathErrors: { '/srv/app/loop': new Error('Failure') },
        statErrors: { '/srv/app/loop': new Error('Too many levels of symbolic links') },
      },
    );
    await expect(resolveTarget(c, base, '/srv/app/loop')).rejects.toBeInstanceOf(LinkLoopError);
  });

  it('realpath fails with a generic error and stat also fails rethrows', async () => {
    const dropped = new Error('Connection lost');
    const c = client(
      { '/srv/app': '/srv/app', '/srv/app/a.php': '/srv/app/a.php' },
      { realPathErrors: { '/srv/app/a.php': dropped }, statErrors: { '/srv/app/a.php': new Error('Connection lost') } },
    );
    await expect(resolveTarget(c, base, '/srv/app/a.php')).rejects.toBe(dropped);
  });

  it('realpath fails with a generic error but stat succeeds falls back to the clicked path with resolved false', async () => {
    const c = client(
      { '/srv/app': '/srv/app', '/srv/app/a.php': '/srv/app/a.php' },
      { realPathErrors: { '/srv/app/a.php': new Error('Operation unsupported') } },
    );
    expect(await resolveTarget(c, base, '/srv/app/a.php')).toMatchObject({
      realPath: '/srv/app/a.php',
      insideRoot: true,
      resolved: false,
    });
  });

  it('root realpath failing with stat failing rethrows', async () => {
    const dropped = new Error('Connection lost');
    const c = client(
      { '/srv/app': '/srv/app', '/srv/app/a.php': '/srv/app/a.php' },
      { realPathErrors: { '/srv/app': dropped }, statErrors: { '/srv/app': new Error('Connection lost') } },
    );
    await expect(resolveTarget(c, base, '/srv/app/a.php')).rejects.toBe(dropped);
  });

  it('parent realpath rejection on a new file is not swallowed', async () => {
    const dropped = new Error('Connection lost');
    const c = client(
      { '/srv/app': '/srv/app' },
      { realPathErrors: { '/srv/app/dir': dropped }, statErrors: { '/srv/app/dir': new Error('Connection lost') } },
    );
    await expect(resolveTarget(c, base, '/srv/app/dir/new.php')).rejects.toBe(dropped);
  });
});

describe('resolveTarget walks up to the nearest existing ancestor', () => {
  it('a path two missing levels below an out-of-root link resolves outside', async () => {
    const c = client({ '/srv/app': '/srv/app', '/srv/app/shared': '/etc/ext' });
    expect(await resolveTarget(c, base, '/srv/app/shared/new/sub')).toEqual({
      clickedPath: '/srv/app/shared/new/sub',
      realPath: '/etc/ext/new/sub',
      viaLink: true,
      insideRoot: false,
      resolved: true,
    });
  });

  it('a missing nested path under an in-root link resolves inside', async () => {
    const c = client({ '/srv/app': '/srv/app', '/srv/app/current': '/srv/app/releases/42' });
    expect(await resolveTarget(c, base, '/srv/app/current/a/b/c.php')).toMatchObject({
      realPath: '/srv/app/releases/42/a/b/c.php',
      insideRoot: true,
      resolved: true,
    });
  });

  it('a dangling link ancestor several levels up throws BrokenLinkError', async () => {
    const c = client({ '/srv/app': '/srv/app' }, { dangling: ['/srv/app/gone'] });
    const err = await resolveTarget(c, base, '/srv/app/gone/a/b/c.php').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokenLinkError);
    expect((err as BrokenLinkError).clickedPath).toBe('/srv/app/gone');
  });

  it('an ancestor realpath loop several levels up throws LinkLoopError', async () => {
    const loop = Object.assign(new Error('Too many levels of symbolic links'), { code: 'ELOOP' });
    const c = client({ '/srv/app': '/srv/app' }, { realPathErrors: { '/srv/app/loop': loop } });
    await expect(resolveTarget(c, base, '/srv/app/loop/a/b')).rejects.toBeInstanceOf(LinkLoopError);
  });

  it('an ancestor transport error several levels up is rethrown', async () => {
    const dropped = new Error('Connection lost');
    const c = client(
      { '/srv/app': '/srv/app' },
      { realPathErrors: { '/srv/app/dir': dropped }, statErrors: { '/srv/app/dir': new Error('Connection lost') } },
    );
    await expect(resolveTarget(c, base, '/srv/app/dir/a/b/new.php')).rejects.toBe(dropped);
  });

  it('nothing resolvable up to / keeps the path text with resolved false', async () => {
    const c = client({ '/srv/app': '/srv/app' });
    expect(await resolveTarget(c, base, '/elsewhere/x/y')).toMatchObject({
      realPath: '/elsewhere/x/y',
      resolved: false,
    });
  });
});

/**
 * OpenSSH's realpath tolerates a missing last component, so for a dangling
 * link it returns the link's target path instead of "no such file" (pinned
 * against atmoz/sftp in test/links.integration.test.ts). realPath alone can
 * then never reveal the dangling link: an lstat must run on the path itself.
 */
function openSshClient(map: Record<string, string>, danglingTargets: Record<string, string>): TargetClient {
  return {
    realPath: async (p) => map[p] ?? danglingTargets[p],
    stat: async (p) => {
      if (p in map) return fileStat;
      throw notFound();
    },
    lstat: async (p) => {
      if (p in danglingTargets) return { ...fileStat, isSymbolicLink: true };
      if (p in map) return fileStat;
      throw notFound();
    },
  };
}

describe('resolveTarget against OpenSSH realpath semantics', () => {
  it('a dangling link whose realpath returns its missing target is refused', async () => {
    const c = openSshClient({ '/srv/app': '/srv/app' }, { '/srv/app/config.php': '/srv/app/gone.php' });
    const err = await resolveTarget(c, base, '/srv/app/config.php').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokenLinkError);
    expect((err as BrokenLinkError).clickedPath).toBe('/srv/app/config.php');
  });

  it('a dangling link ancestor whose realpath returns its missing target is refused', async () => {
    const c = openSshClient({ '/srv/app': '/srv/app' }, { '/srv/app/shared': '/srv/app/missing-dir' });
    const err = await resolveTarget(c, base, '/srv/app/shared/a/new.php').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokenLinkError);
    expect((err as BrokenLinkError).clickedPath).toBe('/srv/app/shared');
  });

  it('a missing last component under a link dir still resolves via the link', async () => {
    const c = openSshClient(
      { '/srv/app': '/srv/app', '/srv/app/shared': '/ext/shared', '/srv/app/shared/new.php': '/ext/shared/new.php' },
      {},
    );
    expect(await resolveTarget(c, base, '/srv/app/shared/new.php')).toMatchObject({
      realPath: '/ext/shared/new.php',
      insideRoot: false,
    });
  });

  it('a live file link resolves to its target', async () => {
    const c: TargetClient = {
      realPath: async (p) => ({ '/srv/app': '/srv/app', '/srv/app/l.php': '/srv/app/real.php' })[p],
      stat: async () => fileStat,
      lstat: async (p) => ({ ...fileStat, isSymbolicLink: p === '/srv/app/l.php' }),
    };
    expect(await resolveTarget(c, base, '/srv/app/l.php')).toMatchObject({ realPath: '/srv/app/real.php' });
  });

  it('a link whose stat reports a loop is refused as a loop', async () => {
    const loop = Object.assign(new Error('Too many levels of symbolic links'), { code: 'ELOOP' });
    const c: TargetClient = {
      realPath: async (p) => ({ '/srv/app': '/srv/app', '/srv/app/l': '/srv/app/m' })[p],
      stat: async () => {
        throw loop;
      },
      lstat: async (p) => ({ ...fileStat, isSymbolicLink: p === '/srv/app/l' }),
    };
    await expect(resolveTarget(c, base, '/srv/app/l')).rejects.toBeInstanceOf(LinkLoopError);
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
    expect(err.clickedPath).toBe('/srv/app/conf.ini');
    expect(err.storedRealPath).toBe('/etc/a/conf.ini');
    expect(err.currentRealPath).toBe('/etc/b/conf.ini');
  });
});
