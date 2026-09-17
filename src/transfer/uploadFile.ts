import type { AuditLog } from '../auditLog';
import { writeSidecar } from '../tmpStore';
import type { RemoteStat } from '../types';

export interface UploadClient {
  fastPut(localPath: string, remotePath: string): Promise<unknown>;
  /**
   * Must be the `posix-rename@openssh.com` extension (OpenSSH 4.8+), not
   * plain SFTP rename: standard SFTP v3 rename fails with "file already
   * exists" when the destination is present, which is true on every real
   * hotfix upload -- the whole point is overwriting a file that already
   * exists on the server. Verified 2026-09-17 against a real `atmoz/sftp`
   * container in Task 19's E2E suite: a mock's `rename` always resolves
   * regardless of real SFTP semantics, which is exactly why this only
   * surfaced against a real server, not the unit-test mocks.
   */
  posixRename(fromPath: string, toPath: string): Promise<unknown>;
  /**
   * Not a new capability -- the real call site (src/extension.ts) already
   * passes a SftpClientAdapter, which has this method for the
   * download/conflict-check path. uploadFile() needs it too: see the
   * sidecar refresh below.
   */
  stat(remotePath: string): Promise<RemoteStat>;
  /**
   * `delete(remotePath, notFoundOK?)` on the real `ssh2-sftp-client`
   * (verified against node_modules/ssh2-sftp-client/src/index.js, 2026-09-17:
   * there is no `unlink`). Used only to clean up our own orphaned `.tmp`
   * upload below, never to remove a file the user asked to keep.
   */
  delete(remotePath: string): Promise<unknown>;
}

export async function uploadFile(
  client: UploadClient,
  connectionId: string,
  localPath: string,
  remotePath: string,
  byteSize: number,
  auditLog: AuditLog,
  /**
   * Where a non-fatal problem is reported (the Output channel in production).
   * Only used for the audit-log append below, which happens after the upload
   * has already succeeded.
   */
  logWarning: (message: string) => void = () => {},
): Promise<void> {
  const tmpRemotePath = `${remotePath}.tmp`;
  await client.fastPut(localPath, tmpRemotePath);

  try {
    await client.posixRename(tmpRemotePath, remotePath);
  } catch (err) {
    // The put succeeded, so `<name>.tmp` is sitting in the client's
    // production tree right now. Leaving it there is exactly the litter this
    // tool exists to avoid. Best effort only: a cleanup that also fails must
    // never replace or mask the rename failure the caller needs to see.
    try {
      await client.delete(tmpRemotePath);
    } catch {
      /* keep the original error */
    }
    throw err;
  }

  // Everything past this line runs AFTER the hotfix has already landed on the
  // server. Letting an audit-log problem throw reported a successful push to
  // the user as a failure and skipped the sidecar refresh below, which then
  // made the next upload a false-positive conflict. The audit log is a record
  // of the push, not part of it: a failure to write it is reported on its own
  // channel and never rewrites the outcome of the upload itself.
  try {
    await auditLog.append({ connectionId, remotePath, timestamp: Date.now(), byteSize });
  } catch (err) {
    logWarning(
      `Uploaded ${remotePath}, but could not write the audit log entry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Without this, the local sidecar keeps the ORIGINAL download-time
  // mtime/size forever. A second edit+upload in the same session would then
  // have checkConflict() compare against that stale baseline instead of what
  // was just pushed -- the server's mtime changed because of THIS upload,
  // not an external edit, so reporting it as a conflict is a false positive
  // that confuses a user during a completely normal multi-edit hotfix
  // session (found in review after Task 19's real-server E2E work).
  const freshStat = await client.stat(remotePath);
  await writeSidecar(localPath, {
    connectionId,
    remotePath,
    mtime: freshStat.mtime,
    size: freshStat.size,
    downloadedAt: Date.now(),
  });
}
