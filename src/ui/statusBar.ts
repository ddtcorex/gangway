import * as vscode from 'vscode';

export function createTmpStatusBarItem(connectionName: string, remotePath: string): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.text = `$(cloud) ${connectionName}:${remotePath}`;
  item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
  item.tooltip = 'This file is a tmp-backed copy of a remote server file, not a local project file.';
  item.show();
  return item;
}
