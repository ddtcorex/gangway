import type { RemoteEntry } from './folderQueue';
import type { RemoteStat } from './types';

export type LinkKind = 'file' | 'dir' | 'broken' | 'loop';

export interface LinkInfo {
  realPath: string;
  kind: LinkKind;
}

/** Structural subset of the SFTP adapter used to resolve symlinks. */
export interface LinkResolveClient {
  stat(p: string): Promise<RemoteStat>;
  realPath(p: string): Promise<string | undefined>;
}

const DEFAULT_CONCURRENCY = 8;
const LOOP_RE = /loop|too many levels/i;

function isLoopError(err: unknown): boolean {
  if ((err as { code?: unknown } | null)?.code === 'ELOOP') return true;
  const message = err instanceof Error ? err.message : String(err);
  return LOOP_RE.test(message);
}

function isStrictAncestor(ancestor: string, path: string): boolean {
  if (ancestor === path) return false;
  const prefix = ancestor.endsWith('/') ? ancestor : `${ancestor}/`;
  return path.startsWith(prefix);
}

async function kindFromStat(
  client: LinkResolveClient,
  path: string,
): Promise<'file' | 'dir' | 'broken' | 'loop'> {
  try {
    return (await client.stat(path)).isDirectory ? 'dir' : 'file';
  } catch (err) {
    return isLoopError(err) ? 'loop' : 'broken';
  }
}

export async function resolveLink(client: LinkResolveClient, linkPath: string): Promise<LinkInfo> {
  let resolved: string | undefined;
  try {
    resolved = await client.realPath(linkPath);
  } catch (err) {
    if (isLoopError(err)) return { realPath: linkPath, kind: 'loop' };
    // Server without realpath support: treat the path as its own real path.
    return { realPath: linkPath, kind: await kindFromStat(client, linkPath) };
  }
  if (resolved === undefined) return { realPath: linkPath, kind: 'broken' };
  if (isStrictAncestor(resolved, linkPath)) return { realPath: resolved, kind: 'loop' };
  return { realPath: resolved, kind: await kindFromStat(client, linkPath) };
}

export async function resolveLinkEntries(
  client: LinkResolveClient,
  entries: RemoteEntry[],
  options: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<RemoteEntry[]> {
  const out = entries.slice();
  const pending: number[] = [];
  entries.forEach((e, i) => {
    if (e.isSymbolicLink) pending.push(i);
  });
  const limit = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const signal = options.signal;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (!signal?.aborted && next < pending.length) {
      const idx = pending[next++];
      const entry = entries[idx];
      let link: LinkInfo;
      try {
        link = await resolveLink(client, entry.path);
      } catch {
        link = { realPath: entry.path, kind: 'broken' };
      }
      // Only an ancestor loop is expandable; a loop reported by the server is not.
      const expandable =
        link.kind === 'dir' || (link.kind === 'loop' && isStrictAncestor(link.realPath, entry.path));
      const isDirectory = expandable ? true : entry.isDirectory;
      out[idx] = { ...entry, isDirectory, link };
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, pending.length) }, worker));
  return out;
}
