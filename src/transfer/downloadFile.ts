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

  // Pre-create owner-only so the file is never readable by anyone else, not
  // even for the duration of the transfer. `writeSidecar()` also chmods 600,
  // but only after a *successful* download: a transfer that crashed
  // mid-stream used to leave client production data sitting at the default
  // umask mode (typically 0644). fastGet truncates an existing file rather
  // than recreating it, so the mode set here survives the download.
  await fs.writeFile(localPath, '', { mode: 0o600 });
  await ensureOwnerOnlyPermissions(localPath);

  await client.fastGet(remotePath, localPath);

  const meta: SidecarMeta = {
    connectionId: connection.id,
    remotePath,
    mtime: remoteStat.mtime,
    size: remoteStat.size,
    downloadedAt: Date.now(),
  };
  await writeSidecar(localPath, meta);

  return { localPath, meta };
}
