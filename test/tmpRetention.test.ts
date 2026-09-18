import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { purgeExpiredTmp, sweepUnknownTmpRoots } from '../src/tmpRetention';
import { writeSidecar } from '../src/tmpStore';
import type { SidecarMeta } from '../src/types';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'retention-test-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function seed(relativePath: string, downloadedAt: number): Promise<string> {
  const filePath = path.join(tmpRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, 'content');
  const meta: SidecarMeta = { connectionId: 'c1', remotePath: relativePath, mtime: 1, size: 7, downloadedAt };
  await writeSidecar(filePath, meta);
  return filePath;
}

describe('purgeExpiredTmp', () => {
  it('deletes a tmp file and its sidecar once older than the retention window', async () => {
    const now = Date.parse('2026-09-16T00:00:00Z');
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
    const stalePath = await seed('app/old.php', eightDaysAgo);

    const purged = await purgeExpiredTmp(tmpRoot, 7, now);

    expect(purged).toEqual([stalePath]);
    await expect(fs.access(stalePath)).rejects.toThrow();
    await expect(fs.access(`${stalePath}.meta.json`)).rejects.toThrow();
  });

  it('keeps a tmp file downloaded within the retention window', async () => {
    const now = Date.parse('2026-09-16T00:00:00Z');
    const oneDayAgo = now - 1 * 24 * 60 * 60 * 1000;
    const freshPath = await seed('app/fresh.php', oneDayAgo);

    const purged = await purgeExpiredTmp(tmpRoot, 7, now);

    expect(purged).toEqual([]);
    await expect(fs.access(freshPath)).resolves.toBeUndefined();
  });

  it('purges an orphaned tmp file that has no sidecar once it is older than the window', async () => {
    // A download interrupted by a crash leaves the file without a sidecar.
    // Keying purge solely on sidecar.downloadedAt meant such a file -- which
    // still holds real client production data -- was retained forever.
    const now = Date.parse('2026-09-16T00:00:00Z');
    const orphanPath = path.join(tmpRoot, 'app', 'orphan.php');
    await fs.mkdir(path.dirname(orphanPath), { recursive: true });
    await fs.writeFile(orphanPath, 'half-downloaded production data');
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
    await fs.utimes(orphanPath, new Date(eightDaysAgo), new Date(eightDaysAgo));

    const purged = await purgeExpiredTmp(tmpRoot, 7, now);

    expect(purged).toEqual([orphanPath]);
    await expect(fs.access(orphanPath)).rejects.toThrow();
  });

  it('keeps a recent orphan, which may be a download still in flight', async () => {
    const now = Date.now();
    const orphanPath = path.join(tmpRoot, 'app', 'in-flight.php');
    await fs.mkdir(path.dirname(orphanPath), { recursive: true });
    await fs.writeFile(orphanPath, 'downloading right now');

    const purged = await purgeExpiredTmp(tmpRoot, 7, now);

    expect(purged).toEqual([]);
    await expect(fs.access(orphanPath)).resolves.toBeUndefined();
  });

  it('leaves symlinks alone: they are never Gangway downloads, and a link to a directory must not be unlinked as a file', async () => {
    const now = Date.parse('2026-09-16T00:00:00Z');
    const target = path.join(tmpRoot, 'real-dir');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'old.php'), 'content');
    const linkPath = path.join(tmpRoot, 'linked-dir');
    await fs.symlink(target, linkPath);

    const purged = await purgeExpiredTmp(tmpRoot, 7, now);

    expect(purged).toEqual([]);
    await expect(fs.access(linkPath)).resolves.toBeUndefined();
    await expect(fs.access(path.join(target, 'old.php'))).resolves.toBeUndefined();
  });

  it('returns an empty array when tmpRoot does not exist at all', async () => {
    const missingRoot = path.join(tmpRoot, 'does-not-exist');
    const purged = await purgeExpiredTmp(missingRoot, 7, Date.now());
    expect(purged).toEqual([]);
  });

  it('skips an orphan file removed by a concurrent purge/download between listing and stat, instead of crashing the whole sweep', async () => {
    // collectFiles() lists the directory once up front; readSidecar() and
    // fs.stat() run later, one file at a time. Anything can remove a
    // sidecar-less file in that window (a second purge run, or the download
    // that was writing it finishing and being deleted for some other
    // reason). An unguarded fs.stat() on a file that is already gone throws
    // ENOENT and used to abort the loop, leaving every later file in the
    // sweep unchecked.
    const orphanPath = path.join(tmpRoot, 'app', 'vanishes.php');
    const survivorPath = path.join(tmpRoot, 'app', 'survivor.php');
    await fs.mkdir(path.dirname(orphanPath), { recursive: true });
    await fs.writeFile(orphanPath, 'removed before stat runs');
    const now = Date.parse('2026-09-16T00:00:00Z');
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
    await seed('app/survivor.php', eightDaysAgo);

    const orphanDir = path.dirname(orphanPath);
    const realReaddir = fs.readdir.bind(fs) as (dir: string, options: unknown) => Promise<unknown>;
    const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation((async (dir: string, options: unknown) => {
      const entries = await realReaddir(dir, options);
      // Remove the orphan only once its own directory has just been listed
      // (so it is captured into `files` first), simulating a concurrent
      // removal in the window between collectFiles() and this file's own
      // fs.stat() call later in purgeExpiredTmp's per-file loop.
      if (dir === orphanDir) await fs.rm(orphanPath, { force: true });
      return entries;
    }) as typeof fs.readdir);

    try {
      const purged = await purgeExpiredTmp(tmpRoot, 7, now);
      expect(purged).toEqual([survivorPath]);
    } finally {
      readdirSpy.mockRestore();
    }
  });
});

describe('sweepUnknownTmpRoots', () => {
  it('purges expired files under unknown roots, drops drained dirs, and keeps known or fresh ones', async () => {
    const now = Date.parse('2026-09-16T00:00:00Z');
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
    const base = path.join(tmpRoot, 'vs-sftp');
    const staleRoot = path.join(base, 'deadbeef00');
    await fs.mkdir(path.join(staleRoot, 'app'), { recursive: true });
    const staleFile = path.join(staleRoot, 'app', 'old.php');
    await fs.writeFile(staleFile, 'orphaned cache');
    await writeSidecar(staleFile, {
      connectionId: 'gone',
      remotePath: '/x/old.php',
      mtime: 1,
      size: 7,
      downloadedAt: eightDaysAgo,
    });
    const freshRoot = path.join(base, 'freshfresh01');
    await fs.mkdir(freshRoot, { recursive: true });
    const freshFile = path.join(freshRoot, 'new.php');
    await fs.writeFile(freshFile, 'still warm');
    const knownRoot = path.join(base, 'knownknown02');
    await fs.mkdir(knownRoot, { recursive: true });

    const purged = await sweepUnknownTmpRoots(new Set(['knownknown02']), 7, now, base);

    expect(purged).toEqual([staleFile]);
    await expect(fs.access(staleRoot)).rejects.toThrow();
    await expect(fs.access(freshFile)).resolves.toBeUndefined();
    await expect(fs.access(freshRoot)).resolves.toBeUndefined();
    await expect(fs.access(knownRoot)).resolves.toBeUndefined();
  });

  it('returns empty when the base directory does not exist', async () => {
    await expect(
      sweepUnknownTmpRoots(new Set(), 7, Date.now(), path.join(tmpRoot, 'no-such-base')),
    ).resolves.toEqual([]);
  });
});
