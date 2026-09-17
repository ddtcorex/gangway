import { buildDownloadPlan, buildUploadPlan } from '../folderQueue';
import type { RemoteEntry } from '../folderQueue';
import type { FileConflictDecision, FolderConflictDecision } from '../conflictGuard';

type ListRemote = (dirPath: string) => Promise<RemoteEntry[]>;
type DownloadOneFile = (remotePath: string) => Promise<unknown>;
type UploadOneFile = (remotePath: string) => Promise<unknown>;
type CheckForConflict = (remotePath: string) => Promise<boolean>;
type DecideFolderConflicts = (conflictedPaths: string[]) => Promise<FolderConflictDecision>;
type ReviewOneConflict = (remotePath: string) => Promise<FileConflictDecision>;

/**
 * `folderQueue.ts` has taken an `AbortSignal` since it was written, but
 * nothing ever passed one in, so the Cancel affordance on the progress
 * notification did nothing whatsoever. Cancellation is honoured between
 * files, never in the middle of one: a half-written remote file is exactly
 * what the atomic tmp+rename upload exists to prevent.
 */
export interface FolderTransferOptions {
  signal?: AbortSignal;
  reportProgress?: (remotePath: string) => void;
}

export interface FolderDownloadResult {
  downloaded: string[];
  /** True when the user cancelled part-way; `downloaded` is then partial. */
  cancelled: boolean;
}

export interface FolderUploadResult {
  uploaded: string[];
  skippedConflicted: string[];
  skippedSymlinks: string[];
  /**
   * True when the user cancelled part-way. `uploaded` still lists exactly
   * what reached the server: this pushes to production, so the caller must be
   * able to say what actually landed, not merely that it stopped.
   */
  cancelled: boolean;
}

export async function runFolderDownload(
  root: RemoteEntry,
  listRemote: ListRemote,
  downloadFile: DownloadOneFile,
  reportProgress: (remotePath: string) => void,
  options: FolderTransferOptions = {},
): Promise<FolderDownloadResult> {
  const plan = await buildDownloadPlan(root, listRemote, options.signal);
  const downloaded: string[] = [];
  for (const task of plan) {
    if (options.signal?.aborted) return { downloaded, cancelled: true };
    await downloadFile(task.remotePath);
    reportProgress(task.remotePath);
    downloaded.push(task.remotePath);
  }
  return { downloaded, cancelled: options.signal?.aborted ?? false };
}

export async function runFolderUpload(
  root: RemoteEntry,
  listRemote: ListRemote,
  uploadFile: UploadOneFile,
  checkForConflict: CheckForConflict,
  decideFolderConflicts: DecideFolderConflicts,
  reviewOneConflict?: ReviewOneConflict,
  options: FolderTransferOptions = {},
): Promise<FolderUploadResult> {
  const { tasks, skippedSymlinks } = await buildUploadPlan(root, listRemote, options.signal);

  const conflicted: string[] = [];
  for (const task of tasks) {
    if (await checkForConflict(task.remotePath)) conflicted.push(task.remotePath);
  }

  const decision = conflicted.length > 0 ? await decideFolderConflicts(conflicted) : undefined;
  const uploaded: string[] = [];
  const skippedConflicted: string[] = [];

  for (const task of tasks) {
    if (options.signal?.aborted) {
      return { uploaded, skippedConflicted, skippedSymlinks, cancelled: true };
    }

    const isConflicted = conflicted.includes(task.remotePath);
    if (!isConflicted) {
      await uploadFile(task.remotePath);
      uploaded.push(task.remotePath);
      options.reportProgress?.(task.remotePath);
      continue;
    }
    if (decision === 'reviewOneByOne' && reviewOneConflict) {
      const fileDecision = await reviewOneConflict(task.remotePath);
      if (fileDecision === 'overwrite') {
        await uploadFile(task.remotePath);
        uploaded.push(task.remotePath);
        options.reportProgress?.(task.remotePath);
        continue;
      }
    }
    skippedConflicted.push(task.remotePath);
  }

  return { uploaded, skippedConflicted, skippedSymlinks, cancelled: options.signal?.aborted ?? false };
}
