import fs from 'node:fs/promises';
import { readSidecar } from './tmpStore';

/**
 * A Gangway-managed local file is "dirty" when its own filesystem mtime no
 * longer matches the mtime recorded the moment it last matched the server
 * exactly (right after a download, or right after an upload's fresh
 * re-stat -- see uploadFile.ts/downloadFile.ts). A file with no sidecar at
 * all, or one with no recorded localMtimeMs (written before this field
 * existed), is never reported dirty: there is nothing to compare against.
 */
export async function isLocallyModified(localPath: string): Promise<boolean> {
  const sidecar = await readSidecar(localPath);
  if (!sidecar || sidecar.localMtimeMs === undefined) return false;

  let stat: { mtimeMs: number };
  try {
    stat = await fs.stat(localPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }

  // Rounded: some filesystems truncate mtime to whole-second resolution, and
  // the two stats being compared can come from different fs calls a moment
  // apart even when nothing changed.
  return Math.round(stat.mtimeMs) !== Math.round(sidecar.localMtimeMs);
}
