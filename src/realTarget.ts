import path from 'node:path';
import { isLoopError } from './linkResolver';
import { isLexicallyInside, isNotFoundError } from './remoteOps';
import type { ConnectionConfig, RemoteStat } from './types';

/** The client surface target resolution needs. SftpClientAdapter satisfies it. */
export interface TargetClient {
  /** Resolves to the canonical path; undefined means the path does not exist. Other errors reject. */
  realPath(p: string): Promise<string | undefined>;
  stat(p: string): Promise<RemoteStat>;
  lstat(p: string): Promise<RemoteStat>;
}

export interface ResolvedTarget {
  /** The path the user acted on (tree row, sidecar remotePath). */
  clickedPath: string;
  /** Where the bytes really live; equals clickedPath when unresolved. */
  realPath: string;
  /** realPath !== clickedPath: the path goes through at least one link. */
  viaLink: boolean;
  /** realPath is inside the real connection root. */
  insideRoot: boolean;
  /** False when the server could not resolve and clickedPath is used as is. */
  resolved: boolean;
}

export type WriteGate = 'allow' | 'confirm' | 'block';

export class LinkRetargetedError extends Error {
  readonly clickedPath: string;
  readonly storedRealPath: string;
  readonly currentRealPath: string;

  constructor(clickedPath: string, storedRealPath: string, currentRealPath: string) {
    super(
      `"${clickedPath}" is a link that now points elsewhere: it was opened as "${storedRealPath}" but now resolves to "${currentRealPath}". Open it again before pushing.`,
    );
    this.name = 'LinkRetargetedError';
    this.clickedPath = clickedPath;
    this.storedRealPath = storedRealPath;
    this.currentRealPath = currentRealPath;
  }
}

/** The path is a symlink whose target does not exist. Writing would replace the link. */
export class BrokenLinkError extends Error {
  readonly clickedPath: string;

  constructor(clickedPath: string) {
    super(`Refusing to write "${clickedPath}": it is a symlink whose target does not exist.`);
    this.name = 'BrokenLinkError';
    this.clickedPath = clickedPath;
  }
}

/** The path is part of a symlink loop and has no real target. */
export class LinkLoopError extends Error {
  readonly clickedPath: string;

  constructor(clickedPath: string) {
    super(`Refusing to write "${clickedPath}": it is part of a symlink loop.`);
    this.name = 'LinkLoopError';
    this.clickedPath = clickedPath;
  }
}

/**
 * realPath rejected for p. Loops fail closed. Otherwise a successful stat of
 * p means a restricted server that refuses realpath: return undefined so the
 * caller uses p lexically (spec: behave as today). If stat fails too, the
 * path cannot be judged, so the error is rethrown (never decided lexically).
 */
async function fallbackOnRealPathError(client: TargetClient, p: string, err: unknown): Promise<undefined> {
  if (isLoopError(err)) throw new LinkLoopError(p);
  try {
    await client.stat(p);
  } catch (statErr) {
    // OpenSSH often reports ELOOP as a generic failure on realpath; the stat
    // probe surfaces the loop with a clearer message.
    if (isLoopError(statErr)) throw new LinkLoopError(p);
    throw err;
  }
  return undefined;
}

/**
 * Real path of p, or undefined when p must be judged lexically. A path that
 * does not exist yet walks up to its nearest existing ancestor and rejoins the
 * missing tail onto that ancestor's real path, so a new folder several levels
 * below a linked directory still sees the real destination (one missing level
 * was not enough: `shared/new/sub` under `shared -> /etc/ext` used to fall back
 * to the path text and pass as inside the root). A dangling link also reads as
 * "missing" to realpath, so every missing level is lstat-checked: a dangling
 * link, at p or any ancestor, is refused instead of being written through.
 * Only a server that refuses realpath while stat still works (or a walk that
 * reaches `/` with nothing resolvable) is judged by the path text.
 */
async function realPathOf(client: TargetClient, p: string): Promise<string | undefined> {
  const missingTail: string[] = [];
  let current = p;
  for (;;) {
    let real: string | undefined;
    try {
      real = await client.realPath(current);
    } catch (err) {
      return fallbackOnRealPathError(client, current, err);
    }
    if (real !== undefined) return missingTail.length === 0 ? real : path.posix.join(real, ...missingTail);

    try {
      const entry = await client.lstat(current);
      if (entry.isSymbolicLink) throw new BrokenLinkError(current);
    } catch (err) {
      if (err instanceof BrokenLinkError) throw err;
      if (isLoopError(err)) throw new LinkLoopError(current);
      if (!isNotFoundError(err)) throw err;
    }

    const parent = path.posix.dirname(current);
    if (parent === current) return undefined;
    missingTail.unshift(path.posix.basename(current));
    current = parent;
  }
}

/**
 * Resolves both the clicked path and the connection root on the server and
 * compares real against real, so a `current -> releases/42` root keeps its
 * files inside. A side the server refuses to resolve while stat still works
 * falls back lexically; anything else (broken link, loop, failed connection)
 * rejects so no write is gated on a guess.
 */
export async function resolveTarget(
  client: TargetClient,
  connection: ConnectionConfig,
  clickedPath: string,
): Promise<ResolvedTarget> {
  const [targetReal, rootReal] = await Promise.all([
    realPathOf(client, clickedPath),
    realPathOf(client, connection.remotePath),
  ]);
  const realPath = targetReal ?? clickedPath;
  const root = rootReal ?? connection.remotePath;
  return {
    clickedPath,
    realPath,
    viaLink: realPath !== clickedPath,
    insideRoot: isLexicallyInside(root, realPath),
    resolved: targetReal !== undefined,
  };
}

/**
 * Outside the root on a frozen connection is blocked; outside otherwise needs a confirmation.
 * Covers only the out-of-root decision: the freeze gate (assertMutatingAllowed) still runs separately.
 */
export function gateWriteTarget(connection: ConnectionConfig, target: ResolvedTarget): WriteGate {
  if (target.insideRoot) return 'allow';
  return connection.frozen === true ? 'block' : 'confirm';
}
