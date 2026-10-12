import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { uploadFile } from '../../src/transfer/uploadFile';
import { readSidecar, writeSidecar } from '../../src/tmpStore';
import { AuditLog } from '../../src/auditLog';

const regularFile = { mtime: 1, size: 1, isDirectory: false, isSymbolicLink: false };

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
      lstat: vi.fn().mockResolvedValue(regularFile),
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
      lstat: vi.fn().mockResolvedValue(regularFile),
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
      lstat: vi.fn().mockResolvedValue(regularFile),
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
      lstat: vi.fn().mockResolvedValue(regularFile),
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
      lstat: vi.fn().mockResolvedValue(regularFile),
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
      lstat: vi.fn().mockResolvedValue(regularFile),
      stat: vi.fn().mockResolvedValue({ mtime: 1700000999, size: 14, isDirectory: false, isSymbolicLink: false }),
    };
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;

    await expect(uploadFile(client, 'c1', localPath, '/var/www/app/config.php', 14, auditLog)).rejects.toBe(putFailure);
    expect(client.fastPut).toHaveBeenCalledTimes(1);
  });

  it('has no backup option: overwrites directly without staging a server copy', async () => {
    const client = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      lstat: vi.fn().mockResolvedValue(regularFile),
      stat: vi.fn().mockResolvedValue({ mtime: 5, size: 3, isDirectory: false, isSymbolicLink: false }),
      fastPut: vi.fn().mockResolvedValue(undefined),
      posixRename: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;

    await uploadFile(client, 'c1', localPath, '/srv/app/a.php', 14, auditLog);

    expect(client.fastPut).toHaveBeenCalledWith(localPath, '/srv/app/a.php.tmp');
    expect(client.posixRename).toHaveBeenCalledWith('/srv/app/a.php.tmp', '/srv/app/a.php');
    expect((client as unknown as Record<string, unknown>)['fastGet']).toBeUndefined();
  });

  it('skips the sidecar refresh for workspace uploads, leaving no meta.json behind', async () => {
    const client = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      lstat: vi.fn().mockResolvedValue(regularFile),
      stat: vi.fn(),
      fastPut: vi.fn().mockResolvedValue(undefined),
      posixRename: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;

    await uploadFile(client, 'c1', localPath, '/srv/app/a.php', 14, auditLog, () => {}, { writeSidecar: false });

    expect(await readSidecar(localPath)).toBeUndefined();
    expect(client.stat).not.toHaveBeenCalled();
  });

  describe('links', () => {
    const notFound = (): Error => Object.assign(new Error('No such file'), { code: 2 });

    function linkClient() {
      return {
        mkdir: vi.fn().mockResolvedValue(undefined),
        lstat: vi.fn().mockResolvedValue(regularFile),
        stat: vi.fn().mockResolvedValue({ mtime: 1700000999, size: 14, isDirectory: false, isSymbolicLink: false }),
        fastPut: vi.fn().mockResolvedValue(undefined),
        posixRename: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      };
    }

    it('writes tmp and renames at the real path, link untouched', async () => {
      const client = linkClient();
      const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;

      await uploadFile(client, 'c1', localPath, '/srv/shared/real.php', 14, auditLog, () => {}, {
        sidecarRemotePath: '/srv/app/link.php',
      });

      expect(client.fastPut).toHaveBeenCalledWith(localPath, '/srv/shared/real.php.tmp');
      expect(client.posixRename).toHaveBeenCalledWith('/srv/shared/real.php.tmp', '/srv/shared/real.php');
      const touched = [...client.fastPut.mock.calls, ...client.posixRename.mock.calls].flat();
      expect(touched.some((p) => String(p).startsWith('/srv/app/link.php'))).toBe(false);
      expect(client.delete).not.toHaveBeenCalled();
      expect(auditLog.append).toHaveBeenCalledWith({
        connectionId: 'c1',
        remotePath: '/srv/shared/real.php',
        timestamp: expect.any(Number),
        byteSize: 14,
        op: 'upload',
        note: 'via /srv/app/link.php',
      });
    });

    it('sidecar keeps the clicked path and records realPath', async () => {
      const client = linkClient();
      const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;

      await uploadFile(client, 'c1', localPath, '/srv/shared/real.php', 14, auditLog, () => {}, {
        sidecarRemotePath: '/srv/app/link.php',
      });

      expect(client.stat).toHaveBeenCalledWith('/srv/shared/real.php');
      expect(await readSidecar(localPath)).toEqual({
        connectionId: 'c1',
        remotePath: '/srv/app/link.php',
        realPath: '/srv/shared/real.php',
        mtime: 1700000999,
        size: 14,
        downloadedAt: expect.any(Number),
        localMtimeMs: expect.any(Number),
      });
    });

    it('keeps a remembered out-of-root confirmation across the sidecar refresh', async () => {
      await writeSidecar(localPath, {
        connectionId: 'c1',
        remotePath: '/srv/app/link.php',
        realPath: '/srv/shared/real.php',
        outsideRootConfirmedFor: '/srv/shared/real.php',
        mtime: 1,
        size: 1,
        downloadedAt: 1,
      });
      const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;

      await uploadFile(linkClient(), 'c1', localPath, '/srv/shared/real.php', 14, auditLog, () => {}, {
        sidecarRemotePath: '/srv/app/link.php',
      });

      expect((await readSidecar(localPath))!.outsideRootConfirmedFor).toBe('/srv/shared/real.php');
    });

    it('refuses a destination that is itself a symlink', async () => {
      const client = linkClient();
      client.lstat.mockResolvedValue({ ...regularFile, isSymbolicLink: true });
      const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;

      await expect(uploadFile(client, 'c1', localPath, '/srv/app/link.php', 14, auditLog)).rejects.toThrow(
        '"/srv/app/link.php" is a symlink; open it from the tree to edit its target.',
      );
      expect(client.mkdir).not.toHaveBeenCalled();
      expect(client.fastPut).not.toHaveBeenCalled();
      expect(client.posixRename).not.toHaveBeenCalled();
      expect(auditLog.append).not.toHaveBeenCalled();
    });

    it('refuses a symlink destination for workspace uploads too', async () => {
      const client = linkClient();
      client.lstat.mockResolvedValue({ ...regularFile, isSymbolicLink: true });
      const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;

      await expect(
        uploadFile(client, 'c1', localPath, '/srv/app/link.php', 14, auditLog, () => {}, { writeSidecar: false }),
      ).rejects.toThrow('is a symlink');
      expect(client.fastPut).not.toHaveBeenCalled();
    });

    it('new file (lstat not found) uploads normally', async () => {
      const client = linkClient();
      client.lstat.mockRejectedValue(notFound());
      const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;

      await uploadFile(client, 'c1', localPath, '/srv/app/new.php', 14, auditLog);

      expect(client.fastPut).toHaveBeenCalledWith(localPath, '/srv/app/new.php.tmp');
      expect(client.posixRename).toHaveBeenCalledWith('/srv/app/new.php.tmp', '/srv/app/new.php');
      const sidecar = await readSidecar(localPath);
      expect(sidecar!.remotePath).toBe('/srv/app/new.php');
      expect(sidecar!.realPath).toBeUndefined();
    });

    it('propagates any other lstat error without writing', async () => {
      const client = linkClient();
      const denied = Object.assign(new Error('Permission denied'), { code: 3 });
      client.lstat.mockRejectedValue(denied);
      const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;

      await expect(uploadFile(client, 'c1', localPath, '/srv/app/a.php', 14, auditLog)).rejects.toBe(denied);
      expect(client.fastPut).not.toHaveBeenCalled();
    });
  });

  describe('destinationGate', () => {
    function gateClient() {
      return {
        fastPut: vi.fn().mockResolvedValue(undefined),
        posixRename: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        mkdir: vi.fn().mockResolvedValue(undefined),
        lstat: vi.fn().mockResolvedValue(regularFile),
        stat: vi.fn().mockResolvedValue(regularFile),
      };
    }

    it('uploadFile with a refusing destinationGate makes no mkdir, no fastPut, no posixRename', async () => {
      const client = gateClient();
      const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;
      const destinationGate = vi.fn().mockRejectedValue(new Error('outside the connection root'));

      await expect(
        uploadFile(client, 'c1', localPath, '/srv/app/shared/a.php', 14, auditLog, () => {}, { destinationGate }),
      ).rejects.toThrow('outside the connection root');
      expect(client.mkdir).not.toHaveBeenCalled();
      expect(client.fastPut).not.toHaveBeenCalled();
      expect(client.posixRename).not.toHaveBeenCalled();
      expect(auditLog.append).not.toHaveBeenCalled();
    });

    it('awaits the gate with the posix dirname of the remote path', async () => {
      const client = gateClient();
      const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;
      const destinationGate = vi.fn().mockResolvedValue(undefined);

      await uploadFile(client, 'c1', localPath, '/srv/app/shared/a.php', 14, auditLog, () => {}, { destinationGate });

      expect(destinationGate).toHaveBeenCalledWith('/srv/app/shared');
      expect(destinationGate.mock.invocationCallOrder[0]).toBeLessThan(client.mkdir.mock.invocationCallOrder[0]);
      expect(client.posixRename).toHaveBeenCalledWith('/srv/app/shared/a.php.tmp', '/srv/app/shared/a.php');
    });
  });
});
