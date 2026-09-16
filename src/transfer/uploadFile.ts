import type { AuditLog } from '../auditLog';

export interface UploadClient {
  fastPut(localPath: string, remotePath: string): Promise<unknown>;
  rename(fromPath: string, toPath: string): Promise<unknown>;
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
  await client.rename(tmpRemotePath, remotePath);
  await auditLog.append({ connectionId, remotePath, timestamp: Date.now(), byteSize });
}
