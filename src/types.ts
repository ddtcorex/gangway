export type AuthMethod = 'password' | 'key' | 'agent';

export interface ConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  remotePath: string;
  authMethod: AuthMethod;
  /** Only set when authMethod === 'key'. The key *path*, never key material. */
  keyPath?: string;
}

export interface SidecarMeta {
  connectionId: string;
  remotePath: string;
  mtime: number;
  size: number;
  downloadedAt: number;
  /** The local file's own fs mtime (ms) at the moment it last matched the
   * server exactly (right after a download completed, or right after an
   * upload's fresh re-stat). A later local edit changes the file's mtime
   * without touching this recorded value, which is what the dirty-state
   * decoration (src/dirtyState.ts) compares against. Optional so every
   * sidecar written before this field existed still parses; such a file is
   * simply never shown as dirty. */
  localMtimeMs?: number;
}

export interface RemoteStat {
  mtime: number;
  size: number;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/** Matches the subset of vscode.Memento used by ConnectionManager/HostKeyStore. */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** Matches the subset of vscode.SecretStorage used by ConnectionSecretStore. */
export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
