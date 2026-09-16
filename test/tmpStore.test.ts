import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeSidecar, readSidecar, ensureOwnerOnlyPermissions } from '../src/tmpStore';
import type { SidecarMeta } from '../src/types';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmpstore-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('tmpStore', () => {
  it('writes the sidecar JSON next to the tmp file and chmods both 600', async () => {
    const tmpFile = path.join(tmpDir, 'app/config.php');
    await fs.mkdir(path.dirname(tmpFile), { recursive: true });
    await fs.writeFile(tmpFile, 'downloaded content');

    const meta: SidecarMeta = {
      connectionId: 'c1',
      remotePath: '/var/www/app/config.php',
      mtime: 1700000000,
      size: 19,
      downloadedAt: Date.now(),
    };

    await writeSidecar(tmpFile, meta);

    const sidecarPath = `${tmpFile}.meta.json`;
    const raw = await fs.readFile(sidecarPath, 'utf8');
    expect(JSON.parse(raw)).toEqual(meta);

    const tmpFileMode = (await fs.stat(tmpFile)).mode & 0o777;
    const sidecarMode = (await fs.stat(sidecarPath)).mode & 0o777;
    expect(tmpFileMode).toBe(0o600);
    expect(sidecarMode).toBe(0o600);
  });

  it('reads back a previously written sidecar', async () => {
    const tmpFile = path.join(tmpDir, 'app/other.php');
    await fs.mkdir(path.dirname(tmpFile), { recursive: true });
    await fs.writeFile(tmpFile, 'x');
    const meta: SidecarMeta = {
      connectionId: 'c1',
      remotePath: '/var/www/app/other.php',
      mtime: 1,
      size: 1,
      downloadedAt: 2,
    };
    await writeSidecar(tmpFile, meta);
    await expect(readSidecar(tmpFile)).resolves.toEqual(meta);
  });

  it('returns undefined when no sidecar exists', async () => {
    await expect(readSidecar(path.join(tmpDir, 'never-downloaded.php'))).resolves.toBeUndefined();
  });

  it('ensureOwnerOnlyPermissions chmods an arbitrary file to 600', async () => {
    const file = path.join(tmpDir, 'plain.txt');
    await fs.writeFile(file, 'x', { mode: 0o644 });
    await ensureOwnerOnlyPermissions(file);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
});
