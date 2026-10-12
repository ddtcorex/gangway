import path from 'node:path';
import { isLexicallyInside } from './remoteOps';
import type { ConnectionConfig, RemoteStat } from './types';

/** The client surface target resolution needs. SftpClientAdapter satisfies it. */
export interface TargetClient {
  /** Resolves to the canonical path; undefined means the path does not exist. Other errors reject. */
  realPath(p: string): Promise<string | undefined>;
  stat(p: string): Promise<RemoteStat>;
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
  constructor(clickedPath: string, storedRealPath: string, currentRealPath: string) {
    super(
      `"${clickedPath}" is a link that now points elsewhere: it was opened as "${storedRealPath}" but now resolves to "${currentRealPath}". Open it again before pushing.`,
    );
    this.name = 'LinkRetargetedError';
  }
}

/**
 * Real path of p, or undefined when the server cannot tell. A path that does
 * not exist yet resolves its parent and appends the leaf, so creating a new
 * file under a linked directory still sees the real destination.
 */
async function realPathOf(client: TargetClient, p: string): Promise<string | undefined> {
  try {
    const direct = await client.realPath(p);
    if (direct !== undefined) return direct;
    const parent = path.posix.dirname(p);
    if (parent === p) return undefined;
    const parentReal = await client.realPath(parent);
    if (parentReal === undefined) return undefined;
    return path.posix.join(parentReal, path.posix.basename(p));
  } catch {
    // Restricted or chrooted servers may refuse realpath; the caller falls
    // back to the lexical path for this side (spec: behave as today).
    return undefined;
  }
}

/**
 * Resolves both the clicked path and the connection root on the server and
 * compares real against real, so a `current -> releases/42` root keeps its
 * files inside. Either side that fails to resolve falls back lexically.
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

/** Outside the root on a frozen connection is blocked; outside otherwise needs a confirmation. */
export function gateWriteTarget(connection: ConnectionConfig, target: ResolvedTarget): WriteGate {
  if (target.insideRoot) return 'allow';
  return connection.frozen === true ? 'block' : 'confirm';
}
