import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isLexicallyInside, isNotFoundError } from './remotePathUtils';

export { isLexicallyInside, isNotFoundError };
import { sidecarPathFor, tmpFilePathFor } from './tmpPath';
import { readSidecar, writeSidecar } from './tmpStore';
import { isSafeListingName } from './remoteListing';
import { TransferCancelledError } from './folderQueue';
import { gateWriteTarget, resolveTarget, type ResolvedTarget } from './realTarget';
import type { AuditLog } from './auditLog';
import type { FileConflictDecision } from './conflictGuard';
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
  /** Follows links, like the library's stat. */
  stat(remotePath: string): Promise<RemoteStat>;
  /** Does not follow the last path component: the only way to see a link itself. */
  lstat(remotePath: string): Promise<RemoteStat>;
  /** Canonical path; undefined when the path does not exist. */
  realPath(remotePath: string): Promise<string | undefined>;
  chmod(remotePath: string, mode: string): Promise<unknown>;
  list(remotePath: string): Promise<RawSftpListEntry[]>;
}

/** Throws FrozenError when the connection is frozen. Every mutating op calls this first. */
export function assertMutatingAllowed(connection: ConnectionConfig): void {
  if (connection.frozen === true) throw new FrozenError(connection.name);
}

/** Throws when remotePath escapes the connection root. Message matches /outside/. */
export function assertInsideRoot(connection: ConnectionConfig, remotePath: string): void {
  if (!isLexicallyInside(connection.remotePath, remotePath)) {
    throw new Error(
      `Refusing to operate on "${remotePath}": it resolves outside the connection root "${connection.remotePath}".`,
    );
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

export function parentDir(remotePath: string): string {
  const normalized = remotePath.endsWith('/') && remotePath.length > 1 ? remotePath.slice(0, -1) : remotePath;
  const idx = normalized.lastIndexOf('/');
  return idx <= 0 ? '/' : normalized.slice(0, idx);
}

export function joinRoot(parent: string, leaf: string): string {
  return parent === '/' ? `/${leaf}` : `${parent}/${leaf}`;
}

export interface OpOptions {
  count?: number;
  now?: number;
  onAuditError?: (message: string) => void;
  signal?: AbortSignal;
  /**
   * Asked once per operation when the real target lives outside the
   * connection root. Absent means no UI is available: the op is refused.
   * realPath is the first out-of-root real path; allRealPaths lists every
   * distinct one in the operation (first element equals realPath), so a
   * prompt can name them all. Callers may ignore the second argument.
   */
  confirmOutsideRoot?: (realPath: string, allRealPaths: readonly string[]) => Promise<boolean>;
}

/** The user declined writing outside the root. A cancellation, not a failure. */
export class OutsideRootDeclinedError extends TransferCancelledError {
  constructor(remotePath: string, realPath: string) {
    super();
    this.message = `Cancelled: "${remotePath}" is really "${realPath}", outside the connection root.`;
    this.name = 'OutsideRootDeclinedError';
  }
}

/**
 * The shared write gate for every mutating op on a remote path: freeze
 * first, then resolve the real target (fails closed on broken links, loops
 * and transport errors), then the out-of-root decision. A frozen connection
 * never reaches the server; an out-of-root target needs an explicit yes from
 * options.confirmOutsideRoot, and no callback means no.
 */
export async function assertWritableTarget(
  client: RemoteOpsClient,
  connection: ConnectionConfig,
  remotePath: string,
  options: OpOptions,
): Promise<ResolvedTarget> {
  const [target] = await assertWritableTargets(client, connection, [remotePath], options);
  return target;
}

/**
 * assertWritableTarget for every path an operation touches, asking at most
 * once: all paths are resolved first (nothing is read or written yet), then
 * the first out-of-root one is blocked on a frozen connection or confirmed
 * by the user, and that one answer covers the whole operation.
 */
export async function assertWritableTargets(
  client: RemoteOpsClient,
  connection: ConnectionConfig,
  remotePaths: string[],
  options: OpOptions,
): Promise<ResolvedTarget[]> {
  assertMutatingAllowed(connection);
  const targets: ResolvedTarget[] = [];
  for (const remotePath of remotePaths) targets.push(await resolveTarget(client, connection, remotePath));
  const outside = targets.find((t) => gateWriteTarget(connection, t) !== 'allow');
  if (outside === undefined) return targets;
  if (gateWriteTarget(connection, outside) === 'block') {
    throw new Error(
      `Refusing to use "${outside.clickedPath}": it is really "${outside.realPath}", outside the root of frozen connection "${connection.name}".`,
    );
  }
  if (!options.confirmOutsideRoot) {
    throw new Error(
      `Refusing to use "${outside.clickedPath}": it is really "${outside.realPath}", outside the connection root "${connection.remotePath}".`,
    );
  }
  const allRealPaths = [
    ...new Set(targets.filter((t) => gateWriteTarget(connection, t) !== 'allow').map((t) => t.realPath)),
  ];
  if (!(await options.confirmOutsideRoot(outside.realPath, allRealPaths))) {
    throw new OutsideRootDeclinedError(outside.clickedPath, outside.realPath);
  }
  return targets;
}

/** How a delete must act on an entry. Any symlink is unlinked, never recursed through. */
export function chooseDeleteMode(entry: { isDirectory: boolean; isSymbolicLink: boolean }): 'file' | 'folder' | 'link' {
  if (entry.isSymbolicLink) return 'link';
  return entry.isDirectory ? 'folder' : 'file';
}

/** True when remotePath exists and is itself a symlink. Missing means false; other errors reject. */
async function isLinkItself(client: RemoteOpsClient, remotePath: string): Promise<boolean> {
  try {
    return (await client.lstat(remotePath)).isSymbolicLink;
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
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

/**
 * Whether any entry holds this name. lstat, not stat: stat follows links, so
 * a dangling link would read as a free name and a later put would write
 * through it (create/truncate follows the link) or a rename would replace it.
 */
async function existsOnServer(client: RemoteOpsClient, remotePath: string): Promise<boolean> {
  try {
    await client.lstat(remotePath);
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
  const dir = await assertWritableTarget(client, connection, dirPath, options);
  const created = joinRoot(dirPath, name);
  // Written into the resolved directory, so the gate decision and the write agree.
  const target = joinRoot(dir.realPath, name);
  if (await existsOnServer(client, target)) {
    throw new Error(`"${created}" already exists on the server.`);
  }
  if (kind === 'dir') {
    await client.mkdir(target, false);
  } else {
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gangway-newfile-'));
    const tmp = path.join(stagingDir, 'empty');
    try {
      await fs.writeFile(tmp, '');
      await fs.chmod(tmp, 0o600);
      await client.fastPut(tmp, target);
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  const now = options.now ?? Date.now();
  await appendAudit(
    auditLog,
    {
      connectionId: connection.id,
      remotePath: created,
      timestamp: now,
      op: 'create',
      ...(dir.viaLink ? { note: `really ${target}` } : {}),
    },
    `Created ${created}`,
    options.onAuditError ?? noop,
  );
  return { path: created };
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
 * Renames a file or folder server-side. The entry itself is renamed (a link
 * stays a link); its parent is resolved and gated, and both paths are built
 * on the resolved parent so the rename lands where the gate decided. Name
 * clashes never overwrite, and local tmp sidecars follow the rename (whole
 * subtree for folders), keyed on the clicked paths.
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
  if (path.posix.relative(connection.remotePath, oldPath) === '') {
    throw new Error(`Refusing to rename the connection root "${connection.remotePath}" itself.`);
  }
  if (!isSafeListingName(newName)) throw new Error(`Refusing to rename to "${newName}": illegal file name.`);
  const parent = parentDir(oldPath);
  const newPath = joinRoot(parent, newName);
  // lstat: rename acts on the entry itself, so a dangling link can be renamed.
  let oldEntry: RemoteStat;
  try {
    oldEntry = await client.lstat(oldPath);
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Error(`"${oldPath}" does not exist on the server.`);
    }
    throw err;
  }
  // The local tmp mirror of a link to a folder is a folder (the tree
  // expands it), so sidecars move as a subtree; a dangling link has none.
  let wasDirectory = oldEntry.isDirectory;
  if (oldEntry.isSymbolicLink) {
    try {
      wasDirectory = (await client.stat(oldPath)).isDirectory;
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  }
  const realParent = (await assertWritableTarget(client, connection, parent, options)).realPath;
  const realOld = joinRoot(realParent, path.posix.basename(oldPath));
  const realNew = joinRoot(realParent, newName);
  if (await existsOnServer(client, realNew)) {
    throw new Error(`"${newPath}" already exists on the server.`);
  }
  await client.posixRename(realOld, realNew);
  await remapSidecarsForRename(connection, oldPath, newPath, wasDirectory);
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
 * Files only: folders get a clear error pointing at download-then-upload,
 * and a link to a folder is refused (no recursion). A file link is read
 * through, so the copy is a regular file holding the target content. The
 * destination directory goes through the write gate. Clashes get numeric
 * suffixes, never overwrites.
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
  let sourceStat: RemoteStat;
  let sourceIsLink: boolean;
  try {
    sourceStat = await client.stat(sourcePath);
    sourceIsLink = (await client.lstat(sourcePath)).isSymbolicLink;
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Error(`"${sourcePath}" does not exist on the server.`);
    }
    throw err;
  }
  if (sourceIsLink && sourceStat.isDirectory) {
    throw new Error(`Refusing to duplicate "${sourcePath}": it is a link to a folder, and folders are never copied through a link.`);
  }
  if (sourceStat.isDirectory) {
    throw new Error('Duplicating folders is not supported yet — download the folder, then upload it where needed.');
  }
  const parent = parentDir(sourcePath);
  // The source is gated too: reading an out-of-root target into the root is
  // an exfiltration path. One answer covers source and destination.
  const [sourceTarget, parentTarget] = await assertWritableTargets(client, connection, [sourcePath, parent], options);
  const realParent = parentTarget.realPath;
  const { stem, ext } = splitCopyStem(path.posix.basename(sourcePath));
  let leaf = `${stem} copy${ext}`;
  let n = 2;
  while (await existsOnServer(client, joinRoot(realParent, leaf))) {
    if (n > 100) throw new Error(`Too many copies of "${sourcePath}" already exist.`);
    leaf = `${stem} copy-${n}${ext}`;
    n += 1;
  }
  const candidate = joinRoot(parent, leaf);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gangway-duplicate-'));
  const tmp = path.join(dir, 'copy');
  try {
    // fastGet follows a file link, so the staged bytes are the target content.
    await client.fastGet(sourceTarget.realPath, tmp);
    await fs.chmod(tmp, 0o600);
    await client.fastPut(tmp, joinRoot(realParent, leaf));
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
 * string goes straight to ssh2 (verified: passed through verbatim). SFTP
 * setstat follows links, so the mode lands on the real target, which goes
 * through the write gate first.
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
  const target = await assertWritableTarget(client, connection, remotePath, options);
  await client.chmod(target.realPath, mode);
  const now = options.now ?? Date.now();
  await appendAudit(
    auditLog,
    { connectionId: connection.id, remotePath, timestamp: now, op: 'chmod', note: `mode ${mode}` },
    `Changed mode of ${remotePath}`,
    options.onAuditError ?? noop,
  );
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
 * Pastes clipboard entries into destDir (same connection only). destDir and
 * every source that is not itself a link go through the write gate before
 * anything is read or written, asking at most once per operation: a cut
 * removes the source from its real directory and a copy reads the source's
 * real target, so either can reach outside the root. Entries are read and
 * moved at their real paths and land in the resolved destDir. New destinations land directly (cut: server-side
 * posixRename, copy: staged fastGet/fastPut); existing destinations go
 * through the overwrite confirmation first. A source or destination that
 * is itself a link is skipped: a rename onto a link replaces it and a put
 * writes through it. Cut audits op 'move', copy audits op 'duplicate'.
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
  // Link sources are skipped below, so they are not gated (no prompt for an
  // entry that will never be touched).
  const gatedSources: string[] = [];
  for (const sourcePath of clipboard.paths) {
    if (!(await isLinkItself(client, sourcePath))) gatedSources.push(sourcePath);
  }
  const [destTarget, ...sourceTargets] = await assertWritableTargets(
    client,
    connection,
    [destDir, ...gatedSources],
    options,
  );
  const realDestDir = destTarget.realPath;
  const realSourceOf = new Map(gatedSources.map((p, i) => [p, sourceTargets[i].realPath]));
  try {
    await client.stat(realDestDir);
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Error(`"${destDir}" does not exist on the server.`);
    }
    throw err;
  }
  const now = options.now ?? Date.now();
  const pasted: string[] = [];
  const skipped: PasteSkip[] = [];
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gangway-paste-'));
  try {
    for (const [index, sourcePath] of clipboard.paths.entries()) {
      if (options.signal?.aborted) throw new TransferCancelledError();
      const dest = joinRoot(realDestDir, path.posix.basename(sourcePath));
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
      const realSource = realSourceOf.get(sourcePath);
      if (realSource === undefined || (await isLinkItself(client, sourcePath))) {
        skipped.push({ path: sourcePath, reason: 'is a symlink' });
        continue;
      }
      if (await isLinkItself(client, dest)) {
        skipped.push({ path: sourcePath, reason: `destination ${dest} is a symlink and is never replaced or written through` });
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
        await client.fastGet(realSource, stagingPath);
        await fs.chmod(stagingPath, 0o600);
      }
      if (destExists) {
        const decision = await deps.confirmOverwrite({ remotePath: dest, stagingPath });
        if (decision !== 'overwrite') {
          skipped.push({ path: sourcePath, reason: `kept the server version of ${dest}` });
          continue;
        }
      }
      if (clipboard.cut) await client.posixRename(realSource, dest);
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
