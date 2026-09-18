import type { KeyValueStore } from './types';

export type HostKeyVerdict = 'trusted-new' | 'match' | 'mismatch';

interface HostKeyRecord {
  fingerprint: string;
  recordedAt: number;
}

export class HostKeyStore {
  constructor(private readonly globalState: KeyValueStore) {}

  /**
   * Host spellings of the same machine (EXAMPLE.com vs example.com. vs
   * example.com) must map to one record: otherwise each spelling prompts a
   * fresh TOFU trust for a key that was already trusted, training the user
   * to click through the very warning that protects them.
   */
  private keyFor(host: string, port: number): string {
    return `gangway.hostKey.${host.toLowerCase().replace(/\.+$/, '')}:${port}`;
  }

  getRecorded(host: string, port: number): HostKeyRecord | undefined {
    return this.globalState.get<HostKeyRecord>(this.keyFor(host, port));
  }

  async record(host: string, port: number, fingerprint: string): Promise<void> {
    const record: HostKeyRecord = { fingerprint, recordedAt: Date.now() };
    await this.globalState.update(this.keyFor(host, port), record);
  }

  verify(host: string, port: number, presentedFingerprint: string): HostKeyVerdict {
    const recorded = this.getRecorded(host, port);
    if (!recorded) return 'trusted-new';
    return recorded.fingerprint === presentedFingerprint ? 'match' : 'mismatch';
  }
}
