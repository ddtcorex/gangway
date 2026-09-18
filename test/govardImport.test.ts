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
      remoteName: 'prod',
      connection: {
        name: 'myshop-prod',
        host: 'prod.example.com',
        port: 2222,
        username: 'deploy',
        remotePath: '/srv/www/prod',
        authMethod: 'key',
        keyPath: '/home/deploy/.ssh/id_ed25519',
        scope: 'workspace',
      },
    });
  });

  it('defaults agent auth and port 22, and skips local remotes and remotes missing host/user/path', () => {
    expect(mapGovardRemote('myshop', 'staging', { host: 's.example.com', user: 'deploy', path: '/srv' })).toEqual({
      ok: true,
      remoteName: 'staging',
      connection: {
        name: 'myshop-staging', host: 's.example.com', port: 22, username: 'deploy',
        remotePath: '/srv', authMethod: 'agent', keyPath: undefined, scope: 'workspace',
      },
    });
    expect(mapGovardRemote('myshop', 'box', { host: 'h', user: 'u', path: '/p', local: true }).ok).toBe(false);
    expect(mapGovardRemote('myshop', 'nope', { user: 'u', path: '/p' }).ok).toBe(false);
    expect(mapGovardRemote('myshop', 'weird', { host: 'h', user: 'u', path: '/p', auth: { method: 'owner-carried-pigeon' } })).toEqual(
      expect.objectContaining({ ok: true, connection: expect.objectContaining({ authMethod: 'agent' }) }),
    );
  });

  it('maps an explicit password auth method to the password authMethod, not agent', () => {
    expect(mapGovardRemote('myshop', 'staging', { host: 's.example.com', user: 'd', path: '/srv', auth: { method: 'password' } })).toEqual(
      expect.objectContaining({ ok: true, connection: expect.objectContaining({ authMethod: 'password' }) }),
    );
  });
});

describe('filterNewRemotes', () => {
  it('splits fresh, already-present (by host+port+path+user), and skipped entries without touching existing ones', () => {
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

  it('imports two remotes on the same host:port with different remotePath instead of dropping the second as already-present', () => {
    const mapped = [
      mapGovardRemote('myshop', 'staging', { host: 'box.example.com', user: 'd', path: '/srv/staging' }),
      mapGovardRemote('myshop', 'prod', { host: 'box.example.com', user: 'd', path: '/srv/prod' }),
    ];
    const result = filterNewRemotes(mapped, []);
    expect(result.fresh.map((c) => c.name)).toEqual(['myshop-staging', 'myshop-prod']);
    expect(result.alreadyPresent).toEqual([]);
  });

  it('reports the already-present remote name untruncated for a hyphenated project name', () => {
    const mapped = [mapGovardRemote('my-shop', 'prod', { host: 's.example.com', user: 'd', path: '/srv' })];
    const existing = [
      { id: 'c0', name: 'old', host: 's.example.com', port: 22, username: 'd', remotePath: '/srv', authMethod: 'agent' as const },
    ];
    const result = filterNewRemotes(mapped, existing);
    expect(result.alreadyPresent).toEqual(['prod']);
  });
});
