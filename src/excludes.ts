import type { ConnectionConfig } from './types';
import { DEFAULT_EXCLUDES } from './remoteOps';

/**
 * Glob matching for per-connection excludes, relative to the connection
 * root (stable no matter which subfolder is synced). Supported syntax:
 * `*` (within one segment), `?` (one char, within one segment), `**`
 * (zero or more whole segments). A pattern without `**` never crosses a
 * `/`: use `dir/**` to exclude a whole subtree.
 */
export function matchesExcludes(relativePosixPath: string, patterns: readonly string[]): boolean {
  const path = relativePosixPath.replace(/\/+$/, '');
  return patterns.some((pattern) => matchGlob(path, pattern));
}

function matchGlob(path: string, pattern: string): boolean {
  return matchSegments(path.split('/'), pattern.split('/'));
}

function matchSegments(pathSegs: string[], patSegs: string[]): boolean {
  if (patSegs.length === 0) return pathSegs.length === 0;
  const [head, ...rest] = patSegs;
  if (head === '**') {
    for (let skip = 0; skip <= pathSegs.length; skip += 1) {
      if (matchSegments(pathSegs.slice(skip), rest)) return true;
    }
    return false;
  }
  if (pathSegs.length === 0 || !matchSegment(pathSegs[0], head)) return false;
  return matchSegments(pathSegs.slice(1), rest);
}

function matchSegment(name: string, pattern: string): boolean {
  const source = pattern
    .split('')
    .map((ch) => {
      if (ch === '*') return '[^/]*';
      if (ch === '?') return '[^/]';
      return ch.replace(/[.+^${}()|[\]\\]/, '\\$&');
    })
    .join('');
  return new RegExp(`^${source}$`).test(name);
}

/** The connection's patterns, or the spec §2.3 defaults when unset. */
export function effectiveExcludes(connection: Pick<ConnectionConfig, 'excludePatterns'>): readonly string[] {
  return connection.excludePatterns ?? DEFAULT_EXCLUDES;
}
