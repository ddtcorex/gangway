import { describe, it, expect } from 'vitest';
import { ConnectionSecretStore } from '../src/secretStore';
import type { SecretStore } from '../src/types';

function fakeSecrets(): SecretStore {
  const data = new Map<string, string>();
  return {
    get: async (key: string) => data.get(key),
    store: async (key: string, value: string) => {
      data.set(key, value);
    },
    delete: async (key: string) => {
      data.delete(key);
    },
  };
}

describe('ConnectionSecretStore', () => {
  it('stores and retrieves a secret scoped by connection id and kind', async () => {
    const store = new ConnectionSecretStore(fakeSecrets());
    await store.set('c1', 'password', 'hunter2');
    await expect(store.get('c1', 'password')).resolves.toBe('hunter2');
  });

  it('keeps password and keyPassphrase secrets independent for the same connection', async () => {
    const store = new ConnectionSecretStore(fakeSecrets());
    await store.set('c1', 'password', 'pw');
    await store.set('c1', 'keyPassphrase', 'phrase');
    await expect(store.get('c1', 'password')).resolves.toBe('pw');
    await expect(store.get('c1', 'keyPassphrase')).resolves.toBe('phrase');
  });

  it('deletes a secret', async () => {
    const store = new ConnectionSecretStore(fakeSecrets());
    await store.set('c1', 'password', 'pw');
    await store.delete('c1', 'password');
    await expect(store.get('c1', 'password')).resolves.toBeUndefined();
  });
});
