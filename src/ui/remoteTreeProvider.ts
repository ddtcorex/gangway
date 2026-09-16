import * as vscode from 'vscode';
import type { RemoteEntry } from '../folderQueue';

export interface RemoteTreeNode {
  entry: RemoteEntry;
}

type ListRemote = (dirPath: string) => Promise<RemoteEntry[]>;

export class RemoteTreeProvider implements vscode.TreeDataProvider<RemoteTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<RemoteTreeNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly rootPath: string,
    private readonly listRemote: ListRemote,
  ) {}

  async getChildren(node?: RemoteTreeNode): Promise<RemoteTreeNode[]> {
    const dirPath = node?.entry.path ?? this.rootPath;
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
