import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectionPool } from '../../src/transfer/connectionPool';
import { HostKeyStore } from '../../src/hostKeyStore';
import { ConnectionSecretStore } from '../../src/secretStore';
import type { ConnectionConfig, KeyValueStore, SecretStore } from '../../src/types';

function fakeKeyValueStore(): KeyValueStore {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      data.set(key, value);
    },
  };
}

/**
 * A real ssh2-sftp-client (and the ssh2 library it wraps) invokes the
 * hostVerifier callback we pass in `connect()`'s options itself, during the
 * handshake, then resolves or rejects connect() based on what we call back
 * with. This fake reproduces exactly that contract so the pool's own logic
 * (not ssh2's) is what these tests exercise.
 */
function clientThatInvokesHostVerifier(keyHash: Buffer) {
  return {
    connect: vi.fn().mockImplementation(
      (opts: { hostVerifier: (keyHash: Buffer, cb: (ok: boolean) => void) => void }) =>
        new Promise<void>((resolve, reject) => {
          opts.hostVerifier(keyHash, (ok) => (ok ? resolve() : reject(new Error('Host key verification failed'))));
        }),
    ),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

const connection: ConnectionConfig = {
  id: 'c1',
  name: 'staging',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  remotePath: '/var/www',
  authMethod: 'password',
};

describe('ConnectionPool', () => {
  let secrets: ConnectionSecretStore;
  let hostKeyStore: HostKeyStore;

  beforeEach(() => {
    const secretBacking: SecretStore = {
      get: async () => 'hunter2',
      store: async () => {},
      delete: async () => {},
    };
    secrets = new ConnectionSecretStore(secretBacking);
    hostKeyStore = new HostKeyStore(fakeKeyValueStore());
  });

  it('reuses an already-connected client for the same connection id', async () => {
    const client = clientThatInvokesHostVerifier(Buffer.from('fp-1'));
    const factory = { create: vi.fn().mockReturnValue(client) };
    const prompt = { confirmNewOrChangedKey: vi.fn().mockResolvedValue('accept') };
    const pool = new ConnectionPool(factory, hostKeyStore, prompt, secrets);

    await pool.getClient(connection);
    await pool.getClient(connection);

    expect(factory.create).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('accepts a first-time host key without prompting twice, and records its fingerprint', async () => {
    const client = clientThatInvokesHostVerifier(Buffer.from('deadbeef', 'hex'));
    const factory = { create: vi.fn().mockReturnValue(client) };
    const prompt = { confirmNewOrChangedKey: vi.fn().mockResolvedValue('accept') };
    const pool = new ConnectionPool(factory, hostKeyStore, prompt, secrets);

    await pool.getClient(connection);

    expect(prompt.confirmNewOrChangedKey).toHaveBeenCalledWith('example.com', 22, 'deadbeef', false);
    expect(hostKeyStore.getRecorded('example.com', 22)?.fingerprint).toBe('deadbeef');
  });

  it('auto-accepts a matching, previously recorded host key without prompting', async () => {
    await hostKeyStore.record('example.com', 22, 'deadbeef');
    const client = clientThatInvokesHostVerifier(Buffer.from('deadbeef', 'hex'));
    const factory = { create: vi.fn().mockReturnValue(client) };
    const prompt = { confirmNewOrChangedKey: vi.fn() };
    const pool = new ConnectionPool(factory, hostKeyStore, prompt, secrets);

    await pool.getClient(connection);

    expect(prompt.confirmNewOrChangedKey).not.toHaveBeenCalled();
  });

  it('blocks the connection when the host key fingerprint changed and the user declines to trust it', async () => {
    await hostKeyStore.record('example.com', 22, 'fp-old');
    const client = clientThatInvokesHostVerifier(Buffer.from('fp-new'));
    const factory = { create: vi.fn().mockReturnValue(client) };
    const prompt = { confirmNewOrChangedKey: vi.fn().mockResolvedValue('reject') };
    const pool = new ConnectionPool(factory, hostKeyStore, prompt, secrets);

    await expect(pool.getClient(connection)).rejects.toThrow(/host key/i);
    expect(prompt.confirmNewOrChangedKey).toHaveBeenCalledWith('example.com', 22, expect.any(String), true);
  });

  it('retries connect with 1s/2s/4s backoff up to 3 attempts before giving up', async () => {
    vi.useFakeTimers();
    const connectMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const client = { connect: connectMock, end: vi.fn().mockResolvedValue(undefined) };
    const factory = { create: vi.fn().mockReturnValue(client) };
    const prompt = { confirmNewOrChangedKey: vi.fn().mockResolvedValue('accept') };
    const pool = new ConnectionPool(factory, hostKeyStore, prompt, secrets);

    const resultPromise = pool.getClient(connection);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(resultPromise).rejects.toThrow('ECONNREFUSED');
    expect(connectMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
