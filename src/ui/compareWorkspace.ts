import path from 'node:path';

import type { ConnectionConfig } from '../types';
import { tmpFilePathFor } from '../tmpPath';

/**
 * Staging path for the workspace-compare flow: the server's fresh bytes are
 * downloaded next to (never over) the connection's tmp mirror, then shown as
 * the right side of `vscode.diff`. Reuses `tmpFilePathFor`'s containment
 * check, so an escaping remote path fails loudly here instead of writing
 * outside the per-connection tmp root. The suffix keeps the staging file
 * apart from the real tmp mirror and lets `tmpRetention`'s 7-day purge
 * collect it -- the diff stays valid on revisit because nothing deletes it
 * right after opening.
 */
export function stagingPathForWorkspaceCompare(connection: ConnectionConfig, remotePath: string): string {
  return `${tmpFilePathFor(connection, remotePath)}.gangway-compare-workspace`;
}

/** `app.php: workspace ↔ server (current)` -- names both sides of the diff. */
export function diffTitleForWorkspaceCompare(remotePath: string): string {
  return `${path.posix.basename(remotePath)}: workspace ↔ server (current)`;
}
