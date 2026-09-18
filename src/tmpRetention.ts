import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readSidecar } from './tmpStore';
import { sidecarPathFor } from './tmpPath';

async function collectFiles(dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(fullPath, out);
    } else if (!entry.isSymbolicLink() && !entry.name.endsWith('.meta.json')) {
      // Symlinks are never Gangway downloads (fastGet writes regular files),
      // so anything link-shaped in the tmp root is foreign: leave it alone
      // rather than purging (or following) something the user did not put
      // there through this tool. Dirent.isDirectory() is false for a symlink
      // pointing at a directory, so without this guard such a link would be
      // collected as a *file* and unlinked below.
      out.push(fullPath);
    }
  }
}

export async function purgeExpiredTmp(tmpRoot: string, retentionDays = 7, now = Date.now()): Promise<string[]> {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const files: string[] = [];
  try {
    await collectFiles(tmpRoot, files);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const purged: string[] = [];
  for (const filePath of files) {
    const meta = await readSidecar(filePath);

    // A tmp file with no sidecar is a download that never finished (a crash
    // mid-stream, say). It still holds real client production data, so
    // keeping it forever -- which is what keying purge solely on
    // `sidecar.downloadedAt` did -- is the wrong default. Its own mtime
    // stands in for `downloadedAt`, so a transfer still in flight, or a file
    // the user is actively editing, is left alone.
    let age: number;
    if (meta) {
      age = meta.downloadedAt;
    } else {
      try {
        age = (await fs.stat(filePath)).mtimeMs;
      } catch (err) {
        // Another purge run, or the download itself, removed this file
        // between collectFiles() listing it and this stat: nothing left to
        // purge, so move on instead of crashing the whole sweep on one
        // already-gone entry.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
    }
    if (age < cutoff) {
      await fs.rm(filePath, { force: true });
      await fs.rm(sidecarPathFor(filePath), { force: true });
      purged.push(filePath);
    }
  }
  return purged;
}

/**
 * Removes a directory tree that has drained fully, bottom-up. Each rm only
 * succeeds on an actually-empty directory *at that moment*, so a file
 * landing concurrently (another window's download) aborts that branch
 * instead of deleting through it -- removal here can never take live data.
 */
async function removeEmptyDirs(dir: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirs(path.join(dir, entry.name));
  }
  try {
    // rmdir (not rm): succeeds only on an actually-empty directory, which is
    // exactly the atomic guard this needs -- fs.rm refuses directories
    // outright (EISDIR), and rm recursive would delete through a race.
    await fs.rmdir(dir);
  } catch {
    // Raced (something landed inside) or still occupied -- leave it for the
    // next sweep rather than forcing anything.
  }
}

/**
 * Drops tmp roots no saved connection owns anymore: pre-slug-change roots
 * (the slug gained remotePath, orphaning the old trees) and roots whose
 * connection was deleted. Age-gated file by file through purgeExpiredTmp,
 * then the directory itself goes only if it drained fully -- a second
 * window's live downloads are never touched. Never throws: a sweep runs at
 * boot and must not wedge activation on one unreadable directory.
 */
export async function sweepUnknownTmpRoots(
  knownSlugs: ReadonlySet<string>,
  retentionDays = 7,
  now = Date.now(),
  baseDir: string = path.join(os.tmpdir(), 'vs-sftp'),
): Promise<string[]> {
  let children: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    children = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    // Missing base dir is the common first-boot case; an unreadable one is
    // someone else's problem, not activation's.
    return [];
  }
  const purged: string[] = [];
  for (const child of children) {
    if (!child.isDirectory() || knownSlugs.has(child.name)) continue;
    const dir = path.join(baseDir, child.name);
    try {
      purged.push(...(await purgeExpiredTmp(dir, retentionDays, now)));
      await removeEmptyDirs(dir);
    } catch {
      // Still holds fresh files, or is unreadable: leave it for the next
      // sweep rather than failing boot on someone else's directory.
    }
  }
  return purged;
}
