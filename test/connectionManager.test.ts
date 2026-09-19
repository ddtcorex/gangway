import { describe, it, expect, beforeEach } from 'vitest';
import { ConnectionManager } from '../src/connectionManager';
import type { KeyValueStore } from '../src/types';

function fakeStore(): KeyValueStore {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      data.set(key, value);
    },
  };
}

describe('ConnectionManager', () => {
  let globalState: KeyValueStore;
  let workspaceState: KeyValueStore;
  let manager: ConnectionManager;

  beforeEach(() => {
    globalState = fakeStore();
    workspaceState = fakeStore();
    manager = new ConnectionManager(globalState, workspaceState);
  });

  it('starts empty', () => {
    expect(manager.list()).toEqual([]);
  });

  it('adds a connection with a generated id and lists it back', async () => {
    const created = await manager.add({
      name: 'staging',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      remotePath: '/var/www',
      authMethod: 'password',
    });
    expect(created.id).toBeTruthy();
    expect(manager.list()).toEqual([created]);
  });

  it('updates an existing connection by id', async () => {
    const created = await manager.add({
      name: 'staging',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      remotePath: '/var/www',
      authMethod: 'password',
    });
    const updated = await manager.update(created.id, { name: 'staging-renamed' });
    expect(updated.name).toBe('staging-renamed');
    expect(manager.list()).toEqual([updated]);
  });

  it('round-trips frozen and excludePatterns through add/update', async () => {
    const created = await manager.add({
      name: 'p',
      host: 'h',
      port: 22,
      username: 'u',
      remotePath: '/srv/app',
      authMethod: 'agent',
    });
    expect(created.frozen).toBeUndefined();
    const updated = await manager.update(created.id, { frozen: true, excludePatterns: ['dist/**'] });
    expect(updated.frozen).toBe(true);
    expect(updated.excludePatterns).toEqual(['dist/**']);
    expect(manager.list()[0].frozen).toBe(true);
  });

  it('removes a connection by id', async () => {
    const created = await manager.add({
      name: 'staging',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      remotePath: '/var/www',
      authMethod: 'password',
    });
    await manager.remove(created.id);
    expect(manager.list()).toEqual([]);
  });

  it('binds a workspace to a connection id independently of the global list', async () => {
    expect(manager.getWorkspaceBinding()).toBeUndefined();
    await manager.setWorkspaceBinding('c1');
    expect(manager.getWorkspaceBinding()).toBe('c1');
    await manager.setWorkspaceBinding(undefined);
    expect(manager.getWorkspaceBinding()).toBeUndefined();
  });

<<<<<<< HEAD
  describe('scope: workspace vs global', () => {
    it('defaults a new connection to global scope when none is given', async () => {
      const created = await manager.add({
        name: 'staging', host: 'example.com', port: 22, username: 'deploy', remotePath: '/var/www', authMethod: 'password',
      });
      expect(created.scope).toBe('global');
    });

    it('stores a workspace-scope connection in workspaceState, not globalState', async () => {
      const created = await manager.add({
        name: 'staging', host: 'example.com', port: 22, username: 'deploy', remotePath: '/var/www',
        authMethod: 'password', scope: 'workspace',
      });
      expect(created.scope).toBe('workspace');
      expect(globalState.get('gangway.connections')).toBeUndefined();
      expect(workspaceState.get<Array<{ id: string }>>('gangway.connections')?.map((c) => c.id)).toEqual([created.id]);
    });

    it('list() merges global and workspace connections, each tagged with its own scope', async () => {
      const g = await manager.add({
        name: 'global-one', host: 'g.example.com', port: 22, username: 'deploy', remotePath: '/var/www', authMethod: 'password',
      });
      const w = await manager.add({
        name: 'workspace-one', host: 'w.example.com', port: 22, username: 'deploy', remotePath: '/var/www',
        authMethod: 'password', scope: 'workspace',
      });
      expect(manager.list()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: g.id, scope: 'global' }),
          expect.objectContaining({ id: w.id, scope: 'workspace' }),
        ]),
      );
    });

    it('reads a legacy globalState connection with no stored scope field as global', async () => {
      await globalState.update('gangway.connections', [
        { id: 'legacy-1', name: 'old', host: 'h', port: 22, username: 'u', remotePath: '/p', authMethod: 'password' },
      ]);
      expect(manager.list()).toEqual([
        { id: 'legacy-1', name: 'old', host: 'h', port: 22, username: 'u', remotePath: '/p', authMethod: 'password', scope: 'global' },
      ]);
    });

    it('update() moves a connection from global to workspace storage when scope changes', async () => {
      const created = await manager.add({
        name: 'staging', host: 'example.com', port: 22, username: 'deploy', remotePath: '/var/www', authMethod: 'password',
      });
      const updated = await manager.update(created.id, { scope: 'workspace' });

      expect(updated.scope).toBe('workspace');
      expect(globalState.get('gangway.connections')).toEqual([]);
      expect(workspaceState.get<Array<{ id: string }>>('gangway.connections')?.map((c) => c.id)).toEqual([created.id]);
      expect(manager.list()).toEqual([updated]);
    });

    it('update() moves a connection from workspace back to global storage when scope changes', async () => {
      const created = await manager.add({
        name: 'staging', host: 'example.com', port: 22, username: 'deploy', remotePath: '/var/www',
        authMethod: 'password', scope: 'workspace',
      });
      const updated = await manager.update(created.id, { scope: 'global' });

      expect(updated.scope).toBe('global');
      expect(workspaceState.get('gangway.connections')).toEqual([]);
      expect(globalState.get<Array<{ id: string }>>('gangway.connections')?.map((c) => c.id)).toEqual([created.id]);
    });

    it('update() without a scope patch leaves the connection in its current store', async () => {
      const created = await manager.add({
        name: 'staging', host: 'example.com', port: 22, username: 'deploy', remotePath: '/var/www',
        authMethod: 'password', scope: 'workspace',
      });
      await manager.update(created.id, { name: 'renamed' });

      expect(globalState.get('gangway.connections')).toBeUndefined();
      expect(workspaceState.get<Array<{ id: string; name: string }>>('gangway.connections')?.[0]?.name).toBe('renamed');
    });

    it('remove() deletes a workspace-scope connection from workspaceState', async () => {
      const created = await manager.add({
        name: 'staging', host: 'example.com', port: 22, username: 'deploy', remotePath: '/var/www',
        authMethod: 'password', scope: 'workspace',
      });
      await manager.remove(created.id);
      expect(manager.list()).toEqual([]);
      expect(workspaceState.get('gangway.connections')).toEqual([]);
    });
  });

  it('round-trips mappings through add/update', async () => {
    const created = await manager.add({
      name: 'p',
      host: 'h',
      port: 22,
      username: 'u',
      remotePath: '/srv/app',
      authMethod: 'agent',
    });
    expect(created.mappings).toBeUndefined();
    const updated = await manager.update(created.id, {
      mappings: [{ localPath: '/home/u/proj', remotePath: '/srv/app' }],
    });
    expect(updated.mappings).toEqual([{ localPath: '/home/u/proj', remotePath: '/srv/app' }]);
  });
});
