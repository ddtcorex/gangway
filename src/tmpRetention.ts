import fs from 'node:fs/promises';
import path from 'node:path';
import { readSidecar } from './tmpStore';
import { sidecarPathFor } from './tmpPath';

async function collectFiles(dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(fullPath, out);
    } else if (!entry.name.endsWith('.meta.json')) {
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
    const age = meta ? meta.downloadedAt : (await fs.stat(filePath)).mtimeMs;
    if (age < cutoff) {
      await fs.rm(filePath, { force: true });
      await fs.rm(sidecarPathFor(filePath), { force: true });
      purged.push(filePath);
    }
  }
  return purged;
}
