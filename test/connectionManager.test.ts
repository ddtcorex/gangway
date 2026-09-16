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
});
