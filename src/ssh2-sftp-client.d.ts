/**
 * `ssh2-sftp-client` ships no type declarations and there is no published
 * `@types/ssh2-sftp-client` package, so `import Client from 'ssh2-sftp-client'`
 * (used by src/extension.ts to build the real SftpClientFactory) has nothing
 * to typecheck against. This ambient module declares only the subset of the
 * real API this extension actually calls, matching the shapes already
 * defined in src/transfer/connectionPool.ts (SftpClientLike),
 * src/transfer/downloadFile.ts (DownloadClient), and
 * src/transfer/uploadFile.ts (UploadClient).
 *
 * IMPORTANT -- `stat()`'s return shape here is the REAL library's shape, not
 * `RemoteStat`: verified against `ssh2-sftp-client/src/index.js`'s `_xstat()`
 * (2026-09-16), the real object has `modifyTime` (epoch ms), never `mtime`.
 * `size`/`isDirectory`/`isSymbolicLink` already match `RemoteStat`. Do not
 * "fix" this to say `mtime` -- src/transfer/sftpClientAdapter.ts is what
 * translates `modifyTime` -> `mtime` at the one place the real client is
 * used (src/extension.ts); this declaration must keep mirroring reality.
 *
 * IMPORTANT -- there is deliberately no plain `rename()` here (2026-09-17,
 * Task 19 real-server E2E finding): standard SFTP v3 `SSH_FXP_RENAME` fails
 * with "file already exists" when the destination is already present, which
 * is true on every real hotfix upload (the whole point is overwriting a file
 * that already exists on the server) -- verified against a real `atmoz/sftp`
 * container, where `rename()` onto an existing path failed while
 * `posixRename()` (the `posix-rename@openssh.com` extension, OpenSSH 4.8+)
 * succeeded. `uploadFile.ts`'s tmp+rename atomic upload must always use
 * `posixRename()`.
 */
declare module 'ssh2-sftp-client' {
  export default class Client {
    constructor(clientName?: string);
    connect(options: Record<string, unknown>): Promise<void>;
    end(): Promise<void>;
    stat(remotePath: string): Promise<{ size: number; modifyTime: number; isDirectory: boolean; isSymbolicLink: boolean }>;
    fastGet(remotePath: string, localPath: string): Promise<string>;
    fastPut(localPath: string, remotePath: string): Promise<string>;
    posixRename(fromPath: string, toPath: string): Promise<string>;
    delete(remotePath: string, notFoundOK?: boolean): Promise<string>;
    list(remotePath: string): Promise<Array<{ name: string; type: string }>>;
  }
}
