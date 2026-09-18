import * as vscode from 'vscode';

export function createTmpStatusBarItem(connectionName: string, remotePath: string): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.text = `$(cloud) ${connectionName}:${remotePath}`;
  item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
  item.tooltip = 'This file is a tmp-backed copy of a remote server file, not a local project file.';
  item.show();
  return item;
}

/**
 * Owns the ONE tmp-file status bar item for the session. The previous shape
 * created a new item on every download and never disposed any of them, so N
 * downloads left N stale items behind. This tracks which local tmp paths
 * belong to which connection, retargets the single item on download, and
 * shows/hides it as the active editor moves between Gangway-managed files
 * and everything else. Registered in context.subscriptions, so the item dies
 * with the extension host.
 */
export class TmpStatusBar {
  private item: vscode.StatusBarItem | undefined;
  private readonly known = new Map<string, { connectionName: string; remotePath: string }>();

  get currentItem(): vscode.StatusBarItem | undefined {
    return this.item;
  }

  showFor(connectionName: string, remotePath: string, localPath: string): void {
    this.known.set(localPath, { connectionName, remotePath });
    if (!this.item) {
      this.item = createTmpStatusBarItem(connectionName, remotePath);
      return;
    }
    this.item.text = `$(cloud) ${connectionName}:${remotePath}`;
    this.item.show();
  }

  handleActiveEditorChanged(fsPath: string | undefined): void {
    const known = fsPath ? this.known.get(fsPath) : undefined;
    if (!this.item) return;
    if (!known) {
      this.item.hide();
      return;
    }
    this.item.text = `$(cloud) ${known.connectionName}:${known.remotePath}`;
    this.item.show();
  }

  dispose(): void {
    this.item?.dispose();
    this.item = undefined;
    this.known.clear();
  }
}
