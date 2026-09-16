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
