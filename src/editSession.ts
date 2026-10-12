import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readSidecar } from './tmpStore';
import { tmpRootFor } from './tmpPath';
import type { ConnectionConfig } from './types';

/**
 * One VS Code window's extension host is a distinct OS process, so its pid
 * is a reasonable proxy for "an edit session on this machine": two windows
 * downloading the same remote file into the same deterministic tmp path
 * (tmpPath.ts) would otherwise edit it side by side with neither aware of
 * the other, and whichever uploads last silently wins.
 */
export interface EditSessionOwner {
  pid: number;
  startedAt: number;
}

export type SessionCheck = { status: 'ok' } | { status: 'ownedByAnotherLiveSession'; owner: EditSessionOwner };

/**
 * Lock base keyed on the resolved remote file, so a link and its target
 * (opened through different local tmp paths) contend for the same claim.
 * The connection id is part of the key: equal remote paths on two servers
 * are different files.
 */
export function remoteLockBase(tmpRoot: string, connectionId: string, realPath: string): string {
  const key = crypto.createHash('sha1').update(`${connectionId}\0${realPath}`).digest('hex').slice(0, 16);
  return path.join(tmpRoot, '.remote-locks', key);
}

function lockPathFor(localPath: string): string {
  return `${localPath}.gangway-session.json`;
}

function defaultIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    // Signal 0 sends nothing; it only probes whether the process exists and
    // is ours to signal. Throws ESRCH (gone) or EPERM (exists, owned by
    // someone else -- still alive from our point of view).
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLock(localPath: string): Promise<EditSessionOwner | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPathFor(localPath), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as EditSessionOwner).pid === 'number' &&
      typeof (parsed as EditSessionOwner).startedAt === 'number'
    ) {
      return parsed as EditSessionOwner;
    }
    return undefined;
  } catch {
    // A torn/foreign lock file is not a usable claim: treat exactly like no
    // lock at all rather than blocking the user on a file this code cannot
    // even attribute to a real session.
    return undefined;
  }
}

/**
 * A stale lock (its pid is no longer running -- a crashed or force-closed
 * window) is reported 'ok', same as no lock at all: it would otherwise
 * permanently block re-opening a file after the window that last held it
 * went away uncleanly.
 */
export async function checkEditSession(localPath: string, isAlive: (pid: number) => boolean = defaultIsAlive): Promise<SessionCheck> {
  const owner = await readLock(localPath);
  if (!owner || owner.pid === process.pid || !isAlive(owner.pid)) return { status: 'ok' };
  return { status: 'ownedByAnotherLiveSession', owner };
}

export async function acquireEditSession(localPath: string): Promise<void> {
  const owner: EditSessionOwner = { pid: process.pid, startedAt: Date.now() };
  await fs.mkdir(path.dirname(lockPathFor(localPath)), { recursive: true });
  await fs.writeFile(lockPathFor(localPath), JSON.stringify(owner), 'utf8');
}

/**
 * Removes the lock only when it is ours to remove: missing, torn, owned by
 * this process, or owned by a process that is gone. A live lock owned by
 * another window is left alone, otherwise a close event in a window that
 * never claimed the file would disable that window's cross-window warning.
 */
export async function releaseEditSession(localPath: string, isAlive: (pid: number) => boolean = defaultIsAlive): Promise<void> {
  const owner = await readLock(localPath);
  if (owner && owner.pid !== process.pid && isAlive(owner.pid)) return;
  try {
    await fs.rm(lockPathFor(localPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Remote lock base for a tmp file, from its sidecar. Locking must never
 * block opening, so any sidecar read problem (EACCES, EISDIR) or an unknown
 * connection yields undefined and only the local-path lock applies.
 */
export async function remoteBaseForSidecar(
  localPath: string,
  connections: readonly ConnectionConfig[],
): Promise<string | undefined> {
  try {
    const sidecar = await readSidecar(localPath);
    if (!sidecar) return undefined;
    const connection = connections.find((c) => c.id === sidecar.connectionId);
    if (!connection) return undefined;
    return remoteLockBase(tmpRootFor(connection), sidecar.connectionId, sidecar.realPath ?? sidecar.remotePath);
  } catch {
    return undefined;
  }
}

/**
 * Per-window record of which open documents hold which remote lock, kept in
 * memory so the base is fixed at open time. A link tab and its target tab
 * share one remote lock; it is dropped only when the last of them closes.
 * A set (not a counter) because reopening an already-open document does not
 * fire a second close.
 */
export class EditLockRegistry {
  private readonly bases = new Map<string, string>();
  private readonly holders = new Map<string, Set<string>>();
  private readonly isAlive: (pid: number) => boolean;

  constructor(options: { isAlive?: (pid: number) => boolean } = {}) {
    this.isAlive = options.isAlive ?? defaultIsAlive;
  }

  async claim(localPath: string, remoteBase: string | undefined): Promise<void> {
    await acquireEditSession(localPath);
    if (!remoteBase) return;
    await acquireEditSession(remoteBase);
    this.bases.set(localPath, remoteBase);
    let set = this.holders.get(remoteBase);
    if (!set) this.holders.set(remoteBase, (set = new Set()));
    set.add(localPath);
  }

  async release(localPath: string): Promise<void> {
    await releaseEditSession(localPath, this.isAlive);
    const remoteBase = this.bases.get(localPath);
    if (!remoteBase) return;
    this.bases.delete(localPath);
    const set = this.holders.get(remoteBase);
    set?.delete(localPath);
    if (set && set.size === 0) {
      this.holders.delete(remoteBase);
      await releaseEditSession(remoteBase, this.isAlive);
    }
  }
}
