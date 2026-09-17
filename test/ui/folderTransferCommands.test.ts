import { describe, it, expect, vi } from 'vitest';
import { runFolderDownload, runFolderUpload } from '../../src/ui/folderTransferCommands';
import type { RemoteEntry } from '../../src/folderQueue';
import type { SidecarMeta } from '../../src/types';

const root: RemoteEntry = { path: '/var/www', isDirectory: true, isSymbolicLink: false, size: 0 };

function listRemoteFixture(tree: Record<string, RemoteEntry[]>) {
  return async (dirPath: string) => tree[dirPath] ?? [];
}

describe('runFolderDownload', () => {
  it('downloads every file task in the plan and reports progress once per file', async () => {
    const tree: Record<string, RemoteEntry[]> = {
      '/var/www': [
        { path: '/var/www/a.php', isDirectory: false, isSymbolicLink: false, size: 10 },
        { path: '/var/www/b.php', isDirectory: false, isSymbolicLink: false, size: 20 },
      ],
    };
    const downloadFile = vi.fn().mockResolvedValue({ localPath: '/tmp/x', meta: {} as SidecarMeta });
    const reportProgress = vi.fn();

    const result = await runFolderDownload(root, listRemoteFixture(tree), downloadFile, reportProgress);

    expect(downloadFile).toHaveBeenCalledTimes(2);
    expect(downloadFile).toHaveBeenCalledWith('/var/www/a.php');
    expect(downloadFile).toHaveBeenCalledWith('/var/www/b.php');
    expect(reportProgress).toHaveBeenCalledTimes(2);
    expect(result.downloaded).toEqual(['/var/www/a.php', '/var/www/b.php']);
  });
});

describe('folder transfer cancellation', () => {
  // folderQueue.ts has had AbortSignal plumbing since Task 13, but nothing
  // ever passed one in: "Cancel" on the progress notification did nothing at
  // all. Cancelling mid-queue must also report exactly what already landed --
  // this pushes to production, so "we stopped somewhere" is not good enough.
  const tree: Record<string, RemoteEntry[]> = {
    '/var/www': [
      { path: '/var/www/a.php', isDirectory: false, isSymbolicLink: false, size: 10 },
      { path: '/var/www/b.php', isDirectory: false, isSymbolicLink: false, size: 20 },
      { path: '/var/www/c.php', isDirectory: false, isSymbolicLink: false, size: 30 },
    ],
  };

  it('stops a folder download after the file being transferred when cancelled', async () => {
    const controller = new AbortController();
    const downloadFile = vi.fn().mockImplementation(async (remotePath: string) => {
      if (remotePath === '/var/www/a.php') controller.abort();
    });

    const result = await runFolderDownload(root, listRemoteFixture(tree), downloadFile, vi.fn(), {
      signal: controller.signal,
    });

    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(result.downloaded).toEqual(['/var/www/a.php']);
    expect(result.cancelled).toBe(true);
  });

  it('stops a folder upload when cancelled and still reports what actually landed', async () => {
    const controller = new AbortController();
    const uploadFile = vi.fn().mockImplementation(async (remotePath: string) => {
      if (remotePath === '/var/www/a.php') controller.abort();
    });

    const result = await runFolderUpload(
      root,
      listRemoteFixture(tree),
      uploadFile,
      vi.fn().mockResolvedValue(false),
      vi.fn(),
      undefined,
      { signal: controller.signal },
    );

    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(result.uploaded).toEqual(['/var/www/a.php']);
    expect(result.cancelled).toBe(true);
  });

  it('reports progress per uploaded file, the way folder download already did', async () => {
    const reportProgress = vi.fn();

    await runFolderUpload(
      root,
      listRemoteFixture(tree),
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue(false),
      vi.fn(),
      undefined,
      { reportProgress },
    );

    expect(reportProgress).toHaveBeenCalledTimes(3);
    expect(reportProgress).toHaveBeenCalledWith('/var/www/b.php');
  });

  it('is not cancelled when no signal is involved', async () => {
    const result = await runFolderDownload(root, listRemoteFixture(tree), vi.fn(), vi.fn());
    expect(result.cancelled).toBe(false);
  });
});

describe('runFolderUpload', () => {
  it('uploads every non-conflicted file and reports skipped symlinks, without ever bulk-overwriting a conflict', async () => {
    const tree: Record<string, RemoteEntry[]> = {
      '/var/www': [
        { path: '/var/www/clean.php', isDirectory: false, isSymbolicLink: false, size: 5 },
        { path: '/var/www/conflicted.php', isDirectory: false, isSymbolicLink: false, size: 5 },
        { path: '/var/www/link.php', isDirectory: false, isSymbolicLink: true, size: 5 },
      ],
    };
    const uploadFile = vi.fn().mockResolvedValue(undefined);
    const checkForConflict = vi.fn().mockImplementation(async (remotePath: string) => remotePath.includes('conflicted'));
    const decideConflicted = vi.fn().mockResolvedValue('skipConflicted' as const);

    const result = await runFolderUpload(root, listRemoteFixture(tree), uploadFile, checkForConflict, decideConflicted);

    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(uploadFile).toHaveBeenCalledWith('/var/www/clean.php');
    expect(result.uploaded).toEqual(['/var/www/clean.php']);
    expect(result.skippedConflicted).toEqual(['/var/www/conflicted.php']);
    expect(result.skippedSymlinks).toEqual(['/var/www/link.php']);
  });

  it('never uploads a conflicted file even when the decision is reviewOneByOne, unless the caller-supplied review approves it', async () => {
    const tree: Record<string, RemoteEntry[]> = {
      '/var/www': [{ path: '/var/www/conflicted.php', isDirectory: false, isSymbolicLink: false, size: 5 }],
    };
    const uploadFile = vi.fn().mockResolvedValue(undefined);
    const checkForConflict = vi.fn().mockResolvedValue(true);
    const decideConflicted = vi.fn().mockResolvedValue('reviewOneByOne' as const);
    const reviewOne = vi.fn().mockResolvedValue('cancel' as const);

    const result = await runFolderUpload(root, listRemoteFixture(tree), uploadFile, checkForConflict, decideConflicted, reviewOne);

    expect(uploadFile).not.toHaveBeenCalled();
    expect(result.uploaded).toEqual([]);
    expect(result.skippedConflicted).toEqual(['/var/www/conflicted.php']);
  });
});
