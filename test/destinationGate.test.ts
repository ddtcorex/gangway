import { describe, expect, it, vi } from 'vitest';
import { createDestinationGate } from '../src/destinationGate';
import type { TargetClient } from '../src/realTarget';
import type { ConnectionConfig, RemoteStat } from '../src/types';

const base: ConnectionConfig = {
  id: 'c1',
  name: 'prod',
  host: 'h',
  port: 22,
  username: 'u',
  remotePath: '/srv/app',
  authMethod: 'agent',
};

const dirStat: RemoteStat = { mtime: 0, size: 0, isDirectory: true, isSymbolicLink: false };

const notFound = (): Error => Object.assign(new Error('No such file'), { code: 2 });

/** Fake server: `map` lists every existing path and its real path. */
function fakeClient(map: Record<string, string>, dangling: string[] = []) {
  const client = {
    realPath: vi.fn(async (p: string) => map[p]),
    stat: vi.fn(async (p: string) => {
      if (p in map) return dirStat;
      throw notFound();
    }),
    lstat: vi.fn(async (p: string) => {
      if (dangling.includes(p)) return { ...dirStat, isDirectory: false, isSymbolicLink: true };
      if (p in map) return dirStat;
      throw notFound();
    }),
  };
  return client satisfies TargetClient;
}

describe('createDestinationGate', () => {
  it('refuses a destination whose real path is outside the root', async () => {
    const client = fakeClient({ '/srv/app': '/srv/app', '/srv/app/shared': '/etc/ext' });
    const gate = createDestinationGate(client, base);
    await expect(gate('/srv/app/shared')).rejects.toThrow(/outside/);
    await expect(gate('/srv/app/shared')).rejects.toThrow('/srv/app/shared');
  });

  it('refuses on a frozen connection before any server call', async () => {
    const client = fakeClient({ '/srv/app': '/srv/app', '/srv/app/sub': '/srv/app/sub' });
    const gate = createDestinationGate(client, { ...base, frozen: true });
    await expect(gate('/srv/app/sub')).rejects.toThrow(/frozen/);
    expect(client.realPath).not.toHaveBeenCalled();
    expect(client.stat).not.toHaveBeenCalled();
    expect(client.lstat).not.toHaveBeenCalled();
  });

  it('pure-B mapped pushes skip the freeze gate but still refuse out-of-root on a frozen connection', async () => {
    const client = fakeClient({
      '/srv/app': '/srv/app',
      '/srv/app/current': '/srv/app/releases/42',
      '/srv/app/shared': '/etc/ext',
    });
    const gate = createDestinationGate(client, { ...base, frozen: true }, { freezeGate: false });
    await expect(gate('/srv/app/current')).resolves.toBeUndefined();
    await expect(gate('/srv/app/shared')).rejects.toThrow(/outside/);
  });

  it('lets a link inside the root through', async () => {
    const client = fakeClient({ '/srv/app': '/srv/app', '/srv/app/current': '/srv/app/releases/42' });
    const gate = createDestinationGate(client, base);
    await expect(gate('/srv/app/current')).resolves.toBeUndefined();
  });

  it('resolves each distinct directory once (cache hit does not call realPath again)', async () => {
    const client = fakeClient({ '/srv/app': '/srv/app', '/srv/app/a': '/srv/app/a', '/srv/app/b': '/srv/app/b' });
    const gate = createDestinationGate(client, base);
    await gate('/srv/app/a');
    const afterFirst = client.realPath.mock.calls.length;
    await gate('/srv/app/a');
    expect(client.realPath.mock.calls.length).toBe(afterFirst);
    await gate('/srv/app/b');
    expect(client.realPath.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('caches a failure and rethrows it for the same directory', async () => {
    const client = fakeClient({ '/srv/app': '/srv/app' }, ['/srv/app/gone']);
    const gate = createDestinationGate(client, base);
    const first = await gate('/srv/app/gone').catch((err: unknown) => err);
    expect(first).toBeInstanceOf(Error);
    const calls = client.realPath.mock.calls.length + client.lstat.mock.calls.length;
    const second = await gate('/srv/app/gone').catch((err: unknown) => err);
    expect(second).toBe(first);
    expect(client.realPath.mock.calls.length + client.lstat.mock.calls.length).toBe(calls);
  });

  it('names the clicked directory, never the link error path, for a broken link', async () => {
    // The root itself is a dangling link: BrokenLinkError.clickedPath would
    // be the root, which is not what the user acted on.
    const client = fakeClient({ '/srv/app/sub': '/srv/app/sub' }, ['/srv/app']);
    const gate = createDestinationGate(client, base);
    const err = (await gate('/srv/app/sub').catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('"/srv/app/sub"');
    expect(err.message).not.toContain('"/srv/app"');
    expect(err.message).toMatch(/broken link/);
  });
});
