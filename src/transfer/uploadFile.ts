import type { AuditLog } from '../auditLog';

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
}

export async function uploadFile(
  client: UploadClient,
  connectionId: string,
  localPath: string,
  remotePath: string,
  byteSize: number,
  auditLog: AuditLog,
): Promise<void> {
  const tmpRemotePath = `${remotePath}.tmp`;
  await client.fastPut(localPath, tmpRemotePath);
  await client.posixRename(tmpRemotePath, remotePath);
  await auditLog.append({ connectionId, remotePath, timestamp: Date.now(), byteSize });
}
