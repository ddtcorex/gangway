const AUTO_OPEN_PROMPT_THRESHOLD_BYTES = 5 * 1024 * 1024;

export interface RemoteEntry {
  path: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
}

export interface TransferTask {
  remotePath: string;
  size: number;
  isSymlink: boolean;
  promptBeforeAutoOpen: boolean;
}

export class TransferCancelledError extends Error {
  constructor() {
    super('Transfer was cancelled.');
  }
}

type ListRemote = (dirPath: string) => Promise<RemoteEntry[]>;

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TransferCancelledError();
}

async function walk(root: RemoteEntry, listRemote: ListRemote, signal: AbortSignal | undefined, out: RemoteEntry[]): Promise<void> {
  checkCancelled(signal);
  const children = await listRemote(root.path);
  checkCancelled(signal);
  for (const child of children) {
    if (child.isDirectory) {
      await walk(child, listRemote, signal, out);
    } else {
      out.push(child);
    }
  }
}

export async function buildDownloadPlan(root: RemoteEntry, listRemote: ListRemote, signal?: AbortSignal): Promise<TransferTask[]> {
  const entries: RemoteEntry[] = [];
  await walk(root, listRemote, signal, entries);
  return entries.map((entry) => ({
    remotePath: entry.path,
    size: entry.size,
    isSymlink: entry.isSymbolicLink,
    promptBeforeAutoOpen: entry.size > AUTO_OPEN_PROMPT_THRESHOLD_BYTES,
  }));
}

export async function buildUploadPlan(
  root: RemoteEntry,
  listRemote: ListRemote,
  signal?: AbortSignal,
): Promise<{ tasks: TransferTask[]; skippedSymlinks: string[] }> {
  const entries: RemoteEntry[] = [];
  await walk(root, listRemote, signal, entries);
  const tasks: TransferTask[] = [];
  const skippedSymlinks: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink) {
      skippedSymlinks.push(entry.path);
      continue;
    }
    tasks.push({
      remotePath: entry.path,
      size: entry.size,
      isSymlink: false,
      promptBeforeAutoOpen: entry.size > AUTO_OPEN_PROMPT_THRESHOLD_BYTES,
    });
  }
  return { tasks, skippedSymlinks };
}
