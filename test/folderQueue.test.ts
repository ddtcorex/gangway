import { describe, it, expect } from 'vitest';
import { buildDownloadPlan, buildUploadPlan, TransferCancelledError } from '../src/folderQueue';
import type { RemoteEntry } from '../src/folderQueue';

function listRemoteFixture(tree: Record<string, RemoteEntry[]>) {
  return async (dirPath: string) => tree[dirPath] ?? [];
}

describe('buildDownloadPlan', () => {
  it('recurses into directories and includes symlinks as plain-file downloads with a warning', async () => {
    const tree: Record<string, RemoteEntry[]> = {
      '/var/www': [
        { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 },
        { path: '/var/www/shared.php', isDirectory: false, isSymbolicLink: true, size: 5 },
      ],
      '/var/www/app': [{ path: '/var/www/app/config.php', isDirectory: false, isSymbolicLink: false, size: 42 }],
    };
    const plan = await buildDownloadPlan({ path: '/var/www', isDirectory: true, isSymbolicLink: false, size: 0 }, listRemoteFixture(tree));

    expect(plan.map((t) => t.remotePath).sort()).toEqual(['/var/www/app/config.php', '/var/www/shared.php']);
    const symlinkTask = plan.find((t) => t.remotePath === '/var/www/shared.php');
    expect(symlinkTask?.isSymlink).toBe(true);
  });

  it('flags files over 5MB for a prompt-before-auto-open, but still includes them in the plan', async () => {
    const bigFile: RemoteEntry = { path: '/var/www/big.bin', isDirectory: false, isSymbolicLink: false, size: 6 * 1024 * 1024 };
    const tree: Record<string, RemoteEntry[]> = { '/var/www': [bigFile] };
    const plan = await buildDownloadPlan({ path: '/var/www', isDirectory: true, isSymbolicLink: false, size: 0 }, listRemoteFixture(tree));
    expect(plan[0].promptBeforeAutoOpen).toBe(true);
  });

  it('respects cancellation mid-traversal', async () => {
    const controller = new AbortController();
    const tree: Record<string, RemoteEntry[]> = {
      '/var/www': [{ path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 }],
      '/var/www/app': [{ path: '/var/www/app/config.php', isDirectory: false, isSymbolicLink: false, size: 1 }],
    };
    const listRemote = async (dirPath: string) => {
      controller.abort();
      return tree[dirPath] ?? [];
    };
    await expect(
      buildDownloadPlan({ path: '/var/www', isDirectory: true, isSymbolicLink: false, size: 0 }, listRemote, controller.signal),
    ).rejects.toThrow(TransferCancelledError);
  });

  it('never recurses into a directory symlink, preventing infinite recursion on cyclic links', async () => {
    let listRemoteCallCount = 0;
    const tree: Record<string, RemoteEntry[]> = {
      '/var/www': [
        { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 },
        { path: '/var/www/self', isDirectory: true, isSymbolicLink: true, size: 0 },
      ],
      '/var/www/app': [{ path: '/var/www/app/config.php', isDirectory: false, isSymbolicLink: false, size: 1 }],
    };
    const listRemote = async (dirPath: string) => {
      listRemoteCallCount++;
      // If we were to recurse into /var/www/self, it would return the same children as /var/www again, causing infinite recursion
      if (dirPath === '/var/www/self') {
        throw new Error('Should not recurse into directory symlink');
      }
      return tree[dirPath] ?? [];
    };
    const plan = await buildDownloadPlan(
      { path: '/var/www', isDirectory: true, isSymbolicLink: false, size: 0 },
      listRemote,
    );
    // Plan should include the directory symlink as a leaf entry (not recursed into)
    expect(plan.map((t) => t.remotePath).sort()).toEqual(['/var/www/app/config.php', '/var/www/self']);
    const symlinkTask = plan.find((t) => t.remotePath === '/var/www/self');
    expect(symlinkTask?.isSymlink).toBe(true);
    // listRemote should only be called twice: /var/www and /var/www/app (never /var/www/self)
    expect(listRemoteCallCount).toBe(2);
  });
});

describe('buildUploadPlan', () => {
  it('never recreates symlinks on upload: they are excluded from the plan and reported separately', async () => {
    const tree: Record<string, RemoteEntry[]> = {
      '/var/www': [
        { path: '/var/www/app.php', isDirectory: false, isSymbolicLink: false, size: 1 },
        { path: '/var/www/shared.php', isDirectory: false, isSymbolicLink: true, size: 1 },
      ],
    };
    const { tasks, skippedSymlinks } = await buildUploadPlan(
      { path: '/var/www', isDirectory: true, isSymbolicLink: false, size: 0 },
      listRemoteFixture(tree),
    );
    expect(tasks.map((t) => t.remotePath)).toEqual(['/var/www/app.php']);
    expect(skippedSymlinks).toEqual(['/var/www/shared.php']);
  });

  it('excludes directory symlinks from upload tasks and puts them in skippedSymlinks', async () => {
    const tree: Record<string, RemoteEntry[]> = {
      '/var/www': [
        { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 },
        { path: '/var/www/shared-dir', isDirectory: true, isSymbolicLink: true, size: 0 },
      ],
      '/var/www/app': [{ path: '/var/www/app/config.php', isDirectory: false, isSymbolicLink: false, size: 1 }],
    };
    const { tasks, skippedSymlinks } = await buildUploadPlan(
      { path: '/var/www', isDirectory: true, isSymbolicLink: false, size: 0 },
      listRemoteFixture(tree),
    );
    // Directory symlink should not be recursed into; only real directory's contents should be in tasks
    expect(tasks.map((t) => t.remotePath)).toEqual(['/var/www/app/config.php']);
    // The directory symlink itself should be in skippedSymlinks, not in tasks
    expect(skippedSymlinks).toEqual(['/var/www/shared-dir']);
  });
});
