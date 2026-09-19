export type AuthMethod = 'password' | 'key' | 'agent';

/** 'global' is visible from every workspace (the historical, only behavior);
 * 'workspace' is visible only from the workspace it was created in --
 * ConnectionManager stores each in a different VS Code Memento (globalState
 * vs workspaceState) rather than filtering one shared list. */
export type ConnectionScope = 'workspace' | 'global';

export interface PathMapping {
  localPath: string;
  remotePath: string;
}

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
  /** Optional (rather than defaulted at the type level) because real stored
   * data predates this field: every connection used to live in globalState
   * only, with nothing recorded here at all. Missing means 'global'.
   * ConnectionManager.list() fills this in for any legacy record it reads
   * back, so any *newly constructed* ConnectionConfig in the codebase after
   * that point can rely on it being set. */
  scope?: ConnectionScope;
  /** When true, all mutating remote ops are hard-blocked until explicit unlock (spec §5). Absent = false. */
  frozen?: boolean;
  /** Glob patterns excluded from recursive walks. Absent = DEFAULT_EXCLUDES (spec §2.3). */
  excludePatterns?: string[];
  /** Explicit remote↔local pairs (mapping spec §2). Absent/empty = default rule (§2.2). */
  mappings?: PathMapping[];
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
