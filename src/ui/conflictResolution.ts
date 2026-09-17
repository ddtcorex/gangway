import fs from 'node:fs/promises';
import path from 'node:path';
import { writeSidecar } from '../tmpStore';
import type { FileConflictDecision } from '../conflictGuard';
import type { RemoteStat } from '../types';

/** The subset of the SFTP adapter this flow needs (see SftpClientAdapter). */
export interface ConflictResolutionClient {
  fastGet(remotePath: string, localPath: string): Promise<unknown>;
  stat(remotePath: string): Promise<RemoteStat>;
}

/**
 * The two user-facing steps, injected so the whole flow is testable without a
 * VS Code extension host. `src/extension.ts` supplies the real pair:
 * `vscode.diff` for the diff and `showWarningMessage` for the choice.
 */
export interface ConflictResolutionUi {
  showDiff(localPath: string, serverCopyPath: string, title: string): Promise<void>;
  askDecision(remotePath: string): Promise<FileConflictDecision>;
}

/**
 * Where the current server bytes are parked for the duration of one diff.
 * Deliberately a sibling of the local tmp file rather than a second entry in
 * the tmpPath.ts scheme: it lives for the length of a single decision, must
 * never be mistaken for a downloaded tmp file, and must not collide with the
 * `.meta.json` sidecar naming.
 */
export function freshServerCopyPathFor(localPath: string): string {
  return `${localPath}.gangway-server-fresh`;
}

/**
 * The Conflict Guard's second half (spec §2.4). `checkConflict()` only ever
 * answered "clean or conflict"; on "conflict" the extension showed a warning
 * telling the user to open a diff and choose, then returned -- no diff was
 * ever opened, no choice was ever offered, and a conflicted file could not be
 * pushed by any means.
 *
 * This fetches the server's current content to a throwaway sibling file,
 * shows the native diff against the local tmp copy, and applies the user's
 * decision:
 *   - 'overwrite'   leave everything alone; the caller pushes as intended.
 *   - 'keepServer'  discard the local edits by copying the fresh server bytes
 *                   over the local tmp file and refreshing its sidecar to the
 *                   fresh stat, so the next upload is not a false conflict
 *                   against the pre-discard baseline. The caller does not push.
 *   - 'cancel'      change nothing at all.
 * The throwaway copy is always removed, whatever happens.
 */
export async function resolveFileConflict(
  client: ConflictResolutionClient,
  connectionId: string,
  localPath: string,
  remotePath: string,
  ui: ConflictResolutionUi,
): Promise<FileConflictDecision> {
  const serverCopyPath = freshServerCopyPathFor(localPath);
  try {
    await client.fastGet(remotePath, serverCopyPath);
    await ui.showDiff(localPath, serverCopyPath, `${path.basename(remotePath)}: local (Gangway) ↔ server (current)`);

    const decision = await ui.askDecision(remotePath);
    if (decision === 'keepServer') {
      await fs.copyFile(serverCopyPath, localPath);
      const freshStat = await client.stat(remotePath);
      await writeSidecar(localPath, {
        connectionId,
        remotePath,
        mtime: freshStat.mtime,
        size: freshStat.size,
        downloadedAt: Date.now(),
      });
    }
    return decision;
  } finally {
    // Never let a cleanup problem mask the real outcome (or the real error):
    // this file is throwaway scratch either way.
    await fs.rm(serverCopyPath, { force: true }).catch(() => {});
  }
}
