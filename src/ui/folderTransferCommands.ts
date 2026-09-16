import { buildDownloadPlan, buildUploadPlan } from '../folderQueue';
import type { RemoteEntry } from '../folderQueue';
import type { FileConflictDecision, FolderConflictDecision } from '../conflictGuard';

type ListRemote = (dirPath: string) => Promise<RemoteEntry[]>;
type DownloadOneFile = (remotePath: string) => Promise<unknown>;
type UploadOneFile = (remotePath: string) => Promise<unknown>;
type CheckForConflict = (remotePath: string) => Promise<boolean>;
type DecideFolderConflicts = (conflictedPaths: string[]) => Promise<FolderConflictDecision>;
type ReviewOneConflict = (remotePath: string) => Promise<FileConflictDecision>;

export interface FolderDownloadResult {
  downloaded: string[];
}

export interface FolderUploadResult {
  uploaded: string[];
  skippedConflicted: string[];
  skippedSymlinks: string[];
}

export async function runFolderDownload(
  root: RemoteEntry,
  listRemote: ListRemote,
  downloadFile: DownloadOneFile,
  reportProgress: (remotePath: string) => void,
): Promise<FolderDownloadResult> {
  const plan = await buildDownloadPlan(root, listRemote);
  const downloaded: string[] = [];
  for (const task of plan) {
    await downloadFile(task.remotePath);
    reportProgress(task.remotePath);
    downloaded.push(task.remotePath);
  }
  return { downloaded };
}

export async function runFolderUpload(
  root: RemoteEntry,
  listRemote: ListRemote,
  uploadFile: UploadOneFile,
  checkForConflict: CheckForConflict,
  decideFolderConflicts: DecideFolderConflicts,
  reviewOneConflict?: ReviewOneConflict,
): Promise<FolderUploadResult> {
  const { tasks, skippedSymlinks } = await buildUploadPlan(root, listRemote);

  const conflicted: string[] = [];
  for (const task of tasks) {
    if (await checkForConflict(task.remotePath)) conflicted.push(task.remotePath);
  }

  const decision = conflicted.length > 0 ? await decideFolderConflicts(conflicted) : undefined;
  const uploaded: string[] = [];
  const skippedConflicted: string[] = [];

  for (const task of tasks) {
    const isConflicted = conflicted.includes(task.remotePath);
    if (!isConflicted) {
      await uploadFile(task.remotePath);
      uploaded.push(task.remotePath);
      continue;
    }
    if (decision === 'reviewOneByOne' && reviewOneConflict) {
      const fileDecision = await reviewOneConflict(task.remotePath);
      if (fileDecision === 'overwrite') {
        await uploadFile(task.remotePath);
        uploaded.push(task.remotePath);
        continue;
      }
    }
    skippedConflicted.push(task.remotePath);
  }

  return { uploaded, skippedConflicted, skippedSymlinks };
}
