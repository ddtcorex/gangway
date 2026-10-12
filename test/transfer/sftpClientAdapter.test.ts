import { describe, it, expect } from 'vitest';
import { SftpClientAdapter } from '../../src/transfer/sftpClientAdapter';
import type { RawSftpClient, RawSftpStat, RawSftpListEntry } from '../../src/transfer/sftpClientAdapter';

function fakeRawClient(overrides: Partial<RawSftpClient> = {}): RawSftpClient {
  return {
    connect: async () => {},
    end: async () => {},
    stat: async () => ({ size: 0, modifyTime: 0, isDirectory: false, isSymbolicLink: false }),
    lstat: async () => ({ size: 0, modifyTime: 0, isDirectory: false, isSymbolicLink: false }),
    realPath: async (p: string) => p,
    fastGet: async () => undefined,
    fastPut: async () => undefined,
    posixRename: async () => undefined,
    delete: async () => undefined,
    mkdir: async () => undefined,
    rmdir: async () => undefined,
    chmod: async () => undefined,
    list: async () => [],
    ...overrides,
  };
}

describe('SftpClientAdapter', () => {
  it("translates the real client's stat() modifyTime field to mtime, matching RemoteStat", async () => {
    // Shape verified against ssh2-sftp-client@11.0.0's src/index.js `_xstat()`:
    // the real object never has an `mtime` field, only `modifyTime`.
    const rawStat: RawSftpStat = { size: 4096, modifyTime: 1726500000000, isDirectory: false, isSymbolicLink: false };
    const adapter = new SftpClientAdapter(fakeRawClient({ stat: async () => rawStat }));

    const stat = await adapter.stat('/var/www/app/config.php');

    expect(stat).toEqual({ mtime: 1726500000000, size: 4096, isDirectory: false, isSymbolicLink: false });
  });

  it('would otherwise make a same-size, different-mtime edit look clean if left untranslated', async () => {
    // Regression guard for the actual bug: two stats with the SAME size but
    // DIFFERENT modifyTime must translate to two different `mtime` values,
    // not both collapse to `undefined`.
    const older: RawSftpStat = { size: 100, modifyTime: 1000, isDirectory: false, isSymbolicLink: false };
    const newer: RawSftpStat = { size: 100, modifyTime: 2000, isDirectory: false, isSymbolicLink: false };

    const olderStat = await new SftpClientAdapter(fakeRawClient({ stat: async () => older })).stat('/f');
    const newerStat = await new SftpClientAdapter(fakeRawClient({ stat: async () => newer })).stat('/f');

    expect(olderStat.mtime).toBe(1000);
    expect(newerStat.mtime).toBe(2000);
    expect(olderStat.mtime).not.toBe(newerStat.mtime);
  });

  it('passes isDirectory/isSymbolicLink through stat() unchanged', async () => {
    const rawStat: RawSftpStat = { size: 0, modifyTime: 5, isDirectory: true, isSymbolicLink: true };
    const adapter = new SftpClientAdapter(fakeRawClient({ stat: async () => rawStat }));

    const stat = await adapter.stat('/some/dir');

    expect(stat.isDirectory).toBe(true);
    expect(stat.isSymbolicLink).toBe(true);
  });

  it('passes through connect/end/fastGet/fastPut/posixRename/delete/mkdir/list to the raw client unchanged', async () => {
    const calls: string[] = [];
    const listEntries: RawSftpListEntry[] = [{ name: 'a.txt', type: '-' }];
    const adapter = new SftpClientAdapter(
      fakeRawClient({
        connect: async (opts) => {
          calls.push(`connect:${JSON.stringify(opts)}`);
        },
        end: async () => {
          calls.push('end');
        },
        fastGet: async (r, l) => {
          calls.push(`fastGet:${r}:${l}`);
          return 'get-result';
        },
        fastPut: async (l, r) => {
          calls.push(`fastPut:${l}:${r}`);
          return 'put-result';
        },
        posixRename: async (from, to) => {
          calls.push(`posixRename:${from}:${to}`);
          return 'posixRename-result';
        },
        delete: async (p) => {
          calls.push(`delete:${p}`);
          return 'delete-result';
        },
        mkdir: async (p, recursive) => {
          calls.push(`mkdir:${p}:${recursive}`);
          return 'mkdir-result';
        },
        list: async (p) => {
          calls.push(`list:${p}`);
          return listEntries;
        },
      }),
    );

    await adapter.connect({ host: 'example.com' });
    await adapter.end();
    expect(await adapter.fastGet('/remote', '/local')).toBe('get-result');
    expect(await adapter.fastPut('/local', '/remote')).toBe('put-result');
    expect(await adapter.posixRename('/a', '/b')).toBe('posixRename-result');
    expect(await adapter.delete('/a.tmp')).toBe('delete-result');
    expect(await adapter.mkdir('/var/www/app', true)).toBe('mkdir-result');
    expect(await adapter.list('/dir')).toEqual(listEntries);

    expect(calls).toEqual([
      'connect:{"host":"example.com"}',
      'end',
      'fastGet:/remote:/local',
      'fastPut:/local:/remote',
      'posixRename:/a:/b',
      'delete:/a.tmp',
      'mkdir:/var/www/app:true',
      'list:/dir',
    ]);
  });

  it('lstat maps modifyTime to mtime and keeps isSymbolicLink', async () => {
    const rawStat: RawSftpStat = { size: 11, modifyTime: 1726500000000, isDirectory: false, isSymbolicLink: true };
    const seen: string[] = [];
    const adapter = new SftpClientAdapter(
      fakeRawClient({
        lstat: async (p) => {
          seen.push(p);
          return rawStat;
        },
      }),
    );

    const stat = await adapter.lstat('/var/www/current');

    expect(seen).toEqual(['/var/www/current']);
    expect(stat).toEqual({ mtime: 1726500000000, size: 11, isDirectory: false, isSymbolicLink: true });
  });

  it('realPath returns the absolute path', async () => {
    const adapter = new SftpClientAdapter(fakeRawClient({ realPath: async () => '/var/www/releases/42' }));

    expect(await adapter.realPath('/var/www/current')).toBe('/var/www/releases/42');
  });

  it('realPath returns undefined when the lib resolves an empty string', async () => {
    const adapter = new SftpClientAdapter(fakeRawClient({ realPath: async () => '' }));

    expect(await adapter.realPath('/missing')).toBeUndefined();
  });

  it('realPath rethrows other errors', async () => {
    const adapter = new SftpClientAdapter(
      fakeRawClient({
        realPath: async () => {
          throw new Error('Permission denied');
        },
      }),
    );

    await expect(adapter.realPath('/root/x')).rejects.toThrow('Permission denied');
  });

  describe('fastGet through a link', () => {
    const notRegular = (p: string) => new Error(`fastGet: Not a regular file ${p}`);

    it('retries at the real path when the library refuses a link as "Not a regular file"', async () => {
      const calls: string[] = [];
      const adapter = new SftpClientAdapter(
        fakeRawClient({
          realPath: async () => '/srv/real/env.php',
          fastGet: async (r) => {
            calls.push(r);
            if (r === '/srv/link/env.php') throw notRegular(r);
            return 'ok';
          },
        }),
      );
      expect(await adapter.fastGet('/srv/link/env.php', '/local')).toBe('ok');
      expect(calls).toEqual(['/srv/link/env.php', '/srv/real/env.php']);
    });

    it('does not look up the real path for a regular file', async () => {
      let lookups = 0;
      const adapter = new SftpClientAdapter(
        fakeRawClient({
          realPath: async (p) => {
            lookups += 1;
            return p;
          },
        }),
      );
      await adapter.fastGet('/srv/app/env.php', '/local');
      expect(lookups).toBe(0);
    });

    it('rethrows the original error when the real path is the same path (a folder)', async () => {
      const adapter = new SftpClientAdapter(
        fakeRawClient({
          realPath: async (p) => p,
          fastGet: async (r) => {
            throw notRegular(r);
          },
        }),
      );
      await expect(adapter.fastGet('/srv/app/dir', '/local')).rejects.toThrow('Not a regular file /srv/app/dir');
    });

    it('rethrows the original error when the path has no real path (missing)', async () => {
      const adapter = new SftpClientAdapter(
        fakeRawClient({
          realPath: async () => '',
          fastGet: async (r) => {
            throw notRegular(r);
          },
        }),
      );
      await expect(adapter.fastGet('/srv/app/gone', '/local')).rejects.toThrow('Not a regular file /srv/app/gone');
    });

    it('does not retry other errors', async () => {
      let lookups = 0;
      const adapter = new SftpClientAdapter(
        fakeRawClient({
          realPath: async (p) => {
            lookups += 1;
            return p;
          },
          fastGet: async () => {
            throw new Error('connection reset');
          },
        }),
      );
      await expect(adapter.fastGet('/srv/app/a.php', '/local')).rejects.toThrow('connection reset');
      expect(lookups).toBe(0);
    });
  });
});
