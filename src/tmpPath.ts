import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionConfig } from './types';

/**
 * The slug scopes one connection's tmp root. It hashes host + user + port +
 * remotePath: two connections to the SAME server but different remote roots
 * (staging vs prod on one box -- the standard govard layout) must never
 * share a tmp tree, or /srv/staging/x.php and /srv/prod/x.php would map to
 * the same local file and take turns overwriting each other's sidecars.
 */
export function connectionSlug(
  connection: Pick<ConnectionConfig, 'host' | 'username' | 'port' | 'remotePath'>,
): string {
  const key = `${connection.host}:${connection.username}:${connection.port}:${connection.remotePath}`;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
}

export function tmpRootFor(
  connection: Pick<ConnectionConfig, 'host' | 'username' | 'port' | 'remotePath'>,
): string {
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
