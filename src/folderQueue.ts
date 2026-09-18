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

export interface DownloadPlan {
  tasks: TransferTask[];
  /**
   * Every real directory traversed (root first), so the caller can recreate
   * the tree even where it holds no files: a walk that only returns files
   * silently drops empty directories.
   */
  dirs: string[];
}

export interface UploadPlan {
  tasks: TransferTask[];
  skippedSymlinks: string[];
  dirs: string[];
}

export interface PlanFilter {
  /** Retry-a-subset: when present, only these remote paths become tasks. */
  onlyPaths?: ReadonlySet<string>;
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

async function walk(
  root: RemoteEntry,
  listRemote: ListRemote,
  signal: AbortSignal | undefined,
  out: { files: RemoteEntry[]; dirs: string[] },
): Promise<void> {
  checkCancelled(signal);
  out.dirs.push(root.path);
  const children = await listRemote(root.path);
  checkCancelled(signal);
  for (const child of children) {
    if (child.isDirectory && !child.isSymbolicLink) {
      await walk(child, listRemote, signal, out);
    } else {
      out.files.push(child);
    }
  }
}

function toTask(entry: RemoteEntry): TransferTask {
  return {
    remotePath: entry.path,
    size: entry.size,
    isSymlink: entry.isSymbolicLink,
    promptBeforeAutoOpen: entry.size > AUTO_OPEN_PROMPT_THRESHOLD_BYTES,
  };
}

export async function buildDownloadPlan(
  root: RemoteEntry,
  listRemote: ListRemote,
  signal?: AbortSignal,
  filter?: PlanFilter,
): Promise<DownloadPlan> {
  const collected = { files: [] as RemoteEntry[], dirs: [] as string[] };
  await walk(root, listRemote, signal, collected);
  const tasks = collected.files.map(toTask).filter((t) => !filter?.onlyPaths || filter.onlyPaths.has(t.remotePath));
  return { tasks, dirs: collected.dirs };
}

export async function buildUploadPlan(
  root: RemoteEntry,
  listRemote: ListRemote,
  signal?: AbortSignal,
  filter?: PlanFilter,
): Promise<UploadPlan> {
  const collected = { files: [] as RemoteEntry[], dirs: [] as string[] };
  await walk(root, listRemote, signal, collected);
  const tasks: TransferTask[] = [];
  const skippedSymlinks: string[] = [];
  for (const entry of collected.files) {
    if (filter?.onlyPaths && !filter.onlyPaths.has(entry.path)) continue;
    if (entry.isSymbolicLink) {
      skippedSymlinks.push(entry.path);
      continue;
    }
    tasks.push(toTask(entry));
  }
  return { tasks, skippedSymlinks, dirs: collected.dirs };
}
