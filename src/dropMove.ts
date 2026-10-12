import path from 'node:path';
import type { PasteSkip, RemoteOpsClient } from './remoteOps';
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
