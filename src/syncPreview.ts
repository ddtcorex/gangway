import type { SidecarMeta } from './types';

export interface SyncSideStat {
  path: string;
  mtime: number;
  size: number;
}

export type SyncVerdict = 'Only-local' | 'Only-remote' | 'Local-newer' | 'Remote-newer' | 'Conflict' | 'Same';

export interface SyncRow {
  relativePath: string;
  verdict: SyncVerdict;
  localStat?: SyncSideStat;
  remoteStat?: SyncSideStat;
}

/**
 * Two-way compare by mtime/size. mtime orders newer/older; equal mtimes
 * with different sizes cannot be ordered and become Conflict. Output is
 * sorted by path for a stable preview list.
 */
export function compareTrees(local: readonly SyncSideStat[], remote: readonly SyncSideStat[]): SyncRow[] {
  const remoteByPath = new Map(remote.map((entry) => [entry.path, entry]));
  const rows: SyncRow[] = [];
  const seen = new Set<string>();
  for (const localStat of local) {
    seen.add(localStat.path);
    const remoteStat = remoteByPath.get(localStat.path);
    if (!remoteStat) {
      rows.push({ relativePath: localStat.path, verdict: 'Only-local', localStat });
      continue;
    }
    if (localStat.mtime === remoteStat.mtime && localStat.size === remoteStat.size) {
      rows.push({ relativePath: localStat.path, verdict: 'Same', localStat, remoteStat });
    } else if (localStat.mtime === remoteStat.mtime) {
      rows.push({ relativePath: localStat.path, verdict: 'Conflict', localStat, remoteStat });
    } else if (localStat.mtime > remoteStat.mtime) {
      rows.push({ relativePath: localStat.path, verdict: 'Local-newer', localStat, remoteStat });
    } else {
      rows.push({ relativePath: localStat.path, verdict: 'Remote-newer', localStat, remoteStat });
    }
  }
  for (const remoteStat of remote) {
    if (!seen.has(remoteStat.path)) {
      rows.push({ relativePath: remoteStat.path, verdict: 'Only-remote', remoteStat });
    }
  }
  rows.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return rows;
}

/**
 * QuickPick has no table columns, so the verdict rides in the label and the
 * evidence (both mtimes/sizes) in the detail line.
 */
export function toQuickPickRow(row: SyncRow): { label: string; detail: string } {
  const format = (stat: SyncSideStat | undefined): string => (stat ? `${stat.mtime}/${stat.size}B` : '—');
  return {
    label: `$(file) ${row.relativePath} — ${row.verdict}`,
    detail: `local ${format(row.localStat)} vs remote ${format(row.remoteStat)}`,
  };
}

/**
 * Pure model for the excluded-children confirm: how many of the picked
 * folder's files the patterns hide, with the two run choices.
 */
export function describeExcludedSelection(
  total: number,
  excludedCount: number,
): { message: string; proceedLabel: string; includeAllLabel: string } {
  return {
    message: `${excludedCount} of ${total} files excluded by patterns.`,
    proceedLabel: 'Proceed-excluded',
    includeAllLabel: 'Include-all',
  };
}

export interface ClassifyInput {
  localExists: boolean;
  /** Local fs mtime (ms, float). */
  localMtimeMs: number;
  localSize: number;
  remoteExists: boolean;
  /** Server mtime (ms). */
  remoteMtime: number;
  remoteSize: number;
  sidecar?: Pick<SidecarMeta, 'mtime' | 'size' | 'localMtimeMs'>;
}

/** Clock/filesystem granularity tolerance for the no-sidecar fallback. */
const NO_BASELINE_TOLERANCE_MS = 2000;

/**
 * One file's sync verdict. With a sidecar baseline the answer is exact
 * (server-changed × locally-changed, same semantics as dirtyState.ts plus
 * checkConflict). Without one, mtime/size order with a 2s tolerance so a
 * just-transferred file does not report phantom-newer on skewed clocks.
 */
export function classifyRow(input: ClassifyInput): SyncVerdict {
  if (!input.remoteExists) return 'Only-local';
  if (!input.localExists) return 'Only-remote';
  if (input.sidecar) {
    const serverChanged = input.sidecar.mtime !== input.remoteMtime || input.sidecar.size !== input.remoteSize;
    const localChanged =
      input.sidecar.localMtimeMs === undefined
        ? false
        : Math.round(input.localMtimeMs) !== Math.round(input.sidecar.localMtimeMs);
    if (!serverChanged && !localChanged) return 'Same';
    if (serverChanged && !localChanged) return 'Remote-newer';
    if (!serverChanged && localChanged) return 'Local-newer';
    return 'Conflict';
  }
  const localMtimeMs =
    input.localSize === input.remoteSize && Math.abs(input.localMtimeMs - input.remoteMtime) <= NO_BASELINE_TOLERANCE_MS
      ? input.remoteMtime
      : input.localMtimeMs;
  const compared = compareTrees(
    [{ path: '', mtime: localMtimeMs, size: input.localSize }],
    [{ path: '', mtime: input.remoteMtime, size: input.remoteSize }],
  )[0].verdict;
  if (compared === 'Same' || compared === 'Conflict' || compared === 'Local-newer' || compared === 'Remote-newer') {
    return compared;
  }
  // compareTrees can only return Only-* for one-sided inputs, which cannot
  // happen here (both sides exist) — unreachable by construction.
  return 'Conflict';
}
