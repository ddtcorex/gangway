import { describe, it, expect } from 'vitest';
import { compareTrees, describeExcludedSelection, toQuickPickRow } from '../src/syncPreview';

describe('compareTrees', () => {
  it('classifies newer/older/only-side rows and formats the QuickPick label', () => {
    const rows = compareTrees(
      [{ path: 'a.php', mtime: 10, size: 5 }],
      [
        { path: 'a.php', mtime: 9, size: 5 },
        { path: 'b.php', mtime: 1, size: 1 },
      ],
    );
    expect(rows).toContainEqual(expect.objectContaining({ relativePath: 'a.php', verdict: 'Local-newer' }));
    expect(rows).toContainEqual(expect.objectContaining({ relativePath: 'b.php', verdict: 'Only-remote' }));
    expect(toQuickPickRow(rows[0]).label).toMatch(/Local-newer/);
    expect(toQuickPickRow(rows[0]).detail).toMatch(/10/);
  });

  it('marks same mtime but different size as conflict, identical as same', () => {
    const rows = compareTrees(
      [
        { path: 'same.php', mtime: 5, size: 5 },
        { path: 'clash.php', mtime: 5, size: 5 },
      ],
      [
        { path: 'same.php', mtime: 5, size: 5 },
        { path: 'clash.php', mtime: 5, size: 9 },
      ],
    );
    expect(rows.find((r) => r.relativePath === 'same.php')!.verdict).toBe('Same');
    expect(rows.find((r) => r.relativePath === 'clash.php')!.verdict).toBe('Conflict');
  });
});

describe('describeExcludedSelection', () => {
  it('describes the excluded-children choice', () => {
    const described = describeExcludedSelection(10, 3);
    expect(described.message).toMatch(/3 of 10 files excluded/);
    expect(described.proceedLabel).toBe('Proceed-excluded');
    expect(described.includeAllLabel).toBe('Include-all');
  });
});

describe('classifyRow', () => {
  it('uses sidecar baselines when present: clean, remote-only, local-only, both', async () => {
    const { classifyRow } = await import('../src/syncPreview');
    const base = {
      localExists: true,
      localMtimeMs: 1000,
      localSize: 5,
      remoteExists: true,
      remoteMtime: 900,
      remoteSize: 5,
    };
    const sidecar = { mtime: 900, size: 5, localMtimeMs: 1000 };
    expect(classifyRow({ ...base, sidecar })).toBe('Same');
    expect(classifyRow({ ...base, remoteMtime: 950, sidecar })).toBe('Remote-newer');
    expect(classifyRow({ ...base, localMtimeMs: 1100, sidecar })).toBe('Local-newer');
    expect(classifyRow({ ...base, localMtimeMs: 1100, remoteMtime: 950, sidecar })).toBe('Conflict');
  });

  it('falls back to mtime/size with clock tolerance without a sidecar', async () => {
    const { classifyRow } = await import('../src/syncPreview');
    expect(
      classifyRow({ localExists: true, localMtimeMs: 1000, localSize: 5, remoteExists: true, remoteMtime: 2500, remoteSize: 5 }),
    ).toBe('Same');
    expect(
      classifyRow({ localExists: false, localMtimeMs: 0, localSize: 0, remoteExists: true, remoteMtime: 1, remoteSize: 1 }),
    ).toBe('Only-remote');
  });
});
