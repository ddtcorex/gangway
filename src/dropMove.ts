import path from 'node:path';
import { TransferCancelledError } from './folderQueue';
import {
  assertInsideRoot,
  assertMutatingAllowed,
  existsOnServer,
  joinRoot,
  pasteEntries,
  type OpOptions,
  type PasteDeps,
  type PasteResult,
  type PasteSkip,
  type RemoteOpsClient,
} from './remoteOps';
import { isLexicallyInside } from './remotePathUtils';
import type { ConnectionConfig } from './types';

const INTO_ITSELF = 'cannot move a folder into itself';

/** The server's canonical path, or undefined when it cannot be had (never throws). */
async function realPathOrUndefined(client: RemoteOpsClient, remotePath: string): Promise<string | undefined> {
  try {
    const real = await client.realPath(remotePath);
    return real === '' ? undefined : real;
  } catch {
    return undefined;
  }
}

async function isLink(client: RemoteOpsClient, remotePath: string): Promise<boolean> {
  try {
    return (await client.lstat(remotePath)).isSymbolicLink === true;
  } catch {
    return false;
  }
}

/**
 * Filters a dropped batch before anything touches the server. A source already
 * in the destination folder is dropped silently (a no-op move). A source that
 * is the destination or an ancestor of it is skipped with a reason, judged on
 * the clicked paths and again on the real ones so a link inside the source
 * that leads back into it cannot slip past. Link sources are left in the
 * batch: pasteEntries skips them with its own reason.
 */
export async function planDropMove(
  client: RemoteOpsClient,
  _connection: ConnectionConfig,
  sources: readonly string[],
  destDir: string,
): Promise<{ movable: string[]; skipped: PasteSkip[] }> {
  const movable: string[] = [];
  const skipped: PasteSkip[] = [];
  if (sources.length === 0) return { movable, skipped };
  const realDest = await realPathOrUndefined(client, destDir);
  for (const source of sources) {
    if (path.posix.dirname(source) === destDir) continue;
    if (source === destDir || isLexicallyInside(source, destDir)) {
      skipped.push({ path: source, reason: INTO_ITSELF });
      continue;
    }
    if (realDest !== undefined && !(await isLink(client, source))) {
      const realSource = await realPathOrUndefined(client, source);
      if (realSource !== undefined) {
        if (path.posix.dirname(realSource) === realDest) continue;
        if (isLexicallyInside(realSource, realDest)) {
          skipped.push({ path: source, reason: INTO_ITSELF });
          continue;
        }
      }
    }
    movable.push(source);
  }
  return { movable, skipped };
}

export type DropConflictChoice = 'review' | 'skip' | 'cancel';

export interface DropMoveDeps extends PasteDeps {
  /** Asked once when two or more dropped items already exist at the destination. */
  chooseConflictPolicy(conflicting: readonly string[]): Promise<DropConflictChoice>;
}

/**
 * Moves dropped entries into destDir through pasteEntries (cut semantics), so
 * every gate, link rule and audit line of cut and paste applies unchanged.
 * Before that: the plan filters no-ops and folder-into-itself, then the
 * destination is scanned. One conflict goes to the per-file overwrite flow;
 * two or more ask once (review each, skip them, cancel everything). There is
 * deliberately no overwrite-all choice: a drop is a low-intent gesture and an
 * overwrite has no server-side undo. Skipped items are removed up front, so
 * their sources are never downloaded for a diff.
 */
export async function moveByDrop(
  client: RemoteOpsClient,
  connection: ConnectionConfig,
  sources: readonly string[],
  destDir: string,
  deps: DropMoveDeps,
  options: OpOptions = {},
): Promise<PasteResult> {
  assertMutatingAllowed(connection);
  assertInsideRoot(connection, destDir);
  const plan = await planDropMove(client, connection, sources, destDir);
  const skipped = [...plan.skipped];
  let movable = plan.movable;
  if (movable.length === 0) return { pasted: [], skipped };

  const conflicting: string[] = [];
  for (const source of movable) {
    const dest = joinRoot(destDir, path.posix.basename(source));
    if (await existsOnServer(client, dest)) conflicting.push(source);
  }
  if (conflicting.length >= 2) {
    const names = conflicting.map((source) => joinRoot(destDir, path.posix.basename(source)));
    const choice = await deps.chooseConflictPolicy(names);
    if (choice === 'cancel') throw new TransferCancelledError();
    if (choice === 'skip') {
      for (const [i, source] of conflicting.entries()) {
        skipped.push({ path: source, reason: `kept the server version of ${names[i]}` });
      }
      movable = movable.filter((source) => !conflicting.includes(source));
      if (movable.length === 0) return { pasted: [], skipped };
    }
  }

  const result = await pasteEntries(
    client,
    connection,
    { connectionId: connection.id, paths: movable, cut: true },
    destDir,
    deps,
    options,
  );
  return { pasted: result.pasted, skipped: [...skipped, ...result.skipped] };
}
