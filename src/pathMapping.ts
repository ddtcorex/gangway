import type { ConnectionConfig, PathMapping } from './types';

/**
 * Normalizes a path for prefix matching: forward slashes, no trailing
 * slash (except the root itself). Comparison stays case-sensitive; a typed
 * Windows drive letter (`C:\x`) is slash-normalized but otherwise taken
 * literally (documented gap: no case folding).
 */
function normalize(p: string): string {
  const forward = p.replace(/\\/g, '/');
  if (forward.length > 1 && forward.endsWith('/')) return forward.slice(0, -1);
  return forward;
}

function isWithinOrEqual(candidate: string, prefix: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

/**
 * The zero-config default (spec §2.2): the FIRST workspace folder root maps
 * to the connection remotePath. Other roots never sync without an explicit
 * mapping, so two locals cannot silently target one remote.
 */
export function defaultMapping(
  connection: ConnectionConfig,
  workspaceRoots: readonly string[],
): { local: string; remote: string } | undefined {
  if (workspaceRoots.length === 0) return undefined;
  return { local: normalize(workspaceRoots[0]), remote: normalize(connection.remotePath) };
}

interface EffectiveMapping {
  local: string;
  remote: string;
  explicit: boolean;
}

function effectiveMappings(connection: ConnectionConfig, workspaceRoots: readonly string[]): EffectiveMapping[] {
  const out: EffectiveMapping[] = (connection.mappings ?? []).map((m) => ({
    local: normalize(m.localPath),
    remote: normalize(m.remotePath),
    explicit: true,
  }));
  const fallback = defaultMapping(connection, workspaceRoots);
  if (fallback) out.push({ ...fallback, explicit: false });
  return out;
}

/**
 * Maps an absolute local path to its remote counterpart: longest explicit
 * prefix wins, then the default. Returns undefined when nothing matches or
 * the remote side would escape the connection root.
 */
export function resolveLocalToRemote(
  connection: ConnectionConfig,
  workspaceRoots: readonly string[],
  localAbsPath: string,
): string | undefined {
  const local = normalize(localAbsPath);
  const candidates = effectiveMappings(connection, workspaceRoots)
    .filter((m) => isWithinOrEqual(local, m.local))
    .sort((a, b) => b.local.length - a.local.length);
  const match = candidates[0];
  if (!match) return undefined;
  const remote = match.remote + local.slice(match.local.length);
  // A resolved remote outside the connection root is refused (spec §2.4):
  // the form may hold such a draft (red violation), but sync never runs it.
  if (!isWithinOrEqual(remote, normalize(connection.remotePath))) return undefined;
  return remote;
}

/**
 * The inverse direction with the same match order: longest explicit remote
 * prefix wins, then the default. Returns undefined when nothing matches.
 */
export function resolveRemoteToLocal(
  connection: ConnectionConfig,
  workspaceRoots: readonly string[],
  remotePath: string,
): string | undefined {
  const remote = normalize(remotePath);
  const candidates = effectiveMappings(connection, workspaceRoots)
    .filter((m) => isWithinOrEqual(remote, m.remote))
    .sort((a, b) => b.remote.length - a.remote.length);
  const match = candidates[0];
  if (!match) return undefined;
  return match.local + remote.slice(match.remote.length);
}

/**
 * Editor helper: for every mapping row shadowed by a longer row (same side
 * nesting), a note naming the winning row so the overlap is visible before
 * save. Rows are 1-based in notes to match the editor's numbering.
 */
export function overlapNotes(mappings: readonly PathMapping[]): Array<{ index: number; note: string }> {
  const notes: Array<{ index: number; note: string }> = [];
  const locals = mappings.map((m) => normalize(m.localPath));
  const remotes = mappings.map((m) => normalize(m.remotePath));
  mappings.forEach((_mapping, index) => {
    for (let other = 0; other < mappings.length; other += 1) {
      if (other === index) continue;
      // Row `other` nested inside row `index` means `index` is partially
      // shadowed: the longer prefix wins wherever they overlap.
      const localShadows = locals[other] !== locals[index] && isWithinOrEqual(locals[other], locals[index]);
      const remoteShadows = remotes[other] !== remotes[index] && isWithinOrEqual(remotes[other], remotes[index]);
      if (localShadows || remoteShadows) {
        notes.push({ index, note: `Overlapped by row ${other + 1} — the longer prefix wins` });
        break;
      }
    }
  });
  return notes;
}
