import { parse as parseYaml } from 'yaml';

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
