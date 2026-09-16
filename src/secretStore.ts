import type { SecretStore } from './types';

export type SecretKind = 'password' | 'keyPassphrase';

export class ConnectionSecretStore {
  constructor(private readonly secrets: SecretStore) {}

  private keyFor(connectionId: string, kind: SecretKind): string {
    return `gangway.secret.${connectionId}.${kind}`;
  }

  get(connectionId: string, kind: SecretKind): Thenable<string | undefined> {
    return this.secrets.get(this.keyFor(connectionId, kind));
  }

  set(connectionId: string, kind: SecretKind, value: string): Thenable<void> {
    return this.secrets.store(this.keyFor(connectionId, kind), value);
  }

  delete(connectionId: string, kind: SecretKind): Thenable<void> {
    return this.secrets.delete(this.keyFor(connectionId, kind));
  }
}
