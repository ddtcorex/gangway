import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { RemoteTreeProvider } from '../../src/ui/remoteTreeProvider';
import type { RemoteEntry } from '../../src/folderQueue';

describe('RemoteTreeProvider', () => {
  it('lazily lists only the root until a folder node is expanded', async () => {
    const listRemote = vi.fn(async (dirPath: string): Promise<RemoteEntry[]> => {
      if (dirPath === '/var/www') {
        return [{ path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 }];
      }
      if (dirPath === '/var/www/app') {
        return [{ path: '/var/www/app/config.php', isDirectory: false, isSymbolicLink: false, size: 42 }];
      }
      return [];
    });
    const provider = new RemoteTreeProvider('/var/www', listRemote);

    const roots = await provider.getChildren();
    expect(listRemote).toHaveBeenCalledTimes(1);
    expect(roots).toHaveLength(1);
    expect(roots[0].entry.path).toBe('/var/www/app');

    const children = await provider.getChildren(roots[0]);
    expect(listRemote).toHaveBeenCalledTimes(2);
    expect(children[0].entry.path).toBe('/var/www/app/config.php');
  });

  it('sets a distinct icon per entry kind: file, folder, symlink', async () => {
    const listRemote = vi.fn(async (): Promise<RemoteEntry[]> => [
      { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 },
      { path: '/var/www/file.php', isDirectory: false, isSymbolicLink: false, size: 1 },
      { path: '/var/www/link.php', isDirectory: false, isSymbolicLink: true, size: 1 },
    ]);
    const provider = new RemoteTreeProvider('/var/www', listRemote);
    const [folder, file, symlink] = await provider.getChildren();

    expect((provider.getTreeItem(folder).iconPath as vscode.ThemeIcon)?.id).toBe('folder');
    expect((provider.getTreeItem(file).iconPath as vscode.ThemeIcon)?.id).toBe('file');
    expect((provider.getTreeItem(symlink).iconPath as vscode.ThemeIcon)?.id).toBe('file-symlink-file');
  });

  it('fires onDidChangeTreeData when refresh() is called', () => {
    const provider = new RemoteTreeProvider('/var/www', async () => []);
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);
    provider.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
