import fs from 'node:fs/promises';

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
  await fs.writeFile(lockPathFor(localPath), JSON.stringify(owner), 'utf8');
}

export async function releaseEditSession(localPath: string): Promise<void> {
  try {
    await fs.rm(lockPathFor(localPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
