import * as vscode from 'vscode';
import { isLocallyModified } from '../dirtyState';

/**
 * Decorates any resourceUri VS Code asks about -- the GangwayTreeProvider's
 * own file nodes (their resourceUri is the local tmp-mirror path, see
 * gangwayTreeProvider.ts) and, for a currently open editor tab, the tab
 * itself -- with a small "M" badge whenever the local file has diverged from
 * the copy last known to match the server. This is the same native
 * decoration mechanism VS Code's own Git integration uses for modified
 * files, so it needs no bespoke UI of its own.
 */
export class DirtyDecorationProvider implements vscode.FileDecorationProvider {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changeEmitter.event;

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    if (uri.scheme !== 'file') return undefined;
    if (!(await isLocallyModified(uri.fsPath))) return undefined;
    return {
      badge: 'M',
      color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
      tooltip: 'Modified locally since the last download or upload',
    };
  }

  /** Call after any operation that could change a file's dirty state
   * (a save, a successful upload, a fresh download) so VS Code re-queries
   * instead of caching the old decoration indefinitely. Omit the argument to
   * refresh every decoration this provider has ever supplied. */
  refresh(uri?: vscode.Uri | vscode.Uri[]): void {
    this.changeEmitter.fire(uri);
  }
}
