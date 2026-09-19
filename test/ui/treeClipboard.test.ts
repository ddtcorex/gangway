import { describe, it, expect, vi } from 'vitest';
import {
  clearClipboard,
  copyToClipboard,
  cutToClipboard,
  type ClipboardState,
} from '../../src/ui/treeClipboard';

const EMPTY: ClipboardState = { connectionId: '', paths: [], cut: false };

describe('treeClipboard', () => {
  it('copies and cuts within a connection as pure state transitions', () => {
    const copied = copyToClipboard(EMPTY, 'c1', ['/srv/app/a.php']);
    expect(copied).toEqual({ connectionId: 'c1', paths: ['/srv/app/a.php'], cut: false });
    const cut = cutToClipboard(EMPTY, 'c1', ['/srv/app/a.php', '/srv/app/b.php']);
    expect(cut).toEqual({ connectionId: 'c1', paths: ['/srv/app/a.php', '/srv/app/b.php'], cut: true });
    // No aliasing: the caller's arrays are copied.
    expect(cut.paths).not.toBe(copied.paths);
    expect(clearClipboard()).toEqual(EMPTY);
  });
});
