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
  /** Retry-a-subset: only these remote paths are transferred. */
  onlyPaths?: ReadonlySet<string>;
  /** Recreate a plan directory on the local side (download) / remote side (upload). Idempotent. */
  ensureDir?: (remotePath: string) => Promise<unknown>;
}

export interface FailedTask {
  remotePath: string;
  message: string;
}

function failureOf(remotePath: string, err: unknown): FailedTask {
  return { remotePath, message: err instanceof Error ? err.message : String(err) };
}

export interface FolderDownloadResult {
  downloaded: string[];
  /** Symlinks arrive as plain files (server links are never recreated locally): reported so the caller can warn. */
  symlinked: string[];
  /** Per-file failures never abort the queue; the caller reports and offers retry. */
  failed: FailedTask[];
  /** True when the user cancelled part-way; `downloaded` is then partial. */
  cancelled: boolean;
}

export interface FolderUploadResult {
  uploaded: string[];
  skippedConflicted: string[];
  skippedSymlinks: string[];
  failed: FailedTask[];
  /**
   * True when the user cancelled part-way. `uploaded` still lists exactly
   * what reached the server: this pushes to production, so the caller must be
   * able to say what actually landed, not merely that it stopped.
   */
  cancelled: boolean;
}

function cancelledDownload(downloaded: string[], symlinked: string[], failed: FailedTask[]): FolderDownloadResult {
  return { downloaded, symlinked, failed, cancelled: true };
}

function cancelledUpload(
  uploaded: string[],
  skippedConflicted: string[],
  skippedSymlinks: string[],
  failed: FailedTask[],
): FolderUploadResult {
  return { uploaded, skippedConflicted, skippedSymlinks, failed, cancelled: true };
}

export async function runFolderDownload(
  root: RemoteEntry,
  listRemote: ListRemote,
  downloadFile: DownloadOneFile,
  reportProgress: (remotePath: string) => void,
  options: FolderTransferOptions = {},
): Promise<FolderDownloadResult> {
  const plan = await buildDownloadPlan(root, listRemote, options.signal, { onlyPaths: options.onlyPaths });
  if (options.ensureDir) {
    for (const dir of plan.dirs) {
      if (options.signal?.aborted) return cancelledDownload([], [], []);
      await options.ensureDir(dir);
    }
  }
  const downloaded: string[] = [];
  const symlinked: string[] = [];
  const failed: FailedTask[] = [];
  for (const task of plan.tasks) {
    if (options.signal?.aborted) return cancelledDownload(downloaded, symlinked, failed);
    try {
      await downloadFile(task.remotePath);
    } catch (err) {
      failed.push(failureOf(task.remotePath, err));
      continue;
    }
    reportProgress(task.remotePath);
    downloaded.push(task.remotePath);
    if (task.isSymlink) symlinked.push(task.remotePath);
  }
  return { downloaded, symlinked, failed, cancelled: options.signal?.aborted ?? false };
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
  const { tasks, skippedSymlinks, dirs } = await buildUploadPlan(root, listRemote, options.signal, {
    onlyPaths: options.onlyPaths,
  });
  if (options.ensureDir) {
    for (const dir of dirs) {
      if (options.signal?.aborted) return cancelledUpload([], [], skippedSymlinks, []);
      try {
        await options.ensureDir(dir);
      } catch {
        // A directory that cannot be ensured will fail every file under it
        // with a clearer per-file error below; recording it once here would
        // double-report. Let the files speak.
      }
    }
  }

  const conflicted: string[] = [];
  const failed: FailedTask[] = [];
  for (const task of tasks) {
    try {
      if (await checkForConflict(task.remotePath)) conflicted.push(task.remotePath);
    } catch (err) {
      // A stat that fails is not a conflict verdict: record it and keep
      // going rather than aborting the whole batch on one unreadable file.
      failed.push(failureOf(task.remotePath, err));
    }
  }
  const checkable = new Set(tasks.map((t) => t.remotePath));
  for (const f of failed) checkable.delete(f.remotePath);

  const decision = conflicted.length > 0 ? await decideFolderConflicts(conflicted) : undefined;
  const uploaded: string[] = [];
  const skippedConflicted: string[] = [];

  for (const task of tasks) {
    if (options.signal?.aborted) {
      return cancelledUpload(uploaded, skippedConflicted, skippedSymlinks, failed);
    }
    if (!checkable.has(task.remotePath)) continue;

    const isConflicted = conflicted.includes(task.remotePath);
    if (!isConflicted) {
      try {
        await uploadFile(task.remotePath);
      } catch (err) {
        failed.push(failureOf(task.remotePath, err));
        continue;
      }
      uploaded.push(task.remotePath);
      options.reportProgress?.(task.remotePath);
      continue;
    }
    if (decision === 'reviewOneByOne' && reviewOneConflict) {
      let fileDecision: FileConflictDecision;
      try {
        fileDecision = await reviewOneConflict(task.remotePath);
      } catch (err) {
        failed.push(failureOf(task.remotePath, err));
        continue;
      }
      if (fileDecision === 'overwrite') {
        try {
          await uploadFile(task.remotePath);
        } catch (err) {
          failed.push(failureOf(task.remotePath, err));
          continue;
        }
        uploaded.push(task.remotePath);
        options.reportProgress?.(task.remotePath);
        continue;
      }
    }
    skippedConflicted.push(task.remotePath);
  }

  return { uploaded, skippedConflicted, skippedSymlinks, failed, cancelled: options.signal?.aborted ?? false };
}
