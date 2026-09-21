import fs from 'node:fs/promises';
import path from 'node:path';

import type { ConnectionConfig } from '../types';
import { tmpFilePathFor } from '../tmpPath';
import { ensureOwnerOnlyPermissions } from '../tmpStore';

/**
 * Staging path for the workspace-compare flow: the server's fresh bytes are
 * downloaded next to (never over) the connection's tmp mirror, then shown as
 * the right side of `vscode.diff`. Reuses `tmpFilePathFor`'s containment
 * check, so an escaping remote path fails loudly here instead of writing
 * outside the per-connection tmp root. The suffix keeps the staging file
 * apart from the real tmp mirror and lets `tmpRetention`'s 7-day purge
 * collect it -- the diff stays valid on revisit because nothing deletes it
 * right after opening.
 */
export function stagingPathForWorkspaceCompare(connection: ConnectionConfig, remotePath: string): string {
  return `${tmpFilePathFor(connection, remotePath)}.gangway-compare-workspace`;
}

/** The narrow client surface the compare fetch needs (mirrors `DownloadClient`). */
export interface CompareFetchClient {
  fastGet(remotePath: string, localPath: string): Promise<unknown>;
}

/**
 * Downloads the server's fresh bytes for one compare. Same shape as
 * `transfer/downloadFile.ts`, minus the sidecar (a staging file is not a tmp
 * mirror): pre-created owner-only, transferred into a `.gangway-downloading`
 * sibling, then atomically renamed. `fastGet` truncates an existing file
 * rather than recreating it, so writing straight onto the revisit-kept
 * staging path would leave a truncated corrupt copy after a failed second
 * compare -- nothing at the staging path is touched until the rename, and a
 * failed transfer removes the sibling and rethrows. The staging file keeps
 * its 600 mode across renames (fastGet truncates, never recreates), and the
 * 7-day tmp purge ages it off its own mtime since no sidecar is written.
 */
export async function fetchServerCopyForCompare(
  client: CompareFetchClient,
  connection: ConnectionConfig,
  remotePath: string,
): Promise<string> {
  const stagingPath = stagingPathForWorkspaceCompare(connection, remotePath);
  await fs.mkdir(path.dirname(stagingPath), { recursive: true });
  const downloadingPath = `${stagingPath}.gangway-downloading`;
  await fs.writeFile(downloadingPath, '', { mode: 0o600 });
  await ensureOwnerOnlyPermissions(downloadingPath);
  try {
    await client.fastGet(remotePath, downloadingPath);
  } catch (err) {
    await fs.rm(downloadingPath, { force: true });
    throw err;
  }
  await fs.rename(downloadingPath, stagingPath);
  return stagingPath;
}

/** `app.php: workspace ↔ server (current)` -- names both sides of the diff. */
export function diffTitleForWorkspaceCompare(remotePath: string): string {
  return `${path.posix.basename(remotePath)}: workspace ↔ server (current)`;
}
