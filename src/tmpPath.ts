import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionConfig } from './types';

export function connectionSlug(connection: Pick<ConnectionConfig, 'host' | 'username' | 'port'>): string {
  const key = `${connection.host}:${connection.username}:${connection.port}`;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
}

export function tmpRootFor(connection: Pick<ConnectionConfig, 'host' | 'username' | 'port'>): string {
  return path.join(os.tmpdir(), 'vs-sftp', connectionSlug(connection));
}

/** remotePath must live under connection.remotePath; the relative part is preserved locally. */
export function tmpFilePathFor(connection: ConnectionConfig, remotePath: string): string {
  const relative = path.posix.relative(connection.remotePath, remotePath);
  return path.join(tmpRootFor(connection), relative);
}

export function sidecarPathFor(tmpFilePath: string): string {
  return `${tmpFilePath}.meta.json`;
}
