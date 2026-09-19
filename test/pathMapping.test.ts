import { describe, it, expect } from 'vitest';
import {
  defaultMapping,
  overlapNotes,
  resolveLocalToRemote,
  resolveRemoteToLocal,
} from '../src/pathMapping';
import type { ConnectionConfig } from '../src/types';

const base: ConnectionConfig = {
  id: 'c1',
  name: 'p',
  host: 'h',
  port: 22,
  username: 'u',
  remotePath: '/srv/app',
  authMethod: 'agent',
};

const mapped: ConnectionConfig = {
  ...base,
  mappings: [
    { localPath: '/home/u/proj', remotePath: '/srv/app' },
    { localPath: '/home/u/proj/sub', remotePath: '/srv/app/other' },
  ],
};

describe('resolveLocalToRemote', () => {
  it('prefers the longest explicit prefix, then the default', () => {
    expect(resolveLocalToRemote(mapped, ['/home/u/proj'], '/home/u/proj/sub/f.php')).toBe('/srv/app/other/f.php');
    expect(resolveLocalToRemote(mapped, ['/home/u/proj'], '/home/u/proj/a.php')).toBe('/srv/app/a.php');
    expect(resolveLocalToRemote({ ...base, mappings: [] }, ['/home/u/proj'], '/home/u/proj/a.php')).toBe(
      '/srv/app/a.php',
    );
    expect(resolveLocalToRemote(mapped, ['/home/u/proj'], '/elsewhere/a.php')).toBeUndefined();
  });

  it('refuses resolved remotes outside the connection root', () => {
    const rogue: ConnectionConfig = {
      ...base,
      mappings: [{ localPath: '/home/u/proj', remotePath: '/other/place' }],
    };
    expect(resolveLocalToRemote(rogue, ['/home/u/proj'], '/home/u/proj/a.php')).toBeUndefined();
  });

  it('normalizes trailing slashes', () => {
    expect(resolveLocalToRemote(mapped, ['/home/u/proj/'], '/home/u/proj/a.php')).toBe('/srv/app/a.php');
  });
});

describe('resolveRemoteToLocal', () => {
  it('inverts the same match order', () => {
    expect(resolveRemoteToLocal(mapped, ['/home/u/proj'], '/srv/app/other/f.php')).toBe('/home/u/proj/sub/f.php');
    expect(resolveRemoteToLocal(mapped, ['/home/u/proj'], '/srv/app/a.php')).toBe('/home/u/proj/a.php');
    expect(resolveRemoteToLocal(mapped, ['/home/u/proj'], '/srv/other/a.php')).toBeUndefined();
  });
});

describe('defaultMapping', () => {
  it('defaults only the first workspace root', () => {
    expect(defaultMapping(base, ['/w1', '/w2'])).toEqual({ local: '/w1', remote: '/srv/app' });
    expect(defaultMapping(base, [])).toBeUndefined();
  });
});

describe('overlapNotes', () => {
  it('notes the losing row when mappings nest', () => {
    const notes = overlapNotes(mapped.mappings ?? []);
    expect(notes).toContainEqual(
      expect.objectContaining({ index: 0, note: expect.stringContaining('row 2') }),
    );
  });
});

describe('isRemoteInsideRoot', () => {
  it('refuses outside-root remotes and accepts the root itself', async () => {
    const { isRemoteInsideRoot } = await import('../src/pathMapping');
    const conn = { id: 'c', name: 'p', host: 'h', port: 22, username: 'u', remotePath: '/srv/app', authMethod: 'agent' as const };
    expect(isRemoteInsideRoot(conn, '/srv/app/x.php')).toBe(true);
    expect(isRemoteInsideRoot(conn, '/srv/app')).toBe(true);
    expect(isRemoteInsideRoot(conn, '/other/place')).toBe(false);
    expect(isRemoteInsideRoot(conn, '/srv/app2/x.php')).toBe(false);
    const rooted = { ...conn, remotePath: '/' };
    expect(isRemoteInsideRoot(rooted, '/anything/at/all')).toBe(true);
  });
});
