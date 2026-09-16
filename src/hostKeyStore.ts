import type { KeyValueStore } from './types';

export type HostKeyVerdict = 'trusted-new' | 'match' | 'mismatch';

interface HostKeyRecord {
  fingerprint: string;
  recordedAt: number;
}

export class HostKeyStore {
  constructor(private readonly globalState: KeyValueStore) {}

  private keyFor(host: string, port: number): string {
    return `gangway.hostKey.${host}:${port}`;
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
