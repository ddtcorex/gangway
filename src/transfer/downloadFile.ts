import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpFilePathFor } from '../tmpPath';
import { writeSidecar } from '../tmpStore';
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
