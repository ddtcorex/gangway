import { describe, it, expect } from 'vitest';
import { HostKeyStore } from '../src/hostKeyStore';
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

describe('HostKeyStore', () => {
  it('reports trusted-new for a host never seen before', () => {
    const store = new HostKeyStore(fakeStore());
    expect(store.verify('example.com', 22, 'fp-abc')).toBe('trusted-new');
  });

  it('reports match once the fingerprint has been recorded', async () => {
    const store = new HostKeyStore(fakeStore());
    await store.record('example.com', 22, 'fp-abc');
    expect(store.verify('example.com', 22, 'fp-abc')).toBe('match');
  });

  it('reports mismatch when the presented fingerprint differs from the recorded one', async () => {
    const store = new HostKeyStore(fakeStore());
    await store.record('example.com', 22, 'fp-abc');
    expect(store.verify('example.com', 22, 'fp-changed')).toBe('mismatch');
  });

  it('scopes recordings per host:port, not just host', async () => {
    const store = new HostKeyStore(fakeStore());
    await store.record('example.com', 22, 'fp-abc');
    expect(store.verify('example.com', 2222, 'fp-abc')).toBe('trusted-new');
  });
});
