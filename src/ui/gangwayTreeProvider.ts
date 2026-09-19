import * as vscode from 'vscode';
import type { RemoteEntry } from '../folderQueue';
import type { ConnectionConfig } from '../types';

/**
 * Always the first root node. Its label/description mirror whichever
 * connection is currently bound to the workspace (or a placeholder when
 * none is), and its command opens a QuickPick to switch -- a real HTML
 * <select> has no equivalent inside a TreeView, and a QuickPick is the
 * idiomatic native primitive for "pick one of these".
 */
export interface SelectorNode {
  kind: 'selector';
}

export interface RemoteTreeNode {
  connectionId: string;
  entry: RemoteEntry;
}

export type GangwayTreeNode = SelectorNode | RemoteTreeNode;

export function isSelectorNode(node: GangwayTreeNode): node is SelectorNode {
  return 'kind' in node && node.kind === 'selector';
}

/** Directories first, then files, each block alphabetical -- the same
 * ordering convention as VS Code's own local Explorer. */
function compareEntries(a: RemoteEntry, b: RemoteEntry): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  return a.path.localeCompare(b.path);
}

/**
 * The single view backing the Gangway activity bar tab. Only the connection
 * currently bound to the workspace is ever browsed here (a single active
 * deployment target): the root is the selector row followed
 * directly by that connection's own file tree, not a list of every saved
 * connection -- switching which one is bound (via the selector's QuickPick,
 * or the Manage Remotes page) is what changes what this tree shows.
 */
export class GangwayTreeProvider implements vscode.TreeDataProvider<GangwayTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<GangwayTreeNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly listConnections: () => ConnectionConfig[],
    private readonly boundConnectionId: () => string | undefined,
    /** Ensures a pooled client exists for the bound connection (the
     * underlying ConnectionPool is already keyed by connection id, so this
     * is a cache hit, not a second handshake, once connected). */
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
    /** Called when connecting or listing the bound connection's root fails
     * (bad credentials, unreachable host, ...). A connect failure here used
     * to reject getChildren() with nothing catching it, which left the tree
     * spinning forever with no feedback at all -- worse than any visible
     * error, since VS Code gives no indication that anything went wrong.
     * Real callers map and surface the error the same way every command
     * here already does; this stays a plain callback so the provider itself
     * never touches vscode.window directly, matching its existing style. */
    private readonly onRootError: (error: unknown) => void = () => {},
    /**
     * Local-Explorer/OS drops onto the tree. Kept as a callback for the same
     * reason as onRootError: the provider parses the transfer and forwards
     * it, the extension owns the upload. Undefined disables drops.
     */
    private readonly onDrop?: (node: RemoteTreeNode | undefined, uriListValue: string) => Promise<void>,
  ) {}

  /** Drops accepted from the local Explorer and the OS file manager. */
  readonly dropMimeTypes = ['text/uri-list'];

  async handleDrop(
    target: GangwayTreeNode | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const value = await dataTransfer.get('text/uri-list')?.asString();
    if (!value || !this.onDrop) return;
    const node = target !== undefined && !isSelectorNode(target) ? target : undefined;
    await this.onDrop(node, value);
  }

  private boundConnection(): ConnectionConfig | undefined {
    const id = this.boundConnectionId();
    return this.listConnections().find((c) => c.id === id);
  }

  async getChildren(node?: GangwayTreeNode): Promise<GangwayTreeNode[]> {
    if (!node) {
      const selector: SelectorNode = { kind: 'selector' };
      const connection = this.boundConnection();
      if (!connection) return [selector];
      try {
        await this.connect(connection);
        const entries = await this.listRemote(connection, connection.remotePath);
        return [selector, ...this.toEntryNodes(connection.id, entries)];
      } catch (err) {
        // The selector row must still render (so the user can pick a
        // different connection, or retry this one) instead of leaving the
        // whole view stuck on VS Code's built-in loading spinner forever.
        this.onRootError(err);
        return [selector];
      }
    }

    if (isSelectorNode(node)) return [];

    const connection = this.listConnections().find((c) => c.id === node.connectionId);
    if (!connection) return [];
    const entries = await this.listRemote(connection, node.entry.path);
    return this.toEntryNodes(node.connectionId, entries);
  }

  private toEntryNodes(connectionId: string, entries: RemoteEntry[]): RemoteTreeNode[] {
    return [...entries].sort(compareEntries).map((entry) => ({ connectionId, entry }));
  }

  getTreeItem(node: GangwayTreeNode): vscode.TreeItem {
    if (isSelectorNode(node)) {
      const connection = this.boundConnection();
      const item = new vscode.TreeItem(
        connection ? connection.name : 'Select a connection...',
        vscode.TreeItemCollapsibleState.None,
      );
      item.description = connection ? `${connection.username}@${connection.host}:${connection.port}` : undefined;
      item.tooltip = 'Click to switch the connection bound to this workspace';
      item.iconPath = new vscode.ThemeIcon('chevron-down');
      item.contextValue = 'gangway.selector';
      item.command = { command: 'gangway.pickConnection', title: 'Switch Connection' };
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
      // TreeItem.command fires on every click, including a click that
      // reselects the already-selected item -- unlike
      // TreeView.onDidChangeSelection, which VS Code only fires when the
      // selection actually changes, so it never sees the second half of a
      // real double click on the same node (that bug shipped once: see
      // extension.ts's gangway.internalFileClick handler for the timing
      // logic this depends on).
      item.command = { command: 'gangway.internalFileClick', title: 'Open File', arguments: [node] };
    }
    return item;
  }

  refresh(node?: GangwayTreeNode): void {
    this.changeEmitter.fire(node);
  }
}
