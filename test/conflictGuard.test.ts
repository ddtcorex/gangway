import { describe, it, expect } from 'vitest';
import { checkConflict } from '../src/conflictGuard';
import type { SidecarMeta, RemoteStat } from '../src/types';

const sidecar: SidecarMeta = {
  connectionId: 'c1',
  remotePath: '/var/www/app/config.php',
  mtime: 1700000000,
  size: 42,
  downloadedAt: 1700000005,
};

describe('checkConflict', () => {
  it('reports clean when mtime and size still match the download-time sidecar', () => {
    const fresh: RemoteStat = { mtime: 1700000000, size: 42, isDirectory: false, isSymbolicLink: false };
    expect(checkConflict(sidecar, fresh)).toBe('clean');
  });

  it('reports conflict when mtime differs', () => {
    const fresh: RemoteStat = { mtime: 1700009999, size: 42, isDirectory: false, isSymbolicLink: false };
    expect(checkConflict(sidecar, fresh)).toBe('conflict');
  });

  it('reports conflict when size differs even if mtime matches', () => {
    const fresh: RemoteStat = { mtime: 1700000000, size: 999, isDirectory: false, isSymbolicLink: false };
    expect(checkConflict(sidecar, fresh)).toBe('conflict');
  });
});
