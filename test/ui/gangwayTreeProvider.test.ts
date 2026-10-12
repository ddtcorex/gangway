import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { GANGWAY_DRAG_MIME, GangwayTreeProvider, type SelectorNode, type RemoteTreeNode } from '../../src/ui/gangwayTreeProvider';
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

    it('still returns the selector row and reports the error, instead of leaving getChildren() rejected, when connect() fails', async () => {
      // A rejected getChildren() used to have nothing catching it: VS Code's
      // tree view just stayed on its built-in loading spinner forever, with
      // no error and no way to pick a different connection -- discovered by
      // driving a real Extension Development Host end to end, not by any
      // unit test (every collaborator here was individually mocked to
      // succeed, so the gap was invisible until connect() genuinely failed).
      const target = connection();
      const connect = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const listRemote = vi.fn();
      const onRootError = vi.fn();
      const provider = new GangwayTreeProvider(() => [target], () => target.id, connect, listRemote, localUriFor, onRootError);

      const roots = await provider.getChildren();

      expect(roots).toEqual([SELECTOR]);
      expect(listRemote).not.toHaveBeenCalled();
      expect(onRootError).toHaveBeenCalledWith(expect.objectContaining({ message: 'ECONNREFUSED' }));
    });

    it('still returns the selector row and reports the error when connect() succeeds but listRemote() fails', async () => {
      const target = connection();
      const connect = vi.fn().mockResolvedValue(undefined);
      const listRemote = vi.fn().mockRejectedValue(new Error('permission denied'));
      const onRootError = vi.fn();
      const provider = new GangwayTreeProvider(() => [target], () => target.id, connect, listRemote, localUriFor, onRootError);

      const roots = await provider.getChildren();

      expect(roots).toEqual([SELECTOR]);
      expect(onRootError).toHaveBeenCalledWith(expect.objectContaining({ message: 'permission denied' }));
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

    it('attaches an internalFileClick command to a file entry, none to a folder -- TreeItem.command fires on every click (unlike TreeView.onDidChangeSelection, which VS Code skips for a click that reselects the already-selected item), so the double-click timing lives in that command\'s handler, not a selection listener', () => {
      const provider = new GangwayTreeProvider(() => [], () => undefined, vi.fn(), vi.fn(), localUriFor);
      const folder: RemoteTreeNode = { connectionId: 'c1', entry: { path: '/var/www/app', isDirectory: true, isSymbolicLink: false, size: 0 } };
      const file: RemoteTreeNode = { connectionId: 'c1', entry: { path: '/var/www/config.php', isDirectory: false, isSymbolicLink: false, size: 1 } };

      expect(provider.getTreeItem(folder).command).toBeUndefined();
      expect(provider.getTreeItem(file).command).toEqual({
        command: 'gangway.internalFileClick',
        title: 'Open File',
        arguments: [file],
      });
    });
  });

  describe('symlink entries', () => {
    const provider = () => new GangwayTreeProvider(() => [], () => undefined, vi.fn(), vi.fn(), localUriFor);
    const linkNode = (link: RemoteTreeNode['entry']['link'], isDirectory: boolean): RemoteTreeNode => ({
      connectionId: 'c1',
      entry: { path: '/var/www/ln', isDirectory, isSymbolicLink: true, size: 0, link },
    });

    it('dir link is collapsible and uses gangway.folder', () => {
      const item = provider().getTreeItem(linkNode({ realPath: '/var/www/app', kind: 'dir' }, true));
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
      expect(item.contextValue).toBe('gangway.folder');
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('file-symlink-directory');
    });

    it('file link keeps the open command', () => {
      const node = linkNode({ realPath: '/var/www/a.php', kind: 'file' }, false);
      const item = provider().getTreeItem(node);
      expect(item.contextValue).toBe('gangway.file');
      expect(item.command).toEqual({ command: 'gangway.internalFileClick', title: 'Open File', arguments: [node] });
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('file-symlink-file');
    });

    it('broken link has gangway.brokenLink and no open command', () => {
      const item = provider().getTreeItem(linkNode({ realPath: '/var/www/ln', kind: 'broken' }, false));
      expect(item.contextValue).toBe('gangway.brokenLink');
      expect(item.description).toBe('broken link');
      expect(item.command?.title).toBe('Broken Link');
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('file-symlink-file');
      const loop = provider().getTreeItem(linkNode({ realPath: '/var/www/ln', kind: 'loop' }, false));
      expect(loop.contextValue).toBe('gangway.brokenLink');
      expect(loop.description).toBe('link loop');
      expect(loop.command?.title).toBe('Broken Link');
    });

    it('unresolved link is dimmed, labelled, and still deletable', () => {
      const item = provider().getTreeItem(linkNode({ realPath: '/var/www/ln', kind: 'unresolved' }, false));
      expect(item.contextValue).toBe('gangway.brokenLink');
      expect(item.description).toBe('unresolved link');
      expect(item.command?.command).toBe('gangway.internalFileClick');
      expect(item.command?.title).toBe('Unresolved Link');
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('file-symlink-file');
    });

    it('expandable ancestor-loop link stays a collapsible folder but carries a warning', () => {
      const item = provider().getTreeItem(linkNode({ realPath: '/var', kind: 'loop' }, true));
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
      expect(item.contextValue).toBe('gangway.folder');
      expect(item.description).toBe('link loop');
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('file-symlink-directory');
    });

    it('tooltip shows the real path', () => {
      const item = provider().getTreeItem(linkNode({ realPath: '/srv/real.php', kind: 'file' }, false));
      expect(item.tooltip).toBe('ln -> /srv/real.php');
    });
  });

  describe('drag and drop', () => {
    const node = (entryPath: string, isDirectory = false): RemoteTreeNode => ({
      connectionId: 'c1',
      entry: { path: entryPath, isDirectory, isSymbolicLink: false, size: 1 } as RemoteEntry,
    });
    const make = (onMove?: (...args: unknown[]) => Promise<void>) =>
      new GangwayTreeProvider(() => [], () => undefined, vi.fn(), vi.fn(), localUriFor, () => {}, onMove as never);
    const transferWith = (value: string | undefined, mime = GANGWAY_DRAG_MIME) => ({
      get: (m: string) => (m === mime && value !== undefined ? new vscode.DataTransferItem(value) : undefined),
    });
    const dragTransfer = () => {
      const store = new Map<string, vscode.DataTransferItem>();
      return { store, set: (m: string, item: vscode.DataTransferItem) => void store.set(m, item) };
    };

    it('accepts only its own drag type, never text/uri-list', () => {
      expect(make().dropMimeTypes).toEqual([GANGWAY_DRAG_MIME]);
      expect(make().dragMimeTypes).toEqual([GANGWAY_DRAG_MIME]);
    });

    it('drags the connection id and every dragged path', async () => {
      const t = dragTransfer();
      await make().handleDrag([node('/var/www/a.php'), node('/var/www/dir', true)], t as never, {} as never);
      expect(JSON.parse(await t.store.get(GANGWAY_DRAG_MIME)!.asString())).toEqual({
        connectionId: 'c1',
        paths: ['/var/www/a.php', '/var/www/dir'],
      });
    });

    it('never drags the selector row, and sets nothing when only it was selected', async () => {
      const t = dragTransfer();
      await make().handleDrag([SELECTOR, node('/var/www/a.php')], t as never, {} as never);
      expect(JSON.parse(await t.store.get(GANGWAY_DRAG_MIME)!.asString()).paths).toEqual(['/var/www/a.php']);
      const empty = dragTransfer();
      await make().handleDrag([SELECTOR], empty as never, {} as never);
      expect(empty.store.size).toBe(0);
    });

    it('forwards a folder target as the destination', async () => {
      const onMove = vi.fn().mockResolvedValue(undefined);
      const target = node('/var/www/dir', true);
      await make(onMove).handleDrop(target, transferWith(JSON.stringify({ connectionId: 'c1', paths: ['/var/www/a.php'] })) as never, {} as never);
      expect(onMove).toHaveBeenCalledWith(target, 'c1', ['/var/www/a.php']);
    });

    it('forwards a file target as is (the extension resolves its parent)', async () => {
      const onMove = vi.fn().mockResolvedValue(undefined);
      const target = node('/var/www/dir/x.php');
      await make(onMove).handleDrop(target, transferWith(JSON.stringify({ connectionId: 'c1', paths: ['/var/www/a.php'] })) as never, {} as never);
      expect(onMove).toHaveBeenCalledWith(target, 'c1', ['/var/www/a.php']);
    });

    it('forwards undefined for empty tree space', async () => {
      const onMove = vi.fn().mockResolvedValue(undefined);
      await make(onMove).handleDrop(undefined, transferWith(JSON.stringify({ connectionId: 'c1', paths: ['/var/www/a.php'] })) as never, {} as never);
      expect(onMove).toHaveBeenCalledWith(undefined, 'c1', ['/var/www/a.php']);
    });

    it('ignores a drop on the selector row', async () => {
      const onMove = vi.fn().mockResolvedValue(undefined);
      await make(onMove).handleDrop(SELECTOR, transferWith(JSON.stringify({ connectionId: 'c1', paths: ['/var/www/a.php'] })) as never, {} as never);
      expect(onMove).not.toHaveBeenCalled();
    });

    it.each([
      ['a foreign mime type', transferWith('file:///tmp/a.php', 'text/uri-list')],
      ['unparsable JSON', transferWith('{nope')],
      ['an empty path list', transferWith(JSON.stringify({ connectionId: 'c1', paths: [] }))],
      ['a payload with the wrong shape', transferWith(JSON.stringify({ connectionId: 1, paths: ['x'] }))],
      ['no data at all', transferWith(undefined)],
    ])('ignores %s', async (_name, transfer) => {
      const onMove = vi.fn().mockResolvedValue(undefined);
      await expect(make(onMove).handleDrop(node('/var/www/dir', true), transfer as never, {} as never)).resolves.toBeUndefined();
      expect(onMove).not.toHaveBeenCalled();
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
