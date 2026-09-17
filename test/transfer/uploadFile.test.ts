import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { uploadFile } from '../../src/transfer/uploadFile';
import { readSidecar } from '../../src/tmpStore';
import { AuditLog } from '../../src/auditLog';

let tmpHome: string;
let localPath: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-test-'));
  localPath = path.join(tmpHome, 'config.php');
  // writeSidecar() chmods the local file itself (0600) alongside its sidecar,
  // so it must actually exist on disk for the post-upload sidecar refresh
  // assertions below, same as downloadFile.test.ts's real-tmp-dir pattern.
  await fs.writeFile(localPath, 'edited content');
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe('uploadFile', () => {
  it('puts to a .tmp remote path, posix-renames over the target, and appends one audit entry', async () => {
    // posixRename (not plain rename) is required here: standard SFTP rename
    // fails with "file already exists" when the destination is present,
    // which is true on every real hotfix upload -- see uploadFile.ts.
    const calls: string[] = [];
    const client = {
      fastPut: vi.fn().mockImplementation(async (local: string, remote: string) => {
        calls.push(`put:${local}->${remote}`);
      }),
      posixRename: vi.fn().mockImplementation(async (from: string, to: string) => {
        calls.push(`posixRename:${from}->${to}`);
      }),
      stat: vi.fn().mockResolvedValue({ mtime: 1700000999, size: 14, isDirectory: false, isSymbolicLink: false }),
    };
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;

    await uploadFile(client, 'c1', localPath, '/var/www/app/config.php', 128, auditLog);

    expect(calls).toEqual([
      `put:${localPath}->/var/www/app/config.php.tmp`,
      'posixRename:/var/www/app/config.php.tmp->/var/www/app/config.php',
    ]);
    expect(auditLog.append).toHaveBeenCalledWith({
      connectionId: 'c1',
      remotePath: '/var/www/app/config.php',
      timestamp: expect.any(Number),
      byteSize: 128,
    });
  });

  it('refreshes the local sidecar to the freshly-uploaded stat, so a second upload in the same session is never a false-positive conflict', async () => {
    // Regression guard: before this fix, the sidecar kept the ORIGINAL
    // download-time mtime/size forever. A second edit+upload in the same
    // session would then have checkConflict() compare against that stale
    // baseline -- reporting a conflict even though nothing external touched
    // the file, since the server's mtime only changed because of THIS
    // upload.
    const client = {
      fastPut: vi.fn().mockResolvedValue(undefined),
      posixRename: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ mtime: 1700000999, size: 14, isDirectory: false, isSymbolicLink: false }),
    };
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;

    await uploadFile(client, 'c1', localPath, '/var/www/app/config.php', 14, auditLog);

    expect(client.stat).toHaveBeenCalledWith('/var/www/app/config.php');
    const sidecar = await readSidecar(localPath);
    expect(sidecar).toEqual({
      connectionId: 'c1',
      remotePath: '/var/www/app/config.php',
      mtime: 1700000999,
      size: 14,
      downloadedAt: expect.any(Number),
    });
  });
});
