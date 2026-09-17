import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpFilePathFor } from '../tmpPath';
import { ensureOwnerOnlyPermissions, writeSidecar } from '../tmpStore';
import type { ConnectionConfig, RemoteStat, SidecarMeta } from '../types';

export interface DownloadClient {
  stat(remotePath: string): Promise<RemoteStat>;
  fastGet(remotePath: string, localPath: string): Promise<unknown>;
}

export interface DownloadResult {
  localPath: string;
  meta: SidecarMeta;
}

export async function downloadFile(
  client: DownloadClient,
  connection: ConnectionConfig,
  remotePath: string,
): Promise<DownloadResult> {
  const remoteStat = await client.stat(remotePath);
  const localPath = tmpFilePathFor(connection, remotePath);
  await fs.mkdir(path.dirname(localPath), { recursive: true });

  // Downloaded into a sibling path, never straight into `localPath`. A
  // re-download (the "discard local edits, refresh from server" gesture)
  // can target a path that already holds a previous, perfectly good copy;
  // writing straight into it meant a transfer that crashed mid-stream left
  // that good copy truncated to whatever partial bytes had arrived. Nothing
  // at `localPath` is touched until the rename below, so a failed transfer
  // leaves the previous file (or no file at all) exactly as it was.
  const downloadingPath = `${localPath}.gangway-downloading`;

  // Pre-create owner-only so the file is never readable by anyone else, not
  // even for the duration of the transfer. `writeSidecar()` also chmods 600,
  // but only after a *successful* download: a transfer that crashed
  // mid-stream used to leave client production data sitting at the default
  // umask mode (typically 0644). fastGet truncates an existing file rather
  // than recreating it, so the mode set here survives the download.
  await fs.writeFile(downloadingPath, '', { mode: 0o600 });
  await ensureOwnerOnlyPermissions(downloadingPath);

  try {
    await client.fastGet(remotePath, downloadingPath);
  } catch (err) {
    await fs.rm(downloadingPath, { force: true });
    throw err;
  }

  // Same-directory rename is atomic on one filesystem, which downloadingPath
  // and localPath always are (siblings under the same per-connection tmp
  // root): the moment `localPath` changes, it is the complete file, never a
  // partial one.
  await fs.rename(downloadingPath, localPath);
  const localStat = await fs.stat(localPath);

  const meta: SidecarMeta = {
    connectionId: connection.id,
    remotePath,
    mtime: remoteStat.mtime,
    size: remoteStat.size,
    downloadedAt: Date.now(),
    localMtimeMs: localStat.mtimeMs,
  };
  await writeSidecar(localPath, meta);

  return { localPath, meta };
}
