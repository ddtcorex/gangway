import { describe, expect, it, vi } from 'vitest';
import { isLoopError, LinkCache, resolveLink, resolveLinkEntries, type LinkResolveClient } from '../src/linkResolver';
import type { RemoteEntry } from '../src/folderQueue';
import type { RemoteStat } from '../src/types';

const st = (isDirectory: boolean): RemoteStat => ({
  mtime: 0,
  size: 1,
  isDirectory,
  isSymbolicLink: false,
});

function client(over: Partial<LinkResolveClient> = {}): LinkResolveClient {
  return {
    stat: async () => st(false),
    realPath: async (p) => p,
    ...over,
  };
}

const linkEntry = (path: string): RemoteEntry => ({
  path,
  isDirectory: false,
  isSymbolicLink: true,
  size: 0,
});

describe('resolveLink', () => {
  it('file link resolves to file with absolute realPath', async () => {
    const c = client({ realPath: async () => '/srv/real/a.txt', stat: async () => st(false) });
    expect(await resolveLink(c, '/srv/www/a.txt')).toEqual({
      realPath: '/srv/real/a.txt',
      kind: 'file',
    });
  });

  it('relative target resolves to absolute realPath', async () => {
    const c = client({ realPath: async () => '/srv/shared/b.txt' });
    const info = await resolveLink(c, '/srv/www/b.txt');
    expect(info.realPath.startsWith('/')).toBe(true);
    expect(info.realPath).toBe('/srv/shared/b.txt');
  });

  it('dir link resolves to dir and entry.isDirectory becomes true', async () => {
    const c = client({ realPath: async () => '/srv/real/d', stat: async () => st(true) });
    expect((await resolveLink(c, '/srv/www/d')).kind).toBe('dir');
    const [out] = await resolveLinkEntries(c, [linkEntry('/srv/www/d')]);
    expect(out.isDirectory).toBe(true);
    expect(out.link).toEqual({ realPath: '/srv/real/d', kind: 'dir' });
  });

  it('broken link (realPath undefined) is broken', async () => {
    const c = client({ realPath: async () => undefined });
    expect(await resolveLink(c, '/srv/www/x')).toEqual({ realPath: '/srv/www/x', kind: 'broken' });
  });

  it('a not-found error whose path names a loop is not a loop error', async () => {
    // Exact shape seen from atmoz/sftp: ssh2-sftp-client appends the path to
    // the message, and OpenSSH reports the loop pair itself as no such file.
    const notFound = Object.assign(new Error('_xstat: No such file: /var/www/nested/loop-a'), { code: 'ENOENT' });
    expect(isLoopError(notFound)).toBe(false);
    expect(isLoopError(new Error('realPath: Failure /srv/loophole/x'))).toBe(false);
    const c = client({
      realPath: async () => '/srv/www/does-not-exist',
      stat: async () => {
        throw notFound;
      },
    });
    expect((await resolveLink(c, '/srv/www/loop-a')).kind).toBe('broken');
  });

  it('a transport error on both realPath and stat is unresolved, not broken', async () => {
    const drop = Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' });
    const c = client({
      realPath: async () => {
        throw drop;
      },
      stat: async () => {
        throw drop;
      },
    });
    expect(await resolveLink(c, '/srv/www/l')).toEqual({ realPath: '/srv/www/l', kind: 'unresolved' });
    const denied = client({
      realPath: async () => '/srv/real/l',
      stat: async () => {
        throw Object.assign(new Error('Permission denied'), { code: '3' });
      },
    });
    expect((await resolveLink(denied, '/srv/www/l')).kind).toBe('unresolved');
  });

  it('an unresolved link is not expandable', async () => {
    const drop = new Error('timeout');
    const c = client({
      realPath: async () => {
        throw drop;
      },
      stat: async () => {
        throw drop;
      },
    });
    const [out] = await resolveLinkEntries(c, [linkEntry('/srv/www/l')]);
    expect(out.isDirectory).toBe(false);
    expect(out.link).toEqual({ realPath: '/srv/www/l', kind: 'unresolved' });
  });

  it('a not-found stat after a successful realPath stays broken', async () => {
    const c = client({
      realPath: async () => '/srv/gone',
      stat: async () => {
        throw Object.assign(new Error('No such file'), { code: 'ENOENT' });
      },
    });
    expect((await resolveLink(c, '/srv/www/l')).kind).toBe('broken');
  });

  it('ELOOP error is loop', async () => {
    for (const msg of ['ELOOP: too many levels of symbolic links', 'Too many levels', 'symlink loop']) {
      const c = client({
        realPath: async () => {
          throw new Error(msg);
        },
      });
      expect((await resolveLink(c, '/srv/www/l')).kind).toBe('loop');
    }
  });

  it('ancestor target is loop and still expandable', async () => {
    const c = client({ realPath: async () => '/srv', stat: async () => st(true) });
    expect(await resolveLink(c, '/srv/www/up')).toEqual({ realPath: '/srv', kind: 'loop' });
    const [out] = await resolveLinkEntries(c, [linkEntry('/srv/www/up')]);
    expect(out.isDirectory).toBe(true);
    expect(out.link?.kind).toBe('loop');
  });

  it('realpath unsupported falls back to stat and behaves as the path itself', async () => {
    const failing = async (): Promise<string | undefined> => {
      throw new Error('Failure');
    };
    const asDir = client({ realPath: failing, stat: async () => st(true) });
    expect(await resolveLink(asDir, '/srv/www/d')).toEqual({ realPath: '/srv/www/d', kind: 'dir' });
    const asFile = client({ realPath: failing, stat: async () => st(false) });
    expect(await resolveLink(asFile, '/srv/www/f')).toEqual({ realPath: '/srv/www/f', kind: 'file' });
    const none = client({
      realPath: failing,
      stat: async () => {
        throw new Error('No such file');
      },
    });
    expect(await resolveLink(none, '/srv/www/z')).toEqual({ realPath: '/srv/www/z', kind: 'broken' });
  });

  it('stat loop error is loop, not expandable (realPath generic failure)', async () => {
    const c = client({
      realPath: async () => {
        throw new Error('Failure');
      },
      stat: async () => {
        throw new Error('ELOOP: too many levels of symbolic links');
      },
    });
    expect(await resolveLink(c, '/srv/www/l')).toEqual({ realPath: '/srv/www/l', kind: 'loop' });
    const [out] = await resolveLinkEntries(c, [linkEntry('/srv/www/l')]);
    expect(out.link?.kind).toBe('loop');
    expect(out.isDirectory).toBe(false);
  });

  it('stat loop error after resolved realPath is loop, not expandable', async () => {
    const c = client({
      realPath: async () => '/srv/real/x',
      stat: async () => {
        throw Object.assign(new Error('x'), { code: 'ELOOP' });
      },
    });
    expect((await resolveLink(c, '/srv/www/x')).kind).toBe('loop');
    const [out] = await resolveLinkEntries(c, [linkEntry('/srv/www/x')]);
    expect(out.link?.kind).toBe('loop');
    expect(out.isDirectory).toBe(false);
  });

  it('not-found stat after a resolved realPath is broken', async () => {
    const c = client({
      realPath: async () => '/srv/real/gone',
      stat: async () => {
        throw new Error('No such file');
      },
    });
    expect((await resolveLink(c, '/srv/www/g')).kind).toBe('broken');
  });
});

describe('resolveLinkEntries', () => {
  it('non-link entries are untouched and make no client call', async () => {
    let calls = 0;
    const c = client({
      stat: async () => {
        calls++;
        return st(false);
      },
      realPath: async (p) => {
        calls++;
        return p;
      },
    });
    const plain: RemoteEntry = { path: '/a', isDirectory: false, isSymbolicLink: false, size: 3 };
    const out = await resolveLinkEntries(c, [plain]);
    expect(out[0]).toBe(plain);
    expect(calls).toBe(0);
  });

  it('concurrency never exceeds 8 across 40 links', async () => {
    let inFlight = 0;
    let max = 0;
    const c = client({
      realPath: async (p) => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return p;
      },
    });
    const entries = Array.from({ length: 40 }, (_, i) => linkEntry(`/l/${i}`));
    const out = await resolveLinkEntries(c, entries);
    expect(out).toHaveLength(40);
    expect(out.every((e) => e.link)).toBe(true);
    expect(max).toBeLessThanOrEqual(8);
    expect(max).toBeGreaterThan(1);
  });

  it('abort signal stops resolving', async () => {
    const ac = new AbortController();
    let calls = 0;
    const c = client({
      realPath: async (p) => {
        calls++;
        ac.abort();
        return p;
      },
    });
    const entries = Array.from({ length: 30 }, (_, i) => linkEntry(`/l/${i}`));
    await resolveLinkEntries(c, entries, { concurrency: 1, signal: ac.signal });
    expect(calls).toBe(1);
  });

  it('one failing link does not reject the batch', async () => {
    const c = client({
      realPath: async (p) => {
        if (p === '/l/bad') throw new Error('boom');
        return p;
      },
      stat: async (p) => {
        if (p === '/l/bad') throw new Error('boom');
        return st(false);
      },
    });
    const out = await resolveLinkEntries(c, [linkEntry('/l/ok'), linkEntry('/l/bad')]);
    expect(out[0].link?.kind).toBe('file');
    expect(out[1].link?.kind).toBe('unresolved');
  });
});

describe('LinkCache', () => {
  const info = { realPath: '/srv/real', kind: 'file' as const };

  it('returns a stored entry and undefined for an absent key', () => {
    const cache = new LinkCache();
    expect(cache.get('a')).toBeUndefined();
    cache.set('a', info);
    expect(cache.get('a')).toEqual(info);
  });

  it('expires after the ttl using the injected clock', () => {
    let now = 1000;
    const cache = new LinkCache(60_000, () => now);
    cache.set('a', info);
    now += 59_999;
    expect(cache.get('a')).toEqual(info);
    now += 1;
    expect(cache.get('a')).toBeUndefined();
  });

  it('never stores an unresolved result', () => {
    const cache = new LinkCache();
    cache.set('a', { realPath: '/x', kind: 'unresolved' });
    expect(cache.get('a')).toBeUndefined();
  });

  it('clear drops everything and clearPrefix only matching keys', () => {
    const cache = new LinkCache();
    cache.set('c1\0/a', info);
    cache.set('c1\0/b', info);
    cache.set('c2\0/a', info);
    cache.clearPrefix('c1\0');
    expect(cache.get('c1\0/a')).toBeUndefined();
    expect(cache.get('c1\0/b')).toBeUndefined();
    expect(cache.get('c2\0/a')).toEqual(info);
    cache.clear();
    expect(cache.get('c2\0/a')).toBeUndefined();
  });
});

describe('resolveLinkEntries with a cache', () => {
  it('a cache hit makes no realPath or stat call', async () => {
    const cache = new LinkCache();
    const realPath = vi.fn(async (p: string) => p);
    const stat = vi.fn(async () => st(false));
    const c = client({ realPath, stat });
    await resolveLinkEntries(c, [linkEntry('/l/a')], { cache });
    expect(realPath).toHaveBeenCalledTimes(1);
    const [out] = await resolveLinkEntries(c, [linkEntry('/l/a')], { cache });
    expect(realPath).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(out.link).toEqual({ realPath: '/l/a', kind: 'file' });
  });

  it('applies the cached kind to isDirectory and honours cacheKey', async () => {
    const cache = new LinkCache();
    cache.set('k\0/l/d', { realPath: '/real/d', kind: 'dir' });
    const realPath = vi.fn(async (p: string) => p);
    const [out] = await resolveLinkEntries(client({ realPath }), [linkEntry('/l/d')], {
      cache,
      cacheKey: (e) => `k\0${e.path}`,
    });
    expect(realPath).not.toHaveBeenCalled();
    expect(out.isDirectory).toBe(true);
  });

  it('does not cache an unresolved failure, so the next listing retries', async () => {
    const cache = new LinkCache();
    const realPath = vi.fn(async () => {
      throw new Error('timeout');
    });
    const stat = vi.fn(async () => {
      throw new Error('timeout');
    });
    const c = client({ realPath, stat });
    await resolveLinkEntries(c, [linkEntry('/l/a')], { cache });
    await resolveLinkEntries(c, [linkEntry('/l/a')], { cache });
    expect(realPath).toHaveBeenCalledTimes(2);
  });
});

describe('resolveLinkEntries cancellation', () => {
  it('an aborted batch returns without throwing and caches nothing resolved after the abort', async () => {
    const cache = new LinkCache();
    const ctrl = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realPath = vi.fn(async (p: string) => {
      await gate;
      return p;
    });
    const c = client({ realPath });
    const entries = Array.from({ length: 20 }, (_, i) => linkEntry(`/l/${i}`));
    const run = resolveLinkEntries(c, entries, { cache, signal: ctrl.signal, concurrency: 4 });
    await Promise.resolve();
    ctrl.abort();
    release();
    const out = await run;
    expect(out).toHaveLength(20);
    expect(realPath.mock.calls.length).toBe(4);
    for (let i = 0; i < 20; i++) expect(cache.get(`/l/${i}`)).toBeUndefined();
  });

  it('an already-aborted signal makes no client call', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const realPath = vi.fn(async (p: string) => p);
    await resolveLinkEntries(client({ realPath }), [linkEntry('/l/a')], { signal: ctrl.signal });
    expect(realPath).not.toHaveBeenCalled();
  });
});
