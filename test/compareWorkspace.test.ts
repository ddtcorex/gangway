import { describe, it, expect } from 'vitest';
import { stagingPathForWorkspaceCompare, diffTitleForWorkspaceCompare } from '../src/ui/compareWorkspace';
import { tmpRootFor } from '../src/tmpPath';
import type { ConnectionConfig } from '../src/types';

function connection(): ConnectionConfig {
  return {
    id: 'c1',
    name: 'staging',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    remotePath: '/var/www',
    authMethod: 'password',
    scope: 'workspace',
  } as ConnectionConfig;
}

describe('compareWorkspace staging', () => {
  it('stages the server copy inside the connection tmp root, apart from the tmp mirror file', () => {
    const conn = connection();
    const staging = stagingPathForWorkspaceCompare(conn, '/var/www/app.php');
    expect(staging.startsWith(tmpRootFor(conn))).toBe(true);
    expect(staging).not.toContain('.meta.json');
    expect(staging.endsWith('.gangway-compare-workspace')).toBe(true);
  });

  it('refuses a remote path escaping the connection root', () => {
    expect(() => stagingPathForWorkspaceCompare(connection(), '/etc/passwd')).toThrow(/outside/);
  });

  it('titles the diff with the basename and both sides', () => {
    expect(diffTitleForWorkspaceCompare('/var/www/app.php')).toBe('app.php: workspace ↔ server (current)');
  });
});
