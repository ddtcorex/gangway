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

/**
 * remotePath must live under connection.remotePath; the relative part is
 * preserved locally.
 *
 * The containment check is defense in depth behind `remoteListing.ts`'s name
 * validation (a hostile server's listing entry is the realistic way an
 * escaping path could ever be built): a tmp file must never be written
 * outside the per-connection root, so an escaping mapping fails loudly here
 * rather than silently writing somewhere else on disk.
 */
export function tmpFilePathFor(connection: ConnectionConfig, remotePath: string): string {
  const root = tmpRootFor(connection);
  const relative = path.posix.relative(connection.remotePath, remotePath);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to map remote path "${remotePath}": it resolves outside this connection's tmp root.`);
  }
  return resolved;
}

export function sidecarPathFor(tmpFilePath: string): string {
  return `${tmpFilePath}.meta.json`;
}
