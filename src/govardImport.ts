import { parse as parseYaml } from 'yaml';
import type { AuthMethod, ConnectionConfig } from './types';

export interface GovardRemoteAuth {
  method?: string;
  key_path?: string;
}

export interface GovardRemote {
  host?: string;
  user?: string;
  port?: number;
  path?: string;
  auth?: GovardRemoteAuth;
  local?: boolean;
  sandbox?: boolean;
  protected?: boolean;
}

export interface GovardConfig {
  projectName: string;
  remotes: Record<string, GovardRemote>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseGovardYaml(text: string): GovardConfig {
  const doc: unknown = parseYaml(text);
  if (!isRecord(doc)) throw new Error('Not a YAML mapping');
  const projectName = typeof doc['project_name'] === 'string' ? (doc['project_name'] as string) : '';
  const remotes: Record<string, GovardRemote> = {};
  if (isRecord(doc['remotes'])) {
    for (const [name, entry] of Object.entries(doc['remotes'])) {
      if (isRecord(entry)) remotes[name] = entry as unknown as GovardRemote;
    }
  }
  return { projectName, remotes };
}

export type MappedRemote =
  | { ok: true; remoteName: string; connection: Omit<ConnectionConfig, 'id'> }
  | { ok: false; remoteName: string; reason: string };

function resolveAuthMethod(remote: GovardRemote): { authMethod: AuthMethod; keyPath?: string } {
  const method = (remote.auth?.method ?? '').toLowerCase().trim();
  if (method === 'keyfile' && remote.auth?.key_path) {
    return { authMethod: 'key', keyPath: remote.auth.key_path };
  }
  // An explicit password method maps to Gangway's own 'password' auth
  // rather than falling into the generic agent bucket below: import cannot
  // carry the plaintext secret (govard.yml never stores one either), but
  // authResolver's 'password' branch already gives a clear "open the
  // connection form and re-enter the password" error when none is stored
  // yet -- far better than a misleading "no SSH agent detected" failure for
  // a remote the user never intended to use agent auth with.
  if (method === 'password') {
    return { authMethod: 'password' };
  }
  // ssh-agent, keychain, missing, and anything unrecognized all resolve to
  // agent: no explicit key material either way, and agent never sends a
  // wrong password anywhere. Govard itself defaults an empty method to
  // keychain, which is agent-shaped from here.
  return { authMethod: 'agent' };
}

export function mapGovardRemote(projectName: string, remoteName: string, remote: GovardRemote): MappedRemote {
  if (remote.local === true) return { ok: false, remoteName, reason: 'local remote (not an SSH target)' };
  if (!remote.host) return { ok: false, remoteName, reason: 'missing host' };
  if (!remote.user) return { ok: false, remoteName, reason: 'missing user (never guessed)' };
  if (!remote.path) return { ok: false, remoteName, reason: 'missing path' };
  const { authMethod, keyPath } = resolveAuthMethod(remote);
  return {
    ok: true,
    remoteName,
    connection: {
      name: `${projectName}-${remoteName}`,
      host: remote.host,
      port: remote.port ?? 22,
      username: remote.user,
      remotePath: remote.path,
      authMethod,
      keyPath,
      // A remote read out of THIS project's .govard.yml is specific to the
      // workspace it was imported from: defaulting to 'workspace' keeps a
      // project's staging/prod entries out of every other project's remote
      // list. The user can still promote it to 'global' from the form.
      scope: 'workspace',
    },
  };
}

export interface FilteredRemotes {
  fresh: Omit<ConnectionConfig, 'id'>[];
  alreadyPresent: string[];
  skipped: { remoteName: string; reason: string }[];
}

// Matches connectionSlug's own key (tmpPath.ts): host + user + port +
// remotePath. Two remotes on the same host:port but different remotePath
// (staging/prod on one box, the standard govard layout) are distinct
// connections and must never collapse into "already present".
function dedupeKey(connection: Pick<ConnectionConfig, 'host' | 'username' | 'port' | 'remotePath'>): string {
  return `${connection.host}:${connection.username}:${connection.port}:${connection.remotePath}`;
}

export function filterNewRemotes(mapped: MappedRemote[], existing: ConnectionConfig[]): FilteredRemotes {
  const known = new Set(existing.map(dedupeKey));
  const fresh: Omit<ConnectionConfig, 'id'>[] = [];
  const alreadyPresent: string[] = [];
  const skipped: { remoteName: string; reason: string }[] = [];
  for (const entry of mapped) {
    if (!entry.ok) {
      skipped.push({ remoteName: entry.remoteName, reason: entry.reason });
      continue;
    }
    if (known.has(dedupeKey(entry.connection))) {
      alreadyPresent.push(entry.remoteName);
      continue;
    }
    known.add(dedupeKey(entry.connection));
    fresh.push(entry.connection);
  }
  return { fresh, alreadyPresent, skipped };
}
