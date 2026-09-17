import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { GangwayTreeProvider, type SelectorNode, type RemoteTreeNode } from '../../src/ui/gangwayTreeProvider';
import type { RemoteEntry } from '../../src/folderQueue';
import type { ConnectionConfig } from '../../src/types';

function connection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: 'c1',
    name: 'staging',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    remotePath: '/var/www',
    authMethod: 'password',
    ...overrides,
  };
}

function localUriFor(connectionId: string, remotePath: string): vscode.Uri {
  return vscode.Uri.file(`/tmp/gangway-test/${connectionId}${remotePath}`);
}

const SELECTOR: SelectorNode = { kind: 'selector' };

describe('GangwayTreeProvider', () => {
  describe('root children', () => {
    it('is just the selector row when no connection is bound', async () => {
      const provider = new GangwayTreeProvider(
        () => [connection()],
        () => undefined,
        vi.fn().mockResolvedValue(undefined),
        vi.fn().mockResolvedValue([{ path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 }]),
        localUriFor,
      );

      const roots = await provider.getChildren();

      expect(roots).toEqual([SELECTOR]);
    });

    it('connects (idempotently, via the injected connect callback) and lists the bound connection root, after the selector row', async () => {
      const target = connection();
      const connect = vi.fn().mockResolvedValue(undefined);
      const listRemote = vi.fn(async (_c: ConnectionConfig, dirPath: string): Promise<RemoteEntry[]> =>
        dirPath === '/var/www' ? [{ path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 }] : [],
      );
      const provider = new GangwayTreeProvider(() => [target], () => target.id, connect, listRemote, localUriFor);

      const roots = (await provider.getChildren()) as Array<SelectorNode | RemoteTreeNode>;

      expect(connect).toHaveBeenCalledWith(target);
      expect(listRemote).toHaveBeenCalledWith(target, '/var/www');
      expect(roots[0]).toEqual(SELECTOR);
      expect((roots[1] as RemoteTreeNode).entry.path).toBe('/var/www/app');
      expect((roots[1] as RemoteTreeNode).connectionId).toBe(target.id);
    });

    it('never calls connect/listRemote when the bound id no longer matches a saved connection', async () => {
      const connect = vi.fn();
      const listRemote = vi.fn();
      const provider = new GangwayTreeProvider(() => [], () => 'deleted-id', connect, listRemote, localUriFor);

      const roots = await provider.getChildren();

      expect(roots).toEqual([SELECTOR]);
      expect(connect).not.toHaveBeenCalled();
      expect(listRemote).not.toHaveBeenCalled();
    });
  });

  it('the selector node itself has no children', async () => {
    const provider = new GangwayTreeProvider(() => [], () => undefined, vi.fn(), vi.fn(), localUriFor);
    expect(await provider.getChildren(SELECTOR)).toEqual([]);
  });

  it('lists a nested folder using its own connection, not necessarily the currently bound one', async () => {
    const other = connection({ id: 'other', name: 'other-box', remotePath: '/srv' });
    const listRemote = vi.fn(async (_c: ConnectionConfig, dirPath: string): Promise<RemoteEntry[]> =>
      dirPath === '/srv/app' ? [{ path: '/srv/app/config.php', isDirectory: false, isSymbolicLink: false, size: 5 }] : [],
    );
    const provider = new GangwayTreeProvider(
      () => [other],
      () => 'some-other-bound-id',
      vi.fn().mockResolvedValue(undefined),
      listRemote,
      localUriFor,
    );

    const folderNode: RemoteTreeNode = {
      connectionId: 'other',
      entry: { path: '/srv/app', isDirectory: true, isSymbolicLink: false, size: 0 },
    };
    const children = (await provider.getChildren(folderNode)) as RemoteTreeNode[];

    expect(listRemote).toHaveBeenCalledWith(other, '/srv/app');
    expect(children[0].entry.path).toBe('/srv/app/config.php');
  });

  it('sorts entries folders-before-files, alphabetically within each group', async () => {
    const target = connection();
    const listRemote = vi.fn().mockResolvedValue([
      { path: '/var/www/zeta.php', isDirectory: false, isSymbolicLink: false, size: 1 },
      { path: '/var/www/zoo', isDirectory: true, isSymbolicLink: false, size: 0 },
      { path: '/var/www/alpha.php', isDirectory: false, isSymbolicLink: false, size: 1 },
      { path: '/var/www/apple', isDirectory: true, isSymbolicLink: false, size: 0 },
    ]);
    const provider = new GangwayTreeProvider(() => [target], () => target.id, vi.fn().mockResolvedValue(undefined), listRemote, localUriFor);

    const roots = (await provider.getChildren()) as Array<SelectorNode | RemoteTreeNode>;
    const entries = roots.slice(1) as RemoteTreeNode[];

    expect(entries.map((c) => c.entry.path)).toEqual([
      '/var/www/apple',
      '/var/www/zoo',
      '/var/www/alpha.php',
      '/var/www/zeta.php',
    ]);
  });

  describe('getTreeItem for the selector row', () => {
    it('shows a placeholder label when no connection is bound', () => {
      const provider = new GangwayTreeProvider(() => [], () => undefined, vi.fn(), vi.fn(), localUriFor);

      const item = provider.getTreeItem(SELECTOR);

      expect(item.label).toBe('Select a connection...');
      expect(item.description).toBeUndefined();
      expect(item.command).toEqual({ command: 'gangway.pickConnection', title: 'Switch Connection' });
      expect(item.contextValue).toBe('gangway.selector');
    });

    it('shows the bound connection name and address as description', () => {
      const target = connection({ name: 'staging', username: 'deploy', host: 'example.com', port: 22 });
      const provider = new GangwayTreeProvider(() => [target], () => target.id, vi.fn(), vi.fn(), localUriFor);

      const item = provider.getTreeItem(SELECTOR);

      expect(item.label).toBe('staging');
      expect(item.description).toBe('deploy@example.com:22');
    });
  });

  describe('getTreeItem for an entry node', () => {
    it('sets a distinct icon per entry kind: file, folder, symlink', () => {
      const provider = new GangwayTreeProvider(() => [], () => undefined, vi.fn(), vi.fn(), localUriFor);
      const folder: RemoteTreeNode = { connectionId: 'c1', entry: { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 } };
      const file: RemoteTreeNode = { connectionId: 'c1', entry: { path: '/var/www/file.php', isDirectory: false, isSymbolicLink: false, size: 1 } };
      const symlink: RemoteTreeNode = { connectionId: 'c1', entry: { path: '/var/www/link.php', isDirectory: false, isSymbolicLink: true, size: 1 } };

      expect(provider.getTreeItem(folder).iconPath).toBeUndefined();
      expect(provider.getTreeItem(file).iconPath).toBeUndefined();
      expect((provider.getTreeItem(symlink).iconPath as vscode.ThemeIcon)?.id).toBe('file-symlink-file');
    });

    it('sets resourceUri to the entry local tmp-mirror path, for native icons and dirty decorations', () => {
      const provider = new GangwayTreeProvider(() => [], () => undefined, vi.fn(), vi.fn(), localUriFor);
      const file: RemoteTreeNode = { connectionId: 'c1', entry: { path: '/var/www/app/config.php', isDirectory: false, isSymbolicLink: false, size: 1 } };

      expect(provider.getTreeItem(file).resourceUri?.fsPath).toBe('/tmp/gangway-test/c1/var/www/app/config.php');
    });

    it('attaches a command that opens the file on click, for non-directory entries only', () => {
      const provider = new GangwayTreeProvider(() => [], () => undefined, vi.fn(), vi.fn(), localUriFor);
      const folder: RemoteTreeNode = { connectionId: 'c1', entry: { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 } };
      const file: RemoteTreeNode = { connectionId: 'c1', entry: { path: '/var/www/config.php', isDirectory: false, isSymbolicLink: false, size: 1 } };

      expect(provider.getTreeItem(folder).command).toBeUndefined();
      expect(provider.getTreeItem(file).command).toEqual({
        command: 'gangway.downloadFile',
        title: 'Open',
        arguments: [file],
      });
    });
  });

  it('fires onDidChangeTreeData when refresh() is called', () => {
    const provider = new GangwayTreeProvider(() => [], () => undefined, vi.fn(), vi.fn(), localUriFor);
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);
    provider.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
