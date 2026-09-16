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
