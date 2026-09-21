import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stagingPathForWorkspaceCompare, diffTitleForWorkspaceCompare, fetchServerCopyForCompare } from '../../src/ui/compareWorkspace';
import { tmpRootFor } from '../../src/tmpPath';
import type { ConnectionConfig } from '../../src/types';

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

describe('fetchServerCopyForCompare', () => {
  let sandbox: string;
  let osTmpdirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'gangway-compare-fetch-'));
    osTmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(sandbox);
  });

  afterEach(async () => {
    osTmpdirSpy.mockRestore();
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  function fakeClient(body: string) {
    return {
      fastGet: async (_remotePath: string, localPath: string) => {
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await fs.writeFile(localPath, body);
      },
    };
  }

  it('downloads server bytes to the staging path, owner-only, with no leftover sibling', async () => {
    const conn = connection();
    const staging = await fetchServerCopyForCompare(fakeClient('server v2'), conn, '/var/www/app.php');

    expect(staging).toBe(stagingPathForWorkspaceCompare(conn, '/var/www/app.php'));
    expect(await fs.readFile(staging, 'utf8')).toBe('server v2');
    expect((await fs.stat(staging)).mode & 0o077).toBe(0);
    await expect(fs.stat(`${staging}.gangway-downloading`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a failed transfer keeps the previous good copy and removes the sibling', async () => {
    const conn = connection();
    const staging = stagingPathForWorkspaceCompare(conn, '/var/www/app.php');
    await fs.mkdir(path.dirname(staging), { recursive: true });
    await fs.writeFile(staging, 'good copy');
    const failing = { fastGet: async () => { throw Object.assign(new Error('No such file'), { code: '2' }); } };

    await expect(fetchServerCopyForCompare(failing, conn, '/var/www/app.php')).rejects.toThrow(/No such file/);
    expect(await fs.readFile(staging, 'utf8')).toBe('good copy');
    await expect(fs.stat(`${staging}.gangway-downloading`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
