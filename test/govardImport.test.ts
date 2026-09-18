import { describe, it, expect } from 'vitest';
import { parseGovardYaml } from '../src/govardImport';

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
