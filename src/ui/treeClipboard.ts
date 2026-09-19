import type { ClipboardState } from '../remoteOps';

export type { ClipboardState };

/**
 * The Gangway tree clipboard: which remote entries a cut/copy picked up.
 * Pure state transitions only — the extension owns the single live instance
 * and remoteOps.ts consumes it. No vscode import: fully unit-testable.
 */
export function copyToClipboard(
  _state: ClipboardState,
  connectionId: string,
  paths: string[],
): ClipboardState {
  return { connectionId, paths: [...paths], cut: false };
}

export function cutToClipboard(
  _state: ClipboardState,
  connectionId: string,
  paths: string[],
): ClipboardState {
  return { connectionId, paths: [...paths], cut: true };
}

export function clearClipboard(): ClipboardState {
  return { connectionId: '', paths: [], cut: false };
}
