import * as vscode from 'vscode';
import type { RemoteEntry } from '../folderQueue';

export interface RemoteTreeNode {
  entry: RemoteEntry;
}

type ListRemote = (dirPath: string) => Promise<RemoteEntry[]>;

/**
 * Either a fixed root, or a resolver consulted on every expansion. The
 * resolver form is what lets `activate()` create the view unconditionally at
 * boot: a brand-new user has no connection bound yet, and the root only
 * becomes known once they save one. Returning `undefined` renders an empty
 * tree rather than calling the server.
 */
export type RootPath = string | (() => string | undefined);

export class RemoteTreeProvider implements vscode.TreeDataProvider<RemoteTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<RemoteTreeNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly rootPath: RootPath,
    private readonly listRemote: ListRemote,
  ) {}

  async getChildren(node?: RemoteTreeNode): Promise<RemoteTreeNode[]> {
    const dirPath = node?.entry.path ?? (typeof this.rootPath === 'string' ? this.rootPath : this.rootPath());
    if (!dirPath) return [];
    const entries = await this.listRemote(dirPath);
    return entries.map((entry) => ({ entry }));
  }

  getTreeItem(node: RemoteTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.entry.path.split('/').pop() ?? node.entry.path,
      node.entry.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = new vscode.ThemeIcon(
      node.entry.isDirectory ? 'folder' : node.entry.isSymbolicLink ? 'file-symlink-file' : 'file',
    );
    item.contextValue = node.entry.isDirectory ? 'gangway.folder' : 'gangway.file';
    return item;
  }

  refresh(node?: RemoteTreeNode): void {
    this.changeEmitter.fire(node);
  }
}
