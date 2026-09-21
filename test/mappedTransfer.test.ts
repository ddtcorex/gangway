import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pushMappedFile, pullMappedFile, walkMappedLocalFiles } from '../src/mappedTransfer';

function fakePutClient() {
  return {
    fastPut: vi.fn().mockResolvedValue(undefined),
    posixRename: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

describe('pushMappedFile', () => {
  it('puts to .tmp then posix-renames over the target', async () => {
    const client = fakePutClient();
    await pushMappedFile(client, '/ws/app.php', '/var/www/app.php');
    expect(client.mkdir).toHaveBeenCalledWith('/var/www', true);
    expect(client.fastPut).toHaveBeenCalledWith('/ws/app.php', '/var/www/app.php.tmp');
    expect(client.posixRename).toHaveBeenCalledWith('/var/www/app.php.tmp', '/var/www/app.php');
    expect(client.delete).not.toHaveBeenCalled();
  });

  it('deletes the orphaned .tmp when the rename fails, then rethrows', async () => {
    const client = fakePutClient();
    client.posixRename.mockRejectedValueOnce(new Error('rename boom'));
    await expect(pushMappedFile(client, '/ws/app.php', '/var/www/app.php')).rejects.toThrow('rename boom');
    expect(client.delete).toHaveBeenCalledWith('/var/www/app.php.tmp');
  });

  it('never touches backup paths', async () => {
    const client = fakePutClient();
    await pushMappedFile(client, '/ws/app.php', '/var/www/app.php');
    for (const call of [...client.fastPut.mock.calls, ...client.posixRename.mock.calls, ...client.mkdir.mock.calls]) {
      expect(String(call[1] ?? call[0])).not.toContain('.gangway-backup-');
    }
  });
});

describe('pullMappedFile', () => {
  it('stages then renames: fastGet targets the staging sibling, dest holds full bytes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mapped-pull-'));
    const dest = path.join(dir, 'sub', 'app.php');
    const client = { fastGet: vi.fn().mockImplementation(async (_r: string, l: string) => { await fs.mkdir(path.dirname(l), { recursive: true }); await fs.writeFile(l, 'server'); }) };
    await pullMappedFile(client, '/var/www/app.php', dest);
    expect(client.fastGet).toHaveBeenCalledWith('/var/www/app.php', `${dest}.gangway-downloading`);
    expect(await fs.readFile(dest, 'utf8')).toBe('server');
    await expect(fs.stat(`${dest}.gangway-downloading`)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a partial transfer that then fails leaves the previous dest byte-identical and removes staging', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mapped-pull-'));
    const dest = path.join(dir, 'app.php');
    await fs.writeFile(dest, 'good copy');
    const client = {
      fastGet: vi.fn().mockImplementation(async (_r: string, l: string) => {
        await fs.writeFile(l, 'partial server bytes');
        throw new Error('network boom');
      }),
    };
    await expect(pullMappedFile(client, '/var/www/app.php', dest)).rejects.toThrow('network boom');
    expect(client.fastGet).toHaveBeenCalledWith('/var/www/app.php', `${dest}.gangway-downloading`);
    expect(await fs.readFile(dest, 'utf8')).toBe('good copy');
    await expect(fs.stat(`${dest}.gangway-downloading`)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('walkMappedLocalFiles', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mapped-walk-'));
    await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(dir, 'a.php'), 'a');
    await fs.writeFile(path.join(dir, 'sub', 'b.php'), 'b');
    await fs.writeFile(path.join(dir, 'note.meta.json'), '{}');
    await fs.writeFile(path.join(dir, 'x.gangway-compare-fresh'), 'x');
  });

  it('lists files with posix rels and skips sidecars and gangway leftovers', async () => {
    const { files, excluded, skippedSymlinks } = await walkMappedLocalFiles(dir, () => false);
    expect(files.map((f) => f.rel).sort()).toEqual(['a.php', 'sub/b.php']);
    expect(excluded).toBe(0);
    expect(skippedSymlinks).toEqual([]);
  });

  it('counts excluded files without listing them', async () => {
    const { files, excluded } = await walkMappedLocalFiles(dir, (rel) => rel.startsWith('sub/'));
    expect(files.map((f) => f.rel)).toEqual(['a.php']);
    expect(excluded).toBe(1);
  });

  it('excludes a whole subtree when the directory itself matches, still counting its files', async () => {
    const { files, excluded, skippedSymlinks } = await walkMappedLocalFiles(dir, (rel) => rel === 'sub');
    expect(files.map((f) => f.rel)).toEqual(['a.php']);
    expect(excluded).toBe(1);
    expect(skippedSymlinks).toEqual([]);
  });

  it('reports symlinks separately instead of silently dropping them', async () => {
    await fs.symlink(path.join(dir, 'a.php'), path.join(dir, 'link.php'));
    await fs.symlink(path.join(dir, 'sub'), path.join(dir, 'linkdir'));
    const { files, excluded, skippedSymlinks } = await walkMappedLocalFiles(dir, () => false);
    expect(files.map((f) => f.rel).sort()).toEqual(['a.php', 'sub/b.php']);
    expect(excluded).toBe(0);
    expect(skippedSymlinks.sort()).toEqual(['link.php', 'linkdir']);
  });
});
