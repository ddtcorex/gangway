import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isLocallyModified } from '../src/dirtyState';
import { writeSidecar } from '../src/tmpStore';
import type { SidecarMeta } from '../src/types';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dirty-state-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const BASE_META: Omit<SidecarMeta, 'localMtimeMs'> = {
  connectionId: 'c1',
  remotePath: '/var/www/app/config.php',
  mtime: 1700000000000,
  size: 5,
  downloadedAt: 1700000000000,
};

describe('isLocallyModified', () => {
  it('is false right after a download, before any local edit', async () => {
    const localPath = path.join(tmpDir, 'config.php');
    await fs.writeFile(localPath, 'server content');
    const stat = await fs.stat(localPath);
    await writeSidecar(localPath, { ...BASE_META, localMtimeMs: stat.mtimeMs });

    expect(await isLocallyModified(localPath)).toBe(false);
  });

  it('is true once the local file is edited (mtime moves) after the recorded baseline', async () => {
    const localPath = path.join(tmpDir, 'config.php');
    await fs.writeFile(localPath, 'server content');
    await writeSidecar(localPath, { ...BASE_META, localMtimeMs: 1 });

    expect(await isLocallyModified(localPath)).toBe(true);
  });

  it('is false for a file with no sidecar at all (not a Gangway-managed file)', async () => {
    const localPath = path.join(tmpDir, 'plain.php');
    await fs.writeFile(localPath, 'plain content');

    expect(await isLocallyModified(localPath)).toBe(false);
  });

  it('is false for a sidecar written before localMtimeMs existed', async () => {
    const localPath = path.join(tmpDir, 'legacy.php');
    await fs.writeFile(localPath, 'legacy content');
    await writeSidecar(localPath, BASE_META as SidecarMeta);

    expect(await isLocallyModified(localPath)).toBe(false);
  });

  it('is false when the local file was removed after its sidecar was written', async () => {
    const localPath = path.join(tmpDir, 'gone.php');
    await fs.writeFile(localPath, 'will be removed');
    await writeSidecar(localPath, { ...BASE_META, localMtimeMs: 1 });
    await fs.rm(localPath);

    expect(await isLocallyModified(localPath)).toBe(false);
  });
});
