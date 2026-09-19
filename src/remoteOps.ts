import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectionSlug, sidecarPathFor, tmpFilePathFor } from './tmpPath';
import { readSidecar, writeSidecar } from './tmpStore';
import { isSafeListingName } from './remoteListing';
import { isProbablyBinary } from './folderQueue';
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

/**
 * The minimal surface backupFile needs. SftpClientAdapter and UploadClient
 * both satisfy it; kept narrow so uploadFile.ts does not have to widen its
 * own client contract for one backup call.
 */
export interface BackupClient {
  mkdir(remotePath: string, recursive: boolean): Promise<unknown>;
  fastGet(remotePath: string, localPath: string): Promise<unknown>;
  fastPut(localPath: string, remotePath: string): Promise<unknown>;
}

async function mkdirWithFallback(
  client: Pick<RemoteOpsClient, 'mkdir'>,
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
  client: BackupClient,
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

export interface OpOptions {
  count?: number;
  now?: number;
  onAuditError?: (message: string) => void;
}

async function appendAudit(
  auditLog: AuditLog,
  entry: Parameters<AuditLog['append']>[0],
  what: string,
  onAuditError: (message: string) => void,
): Promise<void> {
  // The audit log is a record of the op, not part of it: a failure to
  // write it is reported on its own channel and never rewrites a success.
  try {
    await auditLog.append(entry);
  } catch (err) {
    onAuditError(
      `${what}, but could not write the audit log entry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Exact, case-sensitive typed confirmation. Dismissed (undefined) means no. */
export function typedConfirmMatches(expected: string, input: string | undefined): boolean {
  return input !== undefined && input === expected;
}

async function existsOnServer(client: RemoteOpsClient, remotePath: string): Promise<boolean> {
  try {
    await client.stat(remotePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Creates a file (zero bytes) or folder. The name is validated, clashes
 * never overwrite, and the audit line carries op 'create'.
 */
export async function createRemote(
  client: RemoteOpsClient,
  connection: ConnectionConfig,
  dirPath: string,
  name: string,
  kind: 'file' | 'dir',
  auditLog: AuditLog,
  options: OpOptions = {},
): Promise<{ path: string }> {
  assertMutatingAllowed(connection);
  assertInsideRoot(connection, dirPath);
  if (!isSafeListingName(name)) throw new Error(`Refusing to create "${name}": illegal file name.`);
  const target = dirPath === '/' ? `/${name}` : `${dirPath}/${name}`;
  assertNotReserved(connection, target);
  if (await existsOnServer(client, target)) {
    throw new Error(`"${target}" already exists on the server.`);
  }
  if (kind === 'dir') {
    await client.mkdir(target, false);
  } else {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gangway-newfile-'));
    const tmp = path.join(dir, 'empty');
    try {
      await fs.writeFile(tmp, '');
      await fs.chmod(tmp, 0o600);
      await client.fastPut(tmp, target);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  const now = options.now ?? Date.now();
  await appendAudit(
    auditLog,
    { connectionId: connection.id, remotePath: target, timestamp: now, op: 'create' },
    `Created ${target}`,
    options.onAuditError ?? noop,
  );
  return { path: target };
}

async function collectLocalFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
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
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && !entry.name.endsWith('.meta.json')) out.push(full);
    }
  }
  return out;
}

/**
 * Moves every sidecar under the renamed tree to the new remote paths
 * (single file or whole folder). Tmp files without sidecars move along;
 * sidecars without tmp files are dropped as stale.
 */
async function remapSidecarsForRename(
  connection: ConnectionConfig,
  oldPath: string,
  newPath: string,
  wasDirectory: boolean,
): Promise<void> {
  const pairs: Array<[string, string]> = [];
  if (wasDirectory) {
    const oldRoot = tmpFilePathFor(connection, oldPath);
    const newRoot = tmpFilePathFor(connection, newPath);
    for (const oldLocal of await collectLocalFiles(oldRoot)) {
      pairs.push([oldLocal, path.join(newRoot, path.relative(oldRoot, oldLocal))]);
    }
  } else {
    pairs.push([tmpFilePathFor(connection, oldPath), tmpFilePathFor(connection, newPath)]);
  }
  for (const [oldLocal, newLocal] of pairs) {
    const sidecar = await readSidecar(oldLocal);
    try {
      await fs.mkdir(path.dirname(newLocal), { recursive: true });
      await fs.rename(oldLocal, newLocal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw err;
    }
    if (sidecar) {
      const newRemote =
        newPath + sidecar.remotePath.slice(oldPath.length);
      await writeSidecar(newLocal, { ...sidecar, remotePath: newRemote });
      await fs.rm(sidecarPathFor(oldLocal), { force: true });
    }
  }
}

/**
 * Renames a file or folder server-side. Name clashes never overwrite,
 * symlink destination parents are refused, and local tmp sidecars follow
 * the rename (whole subtree for folders).
 */
export async function renameRemote(
  client: RemoteOpsClient,
  connection: ConnectionConfig,
  oldPath: string,
  newName: string,
  auditLog: AuditLog,
  options: OpOptions = {},
): Promise<{ newPath: string }> {
  assertMutatingAllowed(connection);
  assertInsideRoot(connection, oldPath);
  assertNotReserved(connection, oldPath);
  if (path.posix.relative(connection.remotePath, oldPath) === '') {
    throw new Error(`Refusing to rename the connection root "${connection.remotePath}" itself.`);
  }
  if (!isSafeListingName(newName)) throw new Error(`Refusing to rename to "${newName}": illegal file name.`);
  const parent = parentDir(oldPath);
  const newPath = joinRoot(parent, newName);
  assertNotReserved(connection, newPath);
  let oldStat: RemoteStat;
  try {
    oldStat = await client.stat(oldPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`"${oldPath}" does not exist on the server.`);
    }
    throw err;
  }
  const parentStat = await client.stat(parent);
  if (parentStat.isSymbolicLink) {
    throw new Error(`Refusing to rename into "${parent}": it is a symlink.`);
  }
  if (await existsOnServer(client, newPath)) {
    throw new Error(`"${newPath}" already exists on the server.`);
  }
  await client.posixRename(oldPath, newPath);
  await remapSidecarsForRename(connection, oldPath, newPath, oldStat.isDirectory);
  const now = options.now ?? Date.now();
  await appendAudit(
    auditLog,
    { connectionId: connection.id, remotePath: newPath, timestamp: now, op: 'rename', note: `${oldPath} -> ${newPath}` },
    `Renamed ${oldPath}`,
    options.onAuditError ?? noop,
  );
  return { newPath };
}

function splitCopyStem(base: string): { stem: string; ext: string } {
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return { stem: base, ext: '' };
  return { stem: base.slice(0, dot), ext: base.slice(dot) };
}

/**
 * Duplicates one file via local staging (SFTP has no server-side copy).
 * Files only: folders get a clear error pointing at download-then-upload.
 * Clashes get numeric suffixes, never overwrites.
 */
export async function duplicateRemote(
  client: RemoteOpsClient,
  connection: ConnectionConfig,
  sourcePath: string,
  auditLog: AuditLog,
  options: OpOptions = {},
): Promise<{ path: string }> {
  assertMutatingAllowed(connection);
  assertInsideRoot(connection, sourcePath);
  assertNotReserved(connection, sourcePath);
  let sourceStat: RemoteStat;
  try {
    sourceStat = await client.stat(sourcePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`"${sourcePath}" does not exist on the server.`);
    }
    throw err;
  }
  if (sourceStat.isDirectory) {
    throw new Error('Duplicating folders is not supported yet — download the folder, then upload it where needed.');
  }
  if (sourceStat.isSymbolicLink) {
    throw new Error(`Refusing to duplicate "${sourcePath}": it is a symlink.`);
  }
  const parent = parentDir(sourcePath);
  const { stem, ext } = splitCopyStem(path.posix.basename(sourcePath));
  let candidate = joinRoot(parent, `${stem} copy${ext}`);
  let n = 2;
  while (await existsOnServer(client, candidate)) {
    if (n > 100) throw new Error(`Too many copies of "${sourcePath}" already exist.`);
    candidate = joinRoot(parent, `${stem} copy-${n}${ext}`);
    n += 1;
  }
  assertNotReserved(connection, candidate);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gangway-duplicate-'));
  const tmp = path.join(dir, 'copy');
  try {
    await client.fastGet(sourcePath, tmp);
    await fs.chmod(tmp, 0o600);
    await client.fastPut(tmp, candidate);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  const now = options.now ?? Date.now();
  await appendAudit(
    auditLog,
    {
      connectionId: connection.id,
      remotePath: candidate,
      timestamp: now,
      byteSize: sourceStat.size,
      op: 'duplicate',
      note: `from ${sourcePath}`,
    },
    `Duplicated ${sourcePath}`,
    options.onAuditError ?? noop,
  );
  return { path: candidate };
}

/**
 * Changes the remote mode. The mode must be 3-4 octal digits; the raw
 * string goes straight to ssh2 (verified: passed through verbatim).
 */
export async function chmodRemote(
  client: RemoteOpsClient,
  connection: ConnectionConfig,
  remotePath: string,
  mode: string,
  auditLog: AuditLog,
  options: OpOptions = {},
): Promise<void> {
  assertMutatingAllowed(connection);
  assertInsideRoot(connection, remotePath);
  assertNotReserved(connection, remotePath);
  if (!/^[0-7]{3,4}$/.test(mode)) {
    throw new Error(`Invalid mode "${mode}": expected 3-4 octal digits (e.g. 644).`);
  }
  try {
    await client.stat(remotePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`"${remotePath}" does not exist on the server.`);
    }
    throw err;
  }
  await client.chmod(remotePath, mode);
  const now = options.now ?? Date.now();
  await appendAudit(
    auditLog,
    { connectionId: connection.id, remotePath, timestamp: now, op: 'chmod', note: `mode ${mode}` },
    `Changed mode of ${remotePath}`,
    options.onAuditError ?? noop,
  );
}

/**
 * Parses a text/uri-list drop payload into local file paths. Only file://
 * entries survive; anything else (https, comments, garbage) is skipped.
 */
export function parseUriList(value: string): string[] {
  const out: string[] = [];
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('file://')) continue;
    try {
      const decoded = decodeURIComponent(trimmed.replace(/^file:\/\/[^/]*/, ''));
      if (!decoded.startsWith('/')) continue;
      out.push(decoded);
    } catch {
      continue;
    }
  }
  return out;
}

export interface DropUpload {
  localPath: string;
  byteSize: number;
  needsPrompt: boolean;
}

const DROP_PROMPT_THRESHOLD_BYTES = 5 * 1024 * 1024;

/**
 * Inspects dropped local paths: missing paths and directories fail fast
 * with a clear message; large or binary files are flagged for one prompt.
 */
export async function collectDropUploads(fsPaths: string[]): Promise<DropUpload[]> {
  const out: DropUpload[] = [];
  for (const localPath of fsPaths) {
    let st: import('node:fs').Stats;
    try {
      st = await fs.stat(localPath);
    } catch {
      throw new Error(`Local file "${localPath}" does not exist.`);
    }
    if (!st.isFile()) {
      throw new Error(`"${localPath}" is not a file — dropping folders is not supported yet.`);
    }
    let needsPrompt = st.size > DROP_PROMPT_THRESHOLD_BYTES;
    if (!needsPrompt) {
      const fh = await fs.open(localPath, 'r');
      try {
        const buffer = Buffer.alloc(8192);
        const { bytesRead } = await fh.read(buffer, 0, 8192, 0);
        needsPrompt = isProbablyBinary(buffer.subarray(0, bytesRead));
      } finally {
        await fh.close();
      }
    }
    out.push({ localPath, byteSize: st.size, needsPrompt });
  }
  return out;
}
