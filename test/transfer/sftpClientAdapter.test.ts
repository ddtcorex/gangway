import { describe, it, expect } from 'vitest';
import { SftpClientAdapter } from '../../src/transfer/sftpClientAdapter';
import type { RawSftpClient, RawSftpStat, RawSftpListEntry } from '../../src/transfer/sftpClientAdapter';

function fakeRawClient(overrides: Partial<RawSftpClient> = {}): RawSftpClient {
  return {
    connect: async () => {},
    end: async () => {},
    stat: async () => ({ size: 0, modifyTime: 0, isDirectory: false, isSymbolicLink: false }),
    fastGet: async () => undefined,
    fastPut: async () => undefined,
    rename: async () => undefined,
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

  it('passes through connect/end/fastGet/fastPut/rename/list to the raw client unchanged', async () => {
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
        rename: async (from, to) => {
          calls.push(`rename:${from}:${to}`);
          return 'rename-result';
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
    expect(await adapter.rename('/a', '/b')).toBe('rename-result');
    expect(await adapter.list('/dir')).toEqual(listEntries);

    expect(calls).toEqual([
      'connect:{"host":"example.com"}',
      'end',
      'fastGet:/remote:/local',
      'fastPut:/local:/remote',
      'rename:/a:/b',
      'list:/dir',
    ]);
  });
});
