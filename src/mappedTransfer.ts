import fs from 'node:fs/promises';
import path from 'node:path';

export interface MappedPutClient {
  fastPut(localPath: string, remotePath: string): Promise<unknown>;
  posixRename(fromPath: string, toPath: string): Promise<unknown>;
  mkdir(remotePath: string, recursive: boolean): Promise<unknown>;
  delete(remotePath: string): Promise<unknown>;
}

export interface MappedGetClient {
  fastGet(remotePath: string, localPath: string): Promise<unknown>;
}

/**
 * Pure-B single-file push: best-effort parent mkdir, put-to-.tmp then
 * posix-rename over the target (plain SFTP rename fails when the
 * destination exists — same reason uploadFile.ts uses posixRename).
 * No backup, no audit, no sidecar by design (spec §4).
 */
export async function pushMappedFile(
  client: MappedPutClient,
  localPath: string,
  remotePath: string,
): Promise<void> {
  await client.mkdir(path.posix.dirname(remotePath), true).catch(() => {});
  const tmpRemotePath = `${remotePath}.tmp`;
  await client.fastPut(localPath, tmpRemotePath);
  try {
    await client.posixRename(tmpRemotePath, remotePath);
  } catch (err) {
    try {
      await client.delete(tmpRemotePath);
    } catch {
      /* keep the original error */
    }
    throw err;
  }
}

/**
 * Pure-B single-file pull: stage into a sibling file, then atomic-rename
 * onto the workspace file (same shape as transfer/downloadFile.ts).
 * Rationale: `fastGet` truncates the destination before writing, so writing
 * straight onto the real file would leave a truncated corrupt fragment on a
 * failed/cancelled transfer — with no backup under pure B. Staging is
 * atomicity/robustness, not a backup feature, so it stays inside the pure-B
 * carve-out. No sidecar is written next to workspace files (same litter
 * rule as workspace sync).
 */
export async function pullMappedFile(
  client: MappedGetClient,
  remotePath: string,
  localDest: string,
): Promise<void> {
  await fs.mkdir(path.dirname(localDest), { recursive: true });
  const stagingPath = `${localDest}.gangway-downloading`;
  try {
    await client.fastGet(remotePath, stagingPath);
  } catch (err) {
    await fs.rm(stagingPath, { force: true });
    throw err;
  }
  await fs.rename(stagingPath, localDest);
}

/**
 * Recursive local walk returning posix-style rel paths. Symlinks (file or
 * dir) are collected into `skippedSymlinks` by rel and never transferred:
 * `Dirent.isFile()`/`isDirectory()` both return false for a symlink, so an
 * explicit `isSymbolicLink()` check comes first — otherwise symlinks vanish
 * silently and the confirm count lies. Also skips directories outright
 * (caller recreates them), `.meta.json` sidecars, and anything with
 * `.gangway-` in the name (compare-fresh leftovers must never be pushed).
 * Excluded subtrees still count into `excluded` so the confirm dialog stays
 * honest — same convention as walkLocalSyncTree. `skippedSymlinks` is
 * reported separately from `excluded` (pattern hits) so the dialog can name
 * both reasons.
 */
export async function walkMappedLocalFiles(
  localRoot: string,
  exclude: (relPosix: string) => boolean,
): Promise<{ files: Array<{ localPath: string; rel: string }>; excluded: number; skippedSymlinks: string[] }> {
  const files: Array<{ localPath: string; rel: string }> = [];
  const skippedSymlinks: string[] = [];
  let excluded = 0;
  const stack: string[] = [localRoot];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw err;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(localRoot, full).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        skippedSymlinks.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith('.meta.json') || entry.name.includes('.gangway-')) continue;
      if (exclude(rel)) {
        excluded += 1;
        continue;
      }
      files.push({ localPath: full, rel });
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  skippedSymlinks.sort();
  return { files, excluded, skippedSymlinks };
}
