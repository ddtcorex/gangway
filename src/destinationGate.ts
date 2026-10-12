import { assertMutatingAllowed } from './remoteOps';
import { BrokenLinkError, gateWriteTarget, LinkLoopError, resolveTarget, type TargetClient } from './realTarget';
import type { ConnectionConfig } from './types';

export type DestinationGate = (remoteDir: string) => Promise<void>;

/**
 * One gate per bulk operation (folder upload, drag-drop, sync, mapped push).
 * Bulk writes go to `<dir>/<name>` through the lexical path, so a destination
 * directory that is a link to somewhere outside the connection root would
 * receive files with no other check: the per-file lstat only protects the
 * leaf. Each distinct directory is resolved once per operation (failures are
 * cached too, so a broken directory fails its files without re-asking the
 * server). There is no confirmation prompt for bulk operations: anything
 * outside the root is refused, and a link that stays inside the root (for
 * example `current -> releases/42`) passes.
 *
 * Messages name the directory the caller passed, never a link error's own
 * clickedPath, which may hold the root or a parent instead.
 */
export function createDestinationGate(
  client: TargetClient,
  connection: ConnectionConfig,
  /**
   * freezeGate (default true) refuses a frozen connection before any server
   * call. Mapped pushes pass false: they are pure B by design and never
   * consult `frozen` (pinned in test/mappedExplorer.test.ts). The
   * out-of-root refusal still applies to them.
   */
  options: { freezeGate?: boolean } = {},
): DestinationGate {
  const freezeGate = options.freezeGate ?? true;
  const verdicts = new Map<string, Promise<void>>();
  return async (remoteDir) => {
    if (freezeGate) assertMutatingAllowed(connection);
    let verdict = verdicts.get(remoteDir);
    if (verdict === undefined) {
      verdict = judge(client, connection, remoteDir);
      verdicts.set(remoteDir, verdict);
    }
    return verdict;
  };
}

async function judge(client: TargetClient, connection: ConnectionConfig, remoteDir: string): Promise<void> {
  let target;
  try {
    target = await resolveTarget(client, connection, remoteDir);
  } catch (err) {
    if (err instanceof BrokenLinkError) {
      throw new Error(`Refusing to upload into "${remoteDir}": the path goes through a broken link.`);
    }
    if (err instanceof LinkLoopError) {
      throw new Error(`Refusing to upload into "${remoteDir}": the path goes through a symbolic link loop.`);
    }
    throw err;
  }
  if (gateWriteTarget(connection, target) !== 'allow') {
    throw new Error(
      `Refusing to upload into "${remoteDir}": it really is "${target.realPath}", outside the connection root.`,
    );
  }
}
