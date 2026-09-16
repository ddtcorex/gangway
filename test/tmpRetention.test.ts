import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { purgeExpiredTmp } from '../src/tmpRetention';
import { writeSidecar } from '../src/tmpStore';
import type { SidecarMeta } from '../src/types';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'retention-test-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function seed(relativePath: string, downloadedAt: number): Promise<string> {
  const filePath = path.join(tmpRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, 'content');
  const meta: SidecarMeta = { connectionId: 'c1', remotePath: relativePath, mtime: 1, size: 7, downloadedAt };
  await writeSidecar(filePath, meta);
  return filePath;
}

describe('purgeExpiredTmp', () => {
  it('deletes a tmp file and its sidecar once older than the retention window', async () => {
    const now = Date.parse('2026-09-16T00:00:00Z');
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
    const stalePath = await seed('app/old.php', eightDaysAgo);

    const purged = await purgeExpiredTmp(tmpRoot, 7, now);

    expect(purged).toEqual([stalePath]);
    await expect(fs.access(stalePath)).rejects.toThrow();
    await expect(fs.access(`${stalePath}.meta.json`)).rejects.toThrow();
  });

  it('keeps a tmp file downloaded within the retention window', async () => {
    const now = Date.parse('2026-09-16T00:00:00Z');
    const oneDayAgo = now - 1 * 24 * 60 * 60 * 1000;
    const freshPath = await seed('app/fresh.php', oneDayAgo);

    const purged = await purgeExpiredTmp(tmpRoot, 7, now);

    expect(purged).toEqual([]);
    await expect(fs.access(freshPath)).resolves.toBeUndefined();
  });
});
