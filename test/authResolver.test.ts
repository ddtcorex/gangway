import { describe, it, expect, vi } from 'vitest';
import { resolveConnectOptions, AuthResolutionError } from '../src/authResolver';
import { ConnectionSecretStore } from '../src/secretStore';
import type { ConnectionConfig, SecretStore } from '../src/types';

function secretStoreWith(values: Record<string, string>): ConnectionSecretStore {
  const backing: SecretStore = {
    get: async (key: string) => values[key],
    store: async () => {},
    delete: async () => {},
  };
  return new ConnectionSecretStore(backing);
}

const base: ConnectionConfig = {
  id: 'c1',
  name: 'staging',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  remotePath: '/var/www',
  authMethod: 'password',
};

describe('resolveConnectOptions', () => {
  it('resolves password auth from the secret store, with no other fields set', async () => {
    const secrets = secretStoreWith({ 'gangway.secret.c1.password': 'hunter2' });
    const opts = await resolveConnectOptions(base, secrets);
    expect(opts).toEqual({ host: 'example.com', port: 22, username: 'deploy', password: 'hunter2' });
  });

  it('throws AuthResolutionError when password auth is selected but no secret is stored', async () => {
    const secrets = secretStoreWith({});
    await expect(resolveConnectOptions(base, secrets)).rejects.toThrow(AuthResolutionError);
    await expect(resolveConnectOptions(base, secrets)).rejects.toThrow(/no password stored/i);
  });

  it('resolves key auth by reading the key file at keyPath, never embedding key material elsewhere', async () => {
    const connection: ConnectionConfig = { ...base, authMethod: 'key', keyPath: '/home/user/.ssh/id_ed25519' };
    const secrets = secretStoreWith({ 'gangway.secret.c1.keyPassphrase': 'phrase' });
    const readFile = vi.fn().mockResolvedValue(Buffer.from('PRIVATE KEY BYTES'));
    const opts = await resolveConnectOptions(connection, secrets, readFile);
    expect(readFile).toHaveBeenCalledWith('/home/user/.ssh/id_ed25519');
    expect(opts).toEqual({
      host: 'example.com',
      port: 22,
      username: 'deploy',
      privateKey: Buffer.from('PRIVATE KEY BYTES'),
      passphrase: 'phrase',
    });
  });

  it('reports an unreadable key file as a local key-path problem, not a server error', async () => {
    // A raw Node fs error used to propagate out of here untouched, straight
    // into extension.ts's generic mapSftpError(), whose ENOENT branch says
    // "The requested path does not exist on the server" -- badly misleading
    // for what is actually a stale keyPath on this machine.
    const connection: ConnectionConfig = { ...base, authMethod: 'key', keyPath: '/home/user/.ssh/missing_key' };
    const readFile = vi.fn().mockRejectedValue(
      Object.assign(new Error("ENOENT: no such file or directory, open '/home/user/.ssh/missing_key'"), { code: 'ENOENT' }),
    );

    const attempt = resolveConnectOptions(connection, secretStoreWith({}), readFile);

    await expect(attempt).rejects.toThrow(AuthResolutionError);
    await expect(attempt).rejects.toThrow(/\/home\/user\/\.ssh\/missing_key/);
    await expect(attempt).rejects.toThrow(/key file/i);
    await expect(attempt).rejects.not.toThrow(/on the server/i);
  });

  it('throws AuthResolutionError for key auth when keyPath is missing', async () => {
    const connection: ConnectionConfig = { ...base, authMethod: 'key' };
    await expect(resolveConnectOptions(connection, secretStoreWith({}))).rejects.toThrow(/no key path/i);
  });

  it('resolves agent auth from SSH_AUTH_SOCK and never touches password/key secrets', async () => {
    const connection: ConnectionConfig = { ...base, authMethod: 'agent' };
    const originalSocket = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = '/tmp/ssh-agent.sock';
    try {
      const opts = await resolveConnectOptions(connection, secretStoreWith({}));
      expect(opts).toEqual({ host: 'example.com', port: 22, username: 'deploy', agent: '/tmp/ssh-agent.sock' });
    } finally {
      process.env.SSH_AUTH_SOCK = originalSocket;
    }
  });

  it('throws AuthResolutionError for agent auth when SSH_AUTH_SOCK is unset, without trying password/key', async () => {
    const connection: ConnectionConfig = { ...base, authMethod: 'agent' };
    const originalSocket = process.env.SSH_AUTH_SOCK;
    delete process.env.SSH_AUTH_SOCK;
    try {
      await expect(resolveConnectOptions(connection, secretStoreWith({ 'gangway.secret.c1.password': 'pw' }))).rejects.toThrow(
        /no ssh agent detected/i,
      );
    } finally {
      process.env.SSH_AUTH_SOCK = originalSocket;
    }
  });
});
