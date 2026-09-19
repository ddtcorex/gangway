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
      delete: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ mtime: 1700000999, size: 14, isDirectory: false, isSymbolicLink: false }),
    };
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;

    await uploadFile(client, 'c1', localPath, '/var/www/app/config.php', 128, auditLog);

    expect(calls).toEqual([
      `put:${localPath}->/var/www/app/config.php.tmp`,
      'posixRename:/var/www/app/config.php.tmp->/var/www/app/config.php',
    ]);
    // The parent is ensured (recursively) before the put, so a locally
    // created folder that never existed remotely does not fail the upload.
    expect(client.mkdir).toHaveBeenCalledWith('/var/www/app', true);
    expect(client.mkdir.mock.invocationCallOrder[0]).toBeLessThan(
      (client.fastPut as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
    expect(auditLog.append).toHaveBeenCalledWith({
      connectionId: 'c1',
      remotePath: '/var/www/app/config.php',
      timestamp: expect.any(Number),
      byteSize: 128,
      op: 'upload',
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
      delete: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
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
      localMtimeMs: expect.any(Number),
    });
  });

  it('cleans up the orphaned remote .tmp file when the rename fails, and still reports the real error', async () => {
    // Upload is put-to-.tmp then rename-over-target. If the put succeeds and
    // the rename does not, the .tmp file is left sitting in the client's
    // production tree -- exactly the litter this tool exists to avoid.
    const renameFailure = new Error('Permission denied');
    const client = {
      fastPut: vi.fn().mockResolvedValue(undefined),
      posixRename: vi.fn().mockRejectedValue(renameFailure),
      delete: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ mtime: 1700000999, size: 14, isDirectory: false, isSymbolicLink: false }),
    };
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;

    await expect(uploadFile(client, 'c1', localPath, '/var/www/app/config.php', 14, auditLog)).rejects.toBe(renameFailure);

    expect(client.delete).toHaveBeenCalledWith('/var/www/app/config.php.tmp');
    // Nothing landed, so nothing may be audited or recorded as downloaded.
    expect(auditLog.append).not.toHaveBeenCalled();
  });

  it('never lets a failed cleanup attempt mask the original rename error', async () => {
    const renameFailure = new Error('Permission denied');
    const client = {
      fastPut: vi.fn().mockResolvedValue(undefined),
      posixRename: vi.fn().mockRejectedValue(renameFailure),
      delete: vi.fn().mockRejectedValue(new Error('cleanup also failed')),
      mkdir: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ mtime: 1700000999, size: 14, isDirectory: false, isSymbolicLink: false }),
    };
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;

    await expect(uploadFile(client, 'c1', localPath, '/var/www/app/config.php', 14, auditLog)).rejects.toBe(renameFailure);
  });

  it('never turns a successful upload into a reported failure when the audit log cannot be written', async () => {
    // The audit append happens AFTER posixRename has already landed the
    // hotfix on the server. Letting it throw reported a successful push as a
    // failure to the user AND skipped the sidecar refresh, which then made
    // the next upload a false-positive conflict. The log failure is reported
    // on its own channel instead.
    const client = {
      fastPut: vi.fn().mockResolvedValue(undefined),
      posixRename: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ mtime: 1700000999, size: 14, isDirectory: false, isSymbolicLink: false }),
    };
    const auditLog = {
      append: vi.fn().mockRejectedValue(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })),
    } as unknown as AuditLog;
    const logWarning = vi.fn();

    await expect(
      uploadFile(client, 'c1', localPath, '/var/www/app/config.php', 14, auditLog, logWarning),
    ).resolves.toBeUndefined();

    expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('audit log'));
    // The sidecar refresh must still have happened.
    expect((await readSidecar(localPath))!.mtime).toBe(1700000999);
  });

  it('still attempts the put when the best-effort parent mkdir fails, surfacing the put error instead', async () => {
    const putFailure = new Error('fastPut: Permission denied');
    const client = {
      fastPut: vi.fn().mockRejectedValue(putFailure),
      posixRename: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockRejectedValue(new Error('mkdir: Permission denied')),
      stat: vi.fn().mockResolvedValue({ mtime: 1700000999, size: 14, isDirectory: false, isSymbolicLink: false }),
    };
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;

    await expect(uploadFile(client, 'c1', localPath, '/var/www/app/config.php', 14, auditLog)).rejects.toBe(putFailure);
    expect(client.fastPut).toHaveBeenCalledTimes(1);
  });
});
