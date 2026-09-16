import type { RemoteStat, SidecarMeta } from './types';

export type ConflictStatus = 'clean' | 'conflict';

export function checkConflict(sidecar: SidecarMeta, freshRemoteStat: RemoteStat): ConflictStatus {
  return sidecar.mtime === freshRemoteStat.mtime && sidecar.size === freshRemoteStat.size ? 'clean' : 'conflict';
}

/** Single-file decision, offered after a diff between local tmp and fresh server content. */
export type FileConflictDecision = 'overwrite' | 'keepServer' | 'cancel';

/**
 * Folder-upload decision. Deliberately has no 'overwriteAll' member: every
 * conflicted file in a batch push must be looked at (diff) or explicitly
 * skipped, never bulk-overwritten (spec §2.4, §9 review log).
 */
export type FolderConflictDecision = 'reviewOneByOne' | 'skipConflicted';
