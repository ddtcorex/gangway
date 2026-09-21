import type { RemoteStat } from '../types';

/**
 * The subset of the real `ssh2-sftp-client@11.0.0` `stat()`/`lstat()` return
 * value this adapter cares about. Verified directly against
 * `node_modules/ssh2-sftp-client/src/index.js` (`_xstat()`, 2026-09-16): the
 * real object carries `modifyTime` (`stats.mtime * 1000`, epoch ms) --
 * never `mtime`. `size`, `isDirectory`, and `isSymbolicLink` are already
 * plain values there (not functions) and already match `RemoteStat`'s field
 * names and types, so only `modifyTime` needs translating.
 */
export interface RawSftpStat {
  size: number;
  modifyTime: number;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/** The subset of `ssh2-sftp-client`'s real `list()` entries this extension reads. */
export interface RawSftpListEntry {
  name: string;
  type: string;
  /**
   * Real entries always carry this (verified: the lib maps
   * `item.attrs.size`). Optional only because older test fixtures predate
   * it; `remoteListing.ts` treats a missing size as 0.
   */
  size?: number;
}

/** The subset of the real `ssh2-sftp-client` instance this adapter wraps. */
export interface RawSftpClient {
  connect(options: Record<string, unknown>): Promise<void>;
  end(): Promise<void>;
  stat(remotePath: string): Promise<RawSftpStat>;
  fastGet(remotePath: string, localPath: string): Promise<unknown>;
  fastPut(localPath: string, remotePath: string): Promise<unknown>;
  /**
   * Recursive mkdir (`ssh2-sftp-client` `mkdir(path, recursive)`): safe to
   * call on an existing directory (reports "already exists", throws only on
   * real problems). Used best-effort before uploads so a locally-created
   * directory that never existed remotely does not fail the put.
   */
  mkdir(remotePath: string, recursive: boolean): Promise<unknown>;
  /**
   * Deliberately the `posix-rename@openssh.com` extension (OpenSSH 4.8+),
   * not plain SFTP `rename`: standard SFTP v3 rename fails with "file
   * already exists" when the destination is present, which is true on
   * every real hotfix upload (verified 2026-09-17 against a real
   * `atmoz/sftp` container in Task 19's E2E suite -- see ssh2-sftp-client.d.ts).
   */
  posixRename(fromPath: string, toPath: string): Promise<unknown>;
  /** Used only to clean up an orphaned `<name>.tmp` after a failed rename. */
  delete(remotePath: string): Promise<unknown>;
  /** Recursive remove of a directory. Verified in node_modules (rmdir l.946): `recursive` defaults false there, always passed explicitly here. */
  rmdir(remotePath: string, recursive: boolean): Promise<unknown>;
  /** Octal string mode ('644', '755'). Verified in node_modules (chmod l.1138): passed straight to ssh2. */
  chmod(remotePath: string, mode: string): Promise<unknown>;
  list(remotePath: string): Promise<RawSftpListEntry[]>;
}

/**
 * Translates the real `ssh2-sftp-client`'s field names to the shapes this
 * extension's already-tested modules (`RemoteStat`, `DownloadClient`,
 * `UploadClient`, `SftpClientLike`) expect. This is the one place the real
 * client gets cast/adapted -- callers in `src/extension.ts` use this instead
 * of scattering ad-hoc `as unknown as {...}` casts at every call site.
 *
 * In particular: the real client's `stat()` returns `modifyTime`, never
 * `mtime`. Without this translation, `checkConflict()`'s
 * `sidecar.mtime === freshRemoteStat.mtime` compares `undefined === undefined`
 * (always `true`), silently defeating the mtime half of the conflict guard --
 * a same-size edit on the server would report "clean" and get overwritten.
 */
export class SftpClientAdapter {
  constructor(private readonly raw: RawSftpClient) {}

  connect(options: Record<string, unknown>): Promise<void> {
    return this.raw.connect(options);
  }

  end(): Promise<void> {
    return this.raw.end();
  }

  async stat(remotePath: string): Promise<RemoteStat> {
    const raw = await this.raw.stat(remotePath);
    return {
      mtime: raw.modifyTime,
      size: raw.size,
      isDirectory: raw.isDirectory,
      isSymbolicLink: raw.isSymbolicLink,
    };
  }

  fastGet(remotePath: string, localPath: string): Promise<unknown> {
    return this.raw.fastGet(remotePath, localPath);
  }

  fastPut(localPath: string, remotePath: string): Promise<unknown> {
    return this.raw.fastPut(localPath, remotePath);
  }

  mkdir(remotePath: string, recursive: boolean): Promise<unknown> {
    return this.raw.mkdir(remotePath, recursive);
  }

  posixRename(fromPath: string, toPath: string): Promise<unknown> {
    return this.raw.posixRename(fromPath, toPath);
  }

  delete(remotePath: string): Promise<unknown> {
    return this.raw.delete(remotePath);
  }

  rmdir(remotePath: string, recursive: boolean): Promise<unknown> {
    return this.raw.rmdir(remotePath, recursive);
  }

  chmod(remotePath: string, mode: string): Promise<unknown> {
    return this.raw.chmod(remotePath, mode);
  }

  list(remotePath: string): Promise<RawSftpListEntry[]> {
    return this.raw.list(remotePath);
  }
}
