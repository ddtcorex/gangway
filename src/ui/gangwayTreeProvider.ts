import * as vscode from 'vscode';
import type { RemoteEntry } from '../folderQueue';
import type { ConnectionConfig } from '../types';

export interface ConnectionNode {
  connection: ConnectionConfig;
}

export interface RemoteTreeNode {
  connectionId: string;
  entry: RemoteEntry;
}

export type GangwayTreeNode = ConnectionNode | RemoteTreeNode;

function isConnectionNode(node: GangwayTreeNode): node is ConnectionNode {
  return 'connection' in node;
}

/** Directories first, then files, each block alphabetical -- the same
 * ordering convention as VS Code's own local Explorer. */
function compareEntries(a: RemoteEntry, b: RemoteEntry): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  return a.path.localeCompare(b.path);
}

/**
 * The single view backing the Gangway activity bar tab (PhpStorm's "Remote
 * Host" tool window is the closest native analogue): every saved connection
 * is a root node, sorted by name; expanding one connects (idempotently -- the
 * underlying ConnectionPool is already keyed by connection id, so expanding
 * an already-open connection is a cache hit, not a second handshake) and
 * lists its remote root directly nested underneath, exactly like PhpStorm's
 * host row expanding into its file tree. Nothing here assumes only one
 * connection is ever open: each entry node carries its own connectionId, so
 * browsing connection B's subtree never depends on B being "the" workspace
 * binding -- only single-file keybindings (which have no tree node to read a
 * connectionId from) fall back to that binding.
 */
export class GangwayTreeProvider implements vscode.TreeDataProvider<GangwayTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<GangwayTreeNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly listConnections: () => ConnectionConfig[],
    private readonly boundConnectionId: () => string | undefined,
    /** Ensures a pooled client exists for this connection and binds it to the
     * workspace. Expanding a connection node is how a user "connects" in
     * this UI, mirroring PhpStorm's host-row expand gesture. */
    private readonly connect: (connection: ConnectionConfig) => Promise<void>,
    private readonly listRemote: (connection: ConnectionConfig, dirPath: string) => Promise<RemoteEntry[]>,
    /** Maps a connection + remote path to the local file it would live at
     * once downloaded (tmpFilePathFor's mapping), even before any download
     * has happened -- a pure path computation, not a filesystem check. Used
     * as each entry's `resourceUri` so the active icon theme renders the
     * same file-type icon local Explorer would, and so a
     * FileDecorationProvider watching that same local path can decorate
     * this node too. */
    private readonly localUriFor: (connectionId: string, remotePath: string) => vscode.Uri,
  ) {}

  async getChildren(node?: GangwayTreeNode): Promise<GangwayTreeNode[]> {
    if (!node) {
      return [...this.listConnections()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((connection): ConnectionNode => ({ connection }));
    }

    if (isConnectionNode(node)) {
      await this.connect(node.connection);
      const entries = await this.listRemote(node.connection, node.connection.remotePath);
      return this.toEntryNodes(node.connection.id, entries);
    }

    const connection = this.listConnections().find((c) => c.id === node.connectionId);
    if (!connection) return [];
    const entries = await this.listRemote(connection, node.entry.path);
    return this.toEntryNodes(node.connectionId, entries);
  }

  private toEntryNodes(connectionId: string, entries: RemoteEntry[]): RemoteTreeNode[] {
    return [...entries].sort(compareEntries).map((entry) => ({ connectionId, entry }));
  }

  getTreeItem(node: GangwayTreeNode): vscode.TreeItem {
    if (isConnectionNode(node)) {
      const { connection } = node;
      const isActive = this.boundConnectionId() === connection.id;
      const item = new vscode.TreeItem(connection.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${connection.username}@${connection.host}:${connection.port}`;
      item.tooltip = `${connection.remotePath} on ${connection.host}`;
      item.iconPath = new vscode.ThemeIcon(isActive ? 'vm-active' : 'vm-outline');
      item.contextValue = isActive ? 'gangway.connectionNode.active' : 'gangway.connectionNode';
      return item;
    }

    const item = new vscode.TreeItem(
      node.entry.path.split('/').pop() ?? node.entry.path,
      node.entry.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.resourceUri = this.localUriFor(node.connectionId, node.entry.path);
    // No iconPath for a plain file or folder: leaving it unset lets the
    // active icon theme resolve an icon from resourceUri, the same way it
    // does for local Explorer entries. A symlink is the one case an icon
    // theme cannot express on its own, so it keeps an explicit override.
    if (node.entry.isSymbolicLink) {
      item.iconPath = new vscode.ThemeIcon('file-symlink-file');
    }
    item.contextValue = node.entry.isDirectory ? 'gangway.folder' : 'gangway.file';
    if (!node.entry.isDirectory) {
      item.command = { command: 'gangway.downloadFile', title: 'Open', arguments: [node] };
    }
    return item;
  }

  refresh(node?: GangwayTreeNode): void {
    this.changeEmitter.fire(node);
  }
}
