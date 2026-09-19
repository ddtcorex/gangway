import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectionSlug } from './tmpPath';
import type { AuditLog } from './auditLog';
import type { ConnectionConfig, RemoteStat, SidecarMeta } from './types';
import type { RawSftpListEntry } from './transfer/sftpClientAdapter';

/** Default recursive-walk excludes (spec §2.3), tuned for Magento/PHP hosting. */
export const DEFAULT_EXCLUDES: readonly string[] = ['.git/**', 'node_modules/**', 'var/**', 'pub/media/**'];

const noop = (): void => {};

export class FrozenError extends Error {
  constructor(connectionName: string) {
    super(`Connection "${connectionName}" is frozen. Run "Gangway: Toggle Freeze" to unlock it.`);
    this.name = 'FrozenError';
  }
}

export class WrongServerError extends Error {
  constructor(localPath: string, expectedName: string) {
    super(
      `${localPath} belongs to a different connection than "${expectedName}". Bind that connection to this workspace before continuing.`,
    );
    this.name = 'WrongServerError';
  }
}

export class WrongConnectionError extends Error {
  constructor() {
    super('Clipboard entries belong to a different connection than the paste target.');
    this.name = 'WrongConnectionError';
  }
}

/**
 * The client surface remoteOps needs. SftpClientAdapter satisfies it in
 * production; tests use structural fakes. Mirrors the UploadClient split:
 * one capability per method, no whole-client casts at call sites.
 */
export interface RemoteOpsClient {
  mkdir(remotePath: string, recursive: boolean): Promise<unknown>;
  posixRename(fromPath: string, toPath: string): Promise<unknown>;
  delete(remotePath: string): Promise<unknown>;
  rmdir(remotePath: string, recursive: boolean): Promise<unknown>;
  fastGet(remotePath: string, localPath: string): Promise<unknown>;
  fastPut(localPath: string, remotePath: string): Promise<unknown>;
  stat(remotePath: string): Promise<RemoteStat>;
  chmod(remotePath: string, mode: string): Promise<unknown>;
  list(remotePath: string): Promise<RawSftpListEntry[]>;
}

/** Throws FrozenError when the connection is frozen. Every mutating op calls this first. */
export function assertMutatingAllowed(connection: ConnectionConfig): void {
  if (connection.frozen === true) throw new FrozenError(connection.name);
}

/** Throws when remotePath escapes the connection root. Message matches /outside/. */
export function assertInsideRoot(connection: ConnectionConfig, remotePath: string): void {
  const relative = path.posix.relative(connection.remotePath, remotePath);
  if (relative === '..' || relative.startsWith(`..${path.posix.sep}`) || path.posix.isAbsolute(relative)) {
    throw new Error(
      `Refusing to operate on "${remotePath}": it resolves outside the connection root "${connection.remotePath}".`,
    );
  }
}

function reservedDirs(connection: ConnectionConfig): { trash: string[]; backup: string[] } {
  return {
    trash: [trashRootsFor(connection).dir, `${connection.remotePath}/.trash-gangway`],
    backup: [backupRootsFor(connection).dir, `${connection.remotePath}/.backup-gangway`],
  };
}

/** Throws when remotePath targets Gangway's own trash/backup storage. Message matches /reserved/. */
export function assertNotReserved(connection: ConnectionConfig, remotePath: string): void {
  const { trash, backup } = reservedDirs(connection);
  for (const dir of [...trash, ...backup]) {
    if (remotePath === dir || remotePath.startsWith(`${dir}/`)) {
      throw new Error(`Refusing to operate on "${remotePath}": it is inside Gangway's reserved storage directory.`);
    }
  }
}

/**
 * Wrong-server guard for uploads: a sidecar naming another connection stops
 * the push before any network call, then the frozen check runs. Order is
 * fixed (wrong-server first) and pinned by test.
 */
export function guardUploadTarget(connection: ConnectionConfig, sidecar: SidecarMeta | undefined): void {
  if (sidecar && sidecar.connectionId !== connection.id) {
    throw new WrongServerError(sidecar.remotePath, connection.name);
  }
  assertMutatingAllowed(connection);
}

function parentDir(remotePath: string): string {
  const normalized = remotePath.endsWith('/') && remotePath.length > 1 ? remotePath.slice(0, -1) : remotePath;
  const idx = normalized.lastIndexOf('/');
  return idx <= 0 ? '/' : normalized.slice(0, idx);
}

function joinRoot(parent: string, leaf: string): string {
  return parent === '/' ? `/${leaf}` : `${parent}/${leaf}`;
}

export interface TrashRoots {
  dir: string;
  inRootFallback: boolean;
}

/** Sibling of remotePath by default (never inside the docroot). Slug is connectionSlug(). */
export function trashRootsFor(connection: ConnectionConfig): TrashRoots {
  return {
    dir: joinRoot(parentDir(connection.remotePath), `.gangway-trash-${connectionSlug(connection)}`),
    inRootFallback: false,
  };
}

/** Sibling of remotePath by default (never inside the docroot). Slug is connectionSlug(). */
export function backupRootsFor(connection: ConnectionConfig): TrashRoots {
  return {
    dir: joinRoot(parentDir(connection.remotePath), `.gangway-backup-${connectionSlug(connection)}`),
    inRootFallback: false,
  };
}

function opStamp(now: number): string {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const random = Math.random().toString(36).slice(2, 8);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${random}`
  );
}

async function mkdirWithFallback(
  client: RemoteOpsClient,
  primaryDir: string,
  fallbackDir: string,
): Promise<TrashRoots> {
  try {
    await client.mkdir(primaryDir, true);
    return { dir: primaryDir, inRootFallback: false };
  } catch {
    await client.mkdir(fallbackDir, true);
    return { dir: fallbackDir, inRootFallback: true };
  }
}

/**
 * Delete = move-to-trash, never a hard delete. Server-side posixRename, so
 * no bytes cross the wire. Trashing the connection root itself is refused.
 * The fallback retry (sibling unwritable → in-root) is owned here and noted
 * on the audit line, so callers never branch on placement.
 */
export async function moveToTrash(
  client: RemoteOpsClient,
  connection: ConnectionConfig,
  remotePath: string,
  auditLog: AuditLog,
  options: { count?: number; now?: number; onAuditError?: (message: string) => void } = {},
): Promise<{ trashPath: string }> {
  assertInsideRoot(connection, remotePath);
  assertNotReserved(connection, remotePath);
  assertMutatingAllowed(connection);
  const relative = path.posix.relative(connection.remotePath, remotePath);
  if (relative === '') {
    throw new Error(`Refusing to trash the connection root "${connection.remotePath}" itself.`);
  }
  const now = options.now ?? Date.now();
  const stamp = opStamp(now);
  const primary = trashRootsFor(connection);
  const roots = await mkdirWithFallback(
    client,
    `${primary.dir}/${stamp}`,
    `${connection.remotePath}/.trash-gangway/${stamp}`,
  );
  const trashPath = `${roots.dir}/${relative}`;
  await client.mkdir(path.posix.dirname(trashPath), true);
  await client.posixRename(remotePath, trashPath);
  try {
    await auditLog.append({
      connectionId: connection.id,
      remotePath,
      timestamp: now,
      op: 'delete',
      ...(options.count !== undefined ? { count: options.count } : {}),
      ...(roots.inRootFallback ? { note: 'in-root-fallback' } : {}),
    });
  } catch (err) {
    (options.onAuditError ?? noop)(
      `Moved ${remotePath} to trash, but could not write the audit log entry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { trashPath };
}

export interface BackupStaging {
  stage(_remotePath: string): Promise<string>;
  cleanup(stagePath: string): Promise<void>;
}

/** Local staging for server-side backup copies (SFTP has no copy primitive). chmod 600, always cleaned up. */
export function defaultBackupStaging(): BackupStaging {
  return {
    stage: async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gangway-backup-'));
      return path.join(dir, 'original');
    },
    cleanup: async (stagePath) => {
      await fs.rm(path.dirname(stagePath), { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * Copies the current server file into the backup dir (fastGet to local
 * staging, fastPut to the backup path). Emits no audit line of its own:
 * the caller's op line (e.g. upload) covers it.
 */
export async function backupFile(
  client: RemoteOpsClient,
  connection: ConnectionConfig,
  remotePath: string,
  staging: BackupStaging = defaultBackupStaging(),
  now: number = Date.now(),
): Promise<{ backupPath: string }> {
  assertInsideRoot(connection, remotePath);
  assertNotReserved(connection, remotePath);
  const relative = path.posix.relative(connection.remotePath, remotePath);
  const primary = backupRootsFor(connection);
  const roots = await mkdirWithFallback(
    client,
    `${primary.dir}/${opStamp(now)}`,
    `${connection.remotePath}/.backup-gangway/${opStamp(now)}`,
  );
  const backupPath = `${roots.dir}/${relative}`;
  const stagePath = await staging.stage(remotePath);
  try {
    await client.fastGet(remotePath, stagePath);
    await fs.chmod(stagePath, 0o600);
    await client.fastPut(stagePath, backupPath);
  } finally {
    await staging.cleanup(stagePath).catch(() => {});
  }
  return { backupPath };
}

/** Removes one trash entry: files via delete, dirs via recursive rmdir. */
export async function removeTrashEntry(
  client: RemoteOpsClient,
  trashPath: string,
  isDirectory: boolean,
): Promise<void> {
  if (isDirectory) await client.rmdir(trashPath, true);
  else await client.delete(trashPath);
}

const TRASH_STAMP = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/;

function stampAgeMs(name: string, now: number): number | undefined {
  const match = TRASH_STAMP.exec(name);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const time = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return now - time;
}

/**
 * Retention sweep for one trash/backup root: removes entries older than
 * olderThanMs. Unparseable names are kept (never delete the unknown); a
 * missing root (ENOENT) returns quietly.
 */
export async function sweepOldRemoteDirs(
  client: RemoteOpsClient,
  dir: string,
  olderThanMs: number,
  now: number = Date.now(),
): Promise<{ removed: number }> {
  let entries: RawSftpListEntry[];
  try {
    entries = await client.list(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0 };
    throw err;
  }
  let removed = 0;
  for (const entry of entries) {
    const age = stampAgeMs(entry.name, now);
    if (age === undefined || age <= olderThanMs) continue;
    await removeTrashEntry(client, `${dir}/${entry.name}`, entry.type === 'd');
    removed += 1;
  }
  return { removed };
}
