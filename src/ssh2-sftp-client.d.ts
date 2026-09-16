/**
 * `ssh2-sftp-client` ships no type declarations and there is no published
 * `@types/ssh2-sftp-client` package, so `import Client from 'ssh2-sftp-client'`
 * (used by src/extension.ts to build the real SftpClientFactory) has nothing
 * to typecheck against. This ambient module declares only the subset of the
 * real API this extension actually calls, matching the shapes already
 * defined in src/transfer/connectionPool.ts (SftpClientLike),
 * src/transfer/downloadFile.ts (DownloadClient), and
 * src/transfer/uploadFile.ts (UploadClient).
 */
declare module 'ssh2-sftp-client' {
  export default class Client {
    constructor(clientName?: string);
    connect(options: Record<string, unknown>): Promise<void>;
    end(): Promise<void>;
    stat(remotePath: string): Promise<{ mtime: number; size: number }>;
    fastGet(remotePath: string, localPath: string): Promise<string>;
    fastPut(localPath: string, remotePath: string): Promise<string>;
    rename(fromPath: string, toPath: string): Promise<string>;
    list(remotePath: string): Promise<Array<{ name: string; type: string }>>;
  }
}
