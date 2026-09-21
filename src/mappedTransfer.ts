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
 *
 * Mode policy (explicit, because a pull must not silently change what the
 * user can do with the file): an existing `localDest` keeps ITS mode across
 * the pull — the mode is read before the transfer and re-applied after the
 * rename, so pulling over a 0600 secrets file (or an executable script)
 * neither widens nor loses its permissions. A destination that does not
 * exist yet keeps the staging file's default mode (the process umask
 * applied to a fresh file): there is no prior mode to preserve, and
 * inventing one would be a policy this command has no basis for.
 */
export async function pullMappedFile(
  client: MappedGetClient,
  remotePath: string,
  localDest: string,
): Promise<void> {
  await fs.mkdir(path.dirname(localDest), { recursive: true });
  const stagingPath = `${localDest}.gangway-downloading`;
  const previousMode = await fs.stat(localDest).then(
    (stat) => stat.mode & 0o7777,
    () => undefined,
  );
  try {
    await client.fastGet(remotePath, stagingPath);
  } catch (err) {
    try {
      await fs.rm(stagingPath, { force: true });
    } catch {
      /* keep the original error */
    }
    throw err;
  }
  // A failed rename would otherwise strand the fully-downloaded staging file
  // next to the destination forever (nothing else ever collects it): remove
  // it, keeping the rename error as the one the caller sees and retries on.
  try {
    await fs.rename(stagingPath, localDest);
  } catch (err) {
    try {
      await fs.rm(stagingPath, { force: true });
    } catch {
      /* keep the original error */
    }
    throw err;
  }
  if (previousMode !== undefined) await fs.chmod(localDest, previousMode);
}

/**
 * Recursive local walk returning posix-style rel paths. Symlinks (file or
 * dir) are collected into `skippedSymlinks` by rel and never transferred:
 * `Dirent.isFile()`/`isDirectory()` both return false for a symlink, so an
 * explicit `isSymbolicLink()` check comes first — otherwise symlinks vanish
 * silently and the confirm count lies. Recurses into directories (caller
 * recreates them on the remote side), and skips `.meta.json` sidecars and
 * anything with `.gangway-` in the name (compare-fresh leftovers must never
 * be pushed). Excluded subtrees are still descended (cheap: no stats) so
 * every file beneath them counts into `excluded` and the confirm dialog
 * stays honest — same convention as walkLocalSyncTree. `skippedSymlinks` is
 * reported separately from `excluded` (pattern hits) so the dialog can name
 * both reasons, and the actual order is: `exclude()` is evaluated for every
 * entry first, then a symlink is recorded in `skippedSymlinks` before any
 * `excluded` counting — so an excluded symlink is still reported as a
 * symlink and never silently folded into `excluded`.
 */
export async function walkMappedLocalFiles(
  localRoot: string,
  exclude: (relPosix: string) => boolean,
): Promise<{ files: Array<{ localPath: string; rel: string }>; excluded: number; skippedSymlinks: string[] }> {
  const files: Array<{ localPath: string; rel: string }> = [];
  const skippedSymlinks: string[] = [];
  let excluded = 0;
  const stack: Array<{ dir: string; excludedBelow: boolean }> = [{ dir: localRoot, excludedBelow: false }];
  while (stack.length > 0) {
    const { dir, excludedBelow } = stack.pop() as { dir: string; excludedBelow: boolean };
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
      const excludedHere = excludedBelow || exclude(rel);
      if (entry.isSymbolicLink()) {
        skippedSymlinks.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        stack.push({ dir: full, excludedBelow: excludedHere });
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith('.meta.json') || entry.name.includes('.gangway-')) continue;
      if (excludedHere) {
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
