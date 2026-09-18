import { describe, it, expect } from 'vitest';
import { parseGovardYaml, mapGovardRemote, filterNewRemotes } from '../src/govardImport';

const SAMPLE = `project_name: myshop
domain: myshop.test
framework: magento2
remotes:
  staging:
    host: staging.example.com
    user: deploy
    path: /srv/www/staging
  prod:
    host: prod.example.com
    user: deploy
    port: 2222
    path: /srv/www/prod
    auth:
      method: keyfile
      key_path: /home/deploy/.ssh/id_ed25519
    protected: true
`;

describe('parseGovardYaml', () => {
  it('parses project name and remotes', () => {
    const config = parseGovardYaml(SAMPLE);
    expect(config.projectName).toBe('myshop');
    expect(Object.keys(config.remotes).sort()).toEqual(['prod', 'staging']);
    expect(config.remotes['prod'].port).toBe(2222);
    expect(config.remotes['prod'].auth).toEqual({ method: 'keyfile', key_path: '/home/deploy/.ssh/id_ed25519' });
  });

  it('returns empty remotes when the file has none, instead of throwing', () => {
    expect(parseGovardYaml('project_name: x\n')).toEqual({ projectName: 'x', remotes: {} });
  });

  it('throws on invalid YAML so the caller can decide (silent skip vs loud error)', () => {
    expect(() => parseGovardYaml('remotes: [unclosed')).toThrow();
  });
});

describe('mapGovardRemote', () => {
  it('maps a full remote with keyfile auth', () => {
    const config = parseGovardYaml(SAMPLE);
    expect(mapGovardRemote('myshop', 'prod', config.remotes['prod'])).toEqual({
      ok: true,
      connection: {
        name: 'myshop-prod',
        host: 'prod.example.com',
        port: 2222,
        username: 'deploy',
        remotePath: '/srv/www/prod',
        authMethod: 'key',
        keyPath: '/home/deploy/.ssh/id_ed25519',
      },
    });
  });

  it('defaults agent auth and port 22, and skips local remotes and remotes missing host/user/path', () => {
    expect(mapGovardRemote('myshop', 'staging', { host: 's.example.com', user: 'deploy', path: '/srv' })).toEqual({
      ok: true,
      connection: {
        name: 'myshop-staging', host: 's.example.com', port: 22, username: 'deploy',
        remotePath: '/srv', authMethod: 'agent', keyPath: undefined,
      },
    });
    expect(mapGovardRemote('myshop', 'box', { host: 'h', user: 'u', path: '/p', local: true }).ok).toBe(false);
    expect(mapGovardRemote('myshop', 'nope', { user: 'u', path: '/p' }).ok).toBe(false);
    expect(mapGovardRemote('myshop', 'weird', { host: 'h', user: 'u', path: '/p', auth: { method: 'owner-carried-pigeon' } })).toEqual(
      expect.objectContaining({ ok: true, connection: expect.objectContaining({ authMethod: 'agent' }) }),
    );
  });
});

describe('filterNewRemotes', () => {
  it('splits fresh, already-present (by host+port), and skipped entries without touching existing ones', () => {
    const mapped = [
      mapGovardRemote('myshop', 'staging', { host: 's.example.com', user: 'd', path: '/srv' }),
      mapGovardRemote('myshop', 'prod', { host: 'p.example.com', user: 'd', path: '/srv' }),
      mapGovardRemote('myshop', 'box', { host: 'h', user: 'u', path: '/p', local: true }),
    ];
    const existing = [{ id: 'c0', name: 'old', host: 's.example.com', port: 22, username: 'd', remotePath: '/srv', authMethod: 'agent' as const }];
    const result = filterNewRemotes(mapped, existing);
    expect(result.fresh.map((c) => c.name)).toEqual(['myshop-prod']);
    expect(result.alreadyPresent).toEqual(['staging']);
    expect(result.skipped.map((s) => s.remoteName)).toEqual(['box']);
    expect(existing).toHaveLength(1);
  });
});
