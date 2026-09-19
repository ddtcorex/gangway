import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectionSlug, sidecarPathFor, tmpFilePathFor } from './tmpPath';
import { readSidecar, writeSidecar } from './tmpStore';
import { isSafeListingName } from './remoteListing';
import { isProbablyBinary, TransferCancelledError } from './folderQueue';
import type { AuditLog } from './auditLog';
import type { FileConflictDecision } from './conflictGuard';
import type { ConnectionConfig, RemoteStat, SidecarMeta } from './types';
import type { RawSftpListEntry } from './transfer/sftpClientAdapter';

/** Default recursive-walk excludes (spec §2.3), tuned for Magento/PHP hosting. */
export const DEFAULT_EXCLUDES: readonly string[] = ['.git/**', 'node_modules/**', 'var/**', 'pub/media/**'];

/**
 * Not-found detection across both error dialects: node:fs uses ENOENT while
 * ssh2-sftp-client reports numeric SFTP status codes ('2' = NO_SUCH_FILE,
 * verified against the lib — see errorMapper.ts). Found live 2026-09-19:
 * every trash/inventory/sweep path that checked ENOENT-only broke against
 * the real docker server on the first missing directory.
 */
export function isNotFoundError(err: unknown): boolean {
  const code =
    typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
  if (code === 'ENOENT' || code === '2') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /no such file/i.test(message);
}

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
    // The stamp dir exists, but nested parents under it usually do not (the
    // backup preserves the full relative tree). Found live 2026-09-19: a
    // nested put without this fails and the backup is silently skipped.
    await client.mkdir(path.posix.dirname(backupPath), true).catch(() => {});
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
    if (isNotFoundError(err)) return { removed: 0 };
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
  signal?: AbortSignal;
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
    if (isNotFoundError(err)) return false;
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
      if (isNotFoundError(err)) continue;
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
      if (isNotFoundError(err)) continue;
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
    if (isNotFoundError(err)) {
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
    if (isNotFoundError(err)) {
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
    if (isNotFoundError(err)) {
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

export interface ClipboardState {
  connectionId: string;
  paths: string[];
  cut: boolean;
}

export interface PasteDeps {
  confirmOverwrite(entry: { remotePath: string; stagingPath?: string }): Promise<FileConflictDecision>;
  auditLog: AuditLog;
}

export interface PasteSkip {
  path: string;
  reason: string;
}

export interface PasteResult {
  pasted: string[];
  skipped: PasteSkip[];
}

/**
 * Pastes clipboard entries into destDir (same connection only). New
 * destinations land directly (cut: server-side posixRename, copy: staged
 * fastGet/fastPut); existing destinations go through the overwrite
 * confirmation first. Cut audits op 'move', copy audits op 'duplicate'.
 */
export async function pasteEntries(
  client: RemoteOpsClient,
  connection: ConnectionConfig,
  clipboard: ClipboardState,
  destDir: string,
  deps: PasteDeps,
  options: OpOptions = {},
): Promise<PasteResult> {
  if (clipboard.connectionId !== connection.id) throw new WrongConnectionError();
  assertMutatingAllowed(connection);
  assertInsideRoot(connection, destDir);
  assertNotReserved(connection, destDir);
  let destDirStat: RemoteStat;
  try {
    destDirStat = await client.stat(destDir);
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Error(`"${destDir}" does not exist on the server.`);
    }
    throw err;
  }
  if (destDirStat.isSymbolicLink) {
    throw new Error(`Refusing to paste into "${destDir}": it is a symlink.`);
  }
  const now = options.now ?? Date.now();
  const pasted: string[] = [];
  const skipped: PasteSkip[] = [];
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gangway-paste-'));
  try {
    for (const [index, sourcePath] of clipboard.paths.entries()) {
      if (options.signal?.aborted) throw new TransferCancelledError();
      assertNotReserved(connection, sourcePath);
      const dest = joinRoot(destDir, path.posix.basename(sourcePath));
      assertNotReserved(connection, dest);
      let sourceStat: RemoteStat;
      try {
        sourceStat = await client.stat(sourcePath);
      } catch (err) {
        if (isNotFoundError(err)) {
          skipped.push({ path: sourcePath, reason: 'no longer exists on the server' });
          continue;
        }
        throw err;
      }
      if (sourceStat.isDirectory && !clipboard.cut) {
        skipped.push({ path: sourcePath, reason: 'copying folders is not supported yet' });
        continue;
      }
      if (sourceStat.isSymbolicLink) {
        skipped.push({ path: sourcePath, reason: 'is a symlink' });
        continue;
      }
      const destExists = await existsOnServer(client, dest);
      if (sourceStat.isDirectory && destExists) {
        skipped.push({ path: sourcePath, reason: `merging into existing folder ${dest} is not supported` });
        continue;
      }
      let stagingPath: string | undefined;
      if (!clipboard.cut || destExists) {
        stagingPath = path.join(stagingDir, `${index}-${path.posix.basename(sourcePath)}`);
        await client.fastGet(sourcePath, stagingPath);
        await fs.chmod(stagingPath, 0o600);
      }
      if (destExists) {
        const decision = await deps.confirmOverwrite({ remotePath: dest, stagingPath });
        if (decision !== 'overwrite') {
          skipped.push({ path: sourcePath, reason: `kept the server version of ${dest}` });
          continue;
        }
      }
      if (clipboard.cut) await client.posixRename(sourcePath, dest);
      else await client.fastPut(stagingPath as string, dest);
      pasted.push(dest);
      await appendAudit(
        deps.auditLog,
        {
          connectionId: connection.id,
          remotePath: dest,
          timestamp: now,
          byteSize: sourceStat.size,
          op: clipboard.cut ? 'move' : 'duplicate',
          note: `from ${sourcePath}`,
        },
        `Pasted ${sourcePath}`,
        options.onAuditError ?? noop,
      );
    }
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
  return { pasted, skipped };
}

export interface TrashItem {
  trashPath: string;
  originalPath: string;
  size: number;
}

export interface TrashPick {
  stamp: string;
  trashDir: string;
  items: TrashItem[];
  count: number;
  bytes: number;
  label: string;
  detail: string;
}

async function walkRemoteFiles(
  client: Pick<RemoteOpsClient, 'list'>,
  dir: string,
): Promise<Array<{ path: string; size: number; isDirectory: boolean }>> {
  const out: Array<{ path: string; size: number; isDirectory: boolean }> = [];
  const seen = new Set<string>([dir]);
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: RawSftpListEntry[];
    try {
      entries = await client.list(current);
    } catch (err) {
      if (isNotFoundError(err)) continue;
      throw err;
    }
    for (const entry of entries) {
      if (!isSafeListingName(entry.name)) continue;
      const full = current === '/' ? `/${entry.name}` : `${current}/${entry.name}`;
      // Server listings are attacker-controlled data (see remoteListing.ts):
      // never visit the same directory twice, so a hostile or looping
      // listing cannot turn the walk into unbounded memory growth.
      if (entry.type === 'd') {
        if (!seen.has(full)) {
          seen.add(full);
          stack.push(full);
        }
      } else out.push({ path: full, size: entry.size ?? 0, isDirectory: false });
    }
  }
  return out;
}

/**
 * Lists every trash operation (default sibling root + in-root fallback),
 * newest data first is the caller's formatting choice — here in listing
 * order. Only stamp-shaped directories are inventoried; anything else in
 * the trash roots is left alone.
 */
export async function inventoryTrash(
  client: Pick<RemoteOpsClient, 'list'>,
  connection: ConnectionConfig,
): Promise<TrashPick[]> {
  const roots = [trashRootsFor(connection).dir, `${connection.remotePath}/.trash-gangway`];
  const picks: TrashPick[] = [];
  for (const root of roots) {
    let stamps: RawSftpListEntry[];
    try {
      stamps = await client.list(root);
    } catch (err) {
      if (isNotFoundError(err)) continue;
      throw err;
    }
    for (const stamp of stamps) {
      if (stamp.type !== 'd' || !TRASH_STAMP.test(stamp.name)) continue;
      const stampDir = `${root}/${stamp.name}`;
      const files = await walkRemoteFiles(client, stampDir);
      const items: TrashItem[] = files.map((f) => ({
        trashPath: f.path,
        originalPath: joinRoot(connection.remotePath, path.posix.relative(stampDir, f.path)),
        size: f.size,
      }));
      const bytes = items.reduce((total, item) => total + item.size, 0);
      picks.push({
        stamp: stamp.name,
        trashDir: root,
        items,
        count: items.length,
        bytes,
        label: `${stamp.name} — ${items.length} file(s), ${(bytes / 1024).toFixed(1)} KB`,
        detail: items[0]?.originalPath ?? '(empty operation)',
      });
    }
  }
  return picks;
}

/**
 * Restores trash picks. Each item moves server-side back to its original
 * path (or under the override dir); existing destinations go through the
 * overwrite confirmation with the trashed bytes staged for diff. Always
 * audits op 'restore' — one line per pick with the restored count.
 */
export async function restoreEntries(
  client: RemoteOpsClient,
  connection: ConnectionConfig,
  picks: TrashPick[],
  destDirOverride: string | undefined,
  deps: PasteDeps,
  options: OpOptions = {},
): Promise<{ restored: string[]; skipped: PasteSkip[] }> {
  assertMutatingAllowed(connection);
  let override: string | undefined;
  if (destDirOverride !== undefined) {
    assertInsideRoot(connection, destDirOverride);
    assertNotReserved(connection, destDirOverride);
    const overrideStat = await client.stat(destDirOverride).catch((err) => {
      if (isNotFoundError(err)) {
        throw new Error(`"${destDirOverride}" does not exist on the server.`);
      }
      throw err;
    });
    if (!overrideStat.isDirectory) throw new Error(`"${destDirOverride}" is not a folder.`);
    if (overrideStat.isSymbolicLink) throw new Error(`Refusing to restore into "${destDirOverride}": it is a symlink.`);
    override = destDirOverride;
  }
  const now = options.now ?? Date.now();
  const restored: string[] = [];
  const skipped: PasteSkip[] = [];
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gangway-restore-'));
  try {
    for (const pick of picks) {
      let pickRestored = 0;
      for (const [index, item] of pick.items.entries()) {
        if (options.signal?.aborted) throw new TransferCancelledError();
        const dest = override
          ? joinRoot(override, path.posix.basename(item.originalPath))
          : item.originalPath;
        assertInsideRoot(connection, dest);
        assertNotReserved(connection, dest);
        const parent = parentDir(dest);
        try {
          const parentStat = await client.stat(parent);
          if (parentStat.isSymbolicLink) {
            throw new Error(`Refusing to restore into "${parent}": it is a symlink.`);
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('Refusing to restore into')) throw err;
          if (!isNotFoundError(err)) throw err;
          await client.mkdir(parent, true).catch(() => {});
        }
        if (await existsOnServer(client, dest)) {
          const stagingPath = path.join(stagingDir, `${index}-${path.posix.basename(item.originalPath)}`);
          await client.fastGet(item.trashPath, stagingPath);
          await fs.chmod(stagingPath, 0o600);
          const decision = await deps.confirmOverwrite({ remotePath: dest, stagingPath });
          if (decision !== 'overwrite') {
            skipped.push({ path: item.originalPath, reason: `kept the server version of ${dest}` });
            continue;
          }
        }
        await client.posixRename(item.trashPath, dest);
        restored.push(dest);
        pickRestored += 1;
      }
      await appendAudit(
        deps.auditLog,
        {
          connectionId: connection.id,
          remotePath: pick.items[0]?.originalPath ?? `${pick.trashDir}/${pick.stamp}`,
          timestamp: now,
          op: 'restore',
          count: pickRestored,
        },
        `Restored trash ${pick.stamp}`,
        options.onAuditError ?? noop,
      );
    }
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
  return { restored, skipped };
}

/**
 * Permanently deletes trash picks (stamp dirs wholesale). The single
 * deliberate hard-delete: callers confirm the literal EMPTY TRASH first.
 * One op 'empty-trash' audit line per pick with its file count. No undo.
 */
export async function emptyTrash(
  client: RemoteOpsClient,
  connection: ConnectionConfig,
  picks: TrashPick[],
  auditLog: AuditLog,
  options: OpOptions = {},
): Promise<{ entries: number; files: number }> {
  assertMutatingAllowed(connection);
  const now = options.now ?? Date.now();
  let files = 0;
  for (const pick of picks) {
    if (options.signal?.aborted) throw new TransferCancelledError();
    await removeTrashEntry(client, `${pick.trashDir}/${pick.stamp}`, true);
    files += pick.count;
    await appendAudit(
      auditLog,
      {
        connectionId: connection.id,
        remotePath: `${pick.trashDir}/${pick.stamp}`,
        timestamp: now,
        op: 'empty-trash',
        count: pick.count,
      },
      `Emptied trash ${pick.stamp}`,
      options.onAuditError ?? noop,
    );
  }
  return { entries: picks.length, files };
}
