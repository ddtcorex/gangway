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
  | { ok: true; connection: Omit<ConnectionConfig, 'id'> }
  | { ok: false; remoteName: string; reason: string };

function resolveAuthMethod(remote: GovardRemote): { authMethod: AuthMethod; keyPath?: string } {
  const method = (remote.auth?.method ?? '').toLowerCase().trim();
  if (method === 'keyfile' && remote.auth?.key_path) {
    return { authMethod: 'key', keyPath: remote.auth.key_path };
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
    connection: {
      name: `${projectName}-${remoteName}`,
      host: remote.host,
      port: remote.port ?? 22,
      username: remote.user,
      remotePath: remote.path,
      authMethod,
      keyPath,
    },
  };
}

export interface FilteredRemotes {
  fresh: Omit<ConnectionConfig, 'id'>[];
  alreadyPresent: string[];
  skipped: { remoteName: string; reason: string }[];
}

export function filterNewRemotes(mapped: MappedRemote[], existing: ConnectionConfig[]): FilteredRemotes {
  const known = new Set(existing.map((c) => `${c.host}:${c.port}`));
  const fresh: Omit<ConnectionConfig, 'id'>[] = [];
  const alreadyPresent: string[] = [];
  const skipped: { remoteName: string; reason: string }[] = [];
  for (const entry of mapped) {
    if (!entry.ok) {
      skipped.push({ remoteName: entry.remoteName, reason: entry.reason });
      continue;
    }
    if (known.has(`${entry.connection.host}:${entry.connection.port}`)) {
      alreadyPresent.push(entry.connection.name.replace(/^[^-]+-/, ''));
      continue;
    }
    known.add(`${entry.connection.host}:${entry.connection.port}`);
    fresh.push(entry.connection);
  }
  return { fresh, alreadyPresent, skipped };
}
