import { describe, it, expect, vi } from 'vitest';
import { uploadFile } from '../../src/transfer/uploadFile';
import { AuditLog } from '../../src/auditLog';

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
    };
    const auditLog = { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;

    await uploadFile(client, 'c1', '/local/app/config.php', '/var/www/app/config.php', 128, auditLog);

    expect(calls).toEqual([
      'put:/local/app/config.php->/var/www/app/config.php.tmp',
      'posixRename:/var/www/app/config.php.tmp->/var/www/app/config.php',
    ]);
    expect(auditLog.append).toHaveBeenCalledWith({
      connectionId: 'c1',
      remotePath: '/var/www/app/config.php',
      timestamp: expect.any(Number),
      byteSize: 128,
    });
  });
});
