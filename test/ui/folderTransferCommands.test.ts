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

describe('folder transfer failure isolation', () => {
  const tree: Record<string, RemoteEntry[]> = {
    '/var/www': [
      { path: '/var/www/a.php', isDirectory: false, isSymbolicLink: false, size: 10 },
      { path: '/var/www/b.php', isDirectory: false, isSymbolicLink: false, size: 20 },
      { path: '/var/www/c.php', isDirectory: false, isSymbolicLink: false, size: 30 },
    ],
  };

  it('keeps downloading the rest when one file fails, and reports the failure instead of throwing', async () => {
    const downloadFile = vi.fn().mockImplementation(async (remotePath: string) => {
      if (remotePath === '/var/www/b.php') throw new Error('fastGet: Failure');
    });
    const reportProgress = vi.fn();

    const result = await runFolderDownload(root, listRemoteFixture(tree), downloadFile, reportProgress);

    expect(downloadFile).toHaveBeenCalledTimes(3);
    expect(result.downloaded).toEqual(['/var/www/a.php', '/var/www/c.php']);
    expect(result.failed).toEqual([{ remotePath: '/var/www/b.php', message: 'fastGet: Failure' }]);
    expect(result.cancelled).toBe(false);
    expect(reportProgress).toHaveBeenCalledTimes(2);
  });

  it('keeps uploading the rest when one file fails, and reports the failure instead of throwing', async () => {
    const uploadFile = vi.fn().mockImplementation(async (remotePath: string) => {
      if (remotePath === '/var/www/b.php') throw new Error('fastPut: Permission denied');
    });

    const result = await runFolderUpload(
      root,
      listRemoteFixture(tree),
      uploadFile,
      vi.fn().mockResolvedValue(false),
      vi.fn(),
    );

    expect(uploadFile).toHaveBeenCalledTimes(3);
    expect(result.uploaded).toEqual(['/var/www/a.php', '/var/www/c.php']);
    expect(result.failed).toEqual([{ remotePath: '/var/www/b.php', message: 'fastPut: Permission denied' }]);
  });

  it('records an unreadable file as failed instead of aborting the whole upload on a stat error', async () => {
    const uploadFile = vi.fn().mockResolvedValue(undefined);
    const checkForConflict = vi.fn().mockImplementation(async (remotePath: string) => {
      if (remotePath === '/var/www/a.php') throw new Error('stat: No such file');
      return false;
    });

    const result = await runFolderUpload(
      root,
      listRemoteFixture(tree),
      uploadFile,
      checkForConflict,
      vi.fn(),
    );

    expect(result.uploaded).toEqual(['/var/www/b.php', '/var/www/c.php']);
    expect(result.failed).toEqual([{ remotePath: '/var/www/a.php', message: 'stat: No such file' }]);
    expect(uploadFile).not.toHaveBeenCalledWith('/var/www/a.php');
  });

  it('reports downloaded symlinks separately so the caller can warn they arrived as plain files', async () => {
    const symlinkTree: Record<string, RemoteEntry[]> = {
      '/var/www': [
        { path: '/var/www/real.php', isDirectory: false, isSymbolicLink: false, size: 1 },
        { path: '/var/www/link.php', isDirectory: false, isSymbolicLink: true, size: 1 },
      ],
    };
    const result = await runFolderDownload(root, listRemoteFixture(symlinkTree), vi.fn(), vi.fn());

    expect(result.downloaded).toEqual(['/var/www/real.php', '/var/www/link.php']);
    expect(result.symlinked).toEqual(['/var/www/link.php']);
  });

  it('ensures every plan directory through the caller-supplied callback', async () => {
    const dirTree: Record<string, RemoteEntry[]> = {
      '/var/www': [{ path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 }],
      '/var/www/app': [{ path: '/var/www/app/config.php', isDirectory: false, isSymbolicLink: false, size: 1 }],
    };
    const ensureDir = vi.fn().mockResolvedValue(undefined);

    await runFolderDownload(root, listRemoteFixture(dirTree), vi.fn(), vi.fn(), { ensureDir });
    expect(ensureDir).toHaveBeenCalledWith('/var/www');
    expect(ensureDir).toHaveBeenCalledWith('/var/www/app');

    ensureDir.mockClear();
    await runFolderUpload(
      root,
      listRemoteFixture(dirTree),
      vi.fn(),
      vi.fn().mockResolvedValue(false),
      vi.fn(),
      undefined,
      { ensureDir },
    );
    expect(ensureDir).toHaveBeenCalledWith('/var/www');
    expect(ensureDir).toHaveBeenCalledWith('/var/www/app');
  });

  it('retries only the failed subset when onlyPaths is given', async () => {
    const uploadFile = vi.fn().mockResolvedValue(undefined);

    const result = await runFolderUpload(
      root,
      listRemoteFixture(tree),
      uploadFile,
      vi.fn().mockResolvedValue(false),
      vi.fn(),
      undefined,
      { onlyPaths: new Set(['/var/www/b.php']) },
    );

    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(uploadFile).toHaveBeenCalledWith('/var/www/b.php');
    expect(result.uploaded).toEqual(['/var/www/b.php']);
  });
});
