import type { ConnectionConfig } from '../types';
import type { HostKeyStore } from '../hostKeyStore';
import type { ConnectionSecretStore } from '../secretStore';
import { resolveConnectOptions } from '../authResolver';

export interface SftpClientLike {
  connect(options: Record<string, unknown>): Promise<void>;
  end(): Promise<void>;
}

export interface SftpClientFactory {
  create(): SftpClientLike;
}

export type HostKeyDecision = 'accept' | 'reject';

export interface HostKeyPrompt {
  confirmNewOrChangedKey(host: string, port: number, fingerprint: string, isChange: boolean): Promise<HostKeyDecision>;
}

const BACKOFF_MS = [1000, 2000, 4000];
const IDLE_TIMEOUT_MS = 60_000;

interface PooledEntry {
  client: SftpClientLike;
  idleTimer: NodeJS.Timeout;
}

/** Mutable out-param: lets getClient's catch block tell a user-declined host
 * key apart from a transient connect() failure, without parsing error text. */
interface HostVerifierState {
  rejectedByUser: boolean;
}

/**
 * Builds an ssh2-compatible hostVerifier(keyHash, callback). Passed into
 * connect options alongside { hostHash: 'sha256' }, ssh2 invokes this itself
 * during the handshake and only resolves connect() once callback(true) has
 * been called: this is what makes TOFU verification actually gate the
 * connection, rather than run as an afterthought once a connection already
 * exists.
 */
function createHostVerifier(
  hostKeyStore: HostKeyStore,
  hostKeyPrompt: HostKeyPrompt,
  host: string,
  port: number,
  state: HostVerifierState,
): (keyHash: Buffer, callback: (matches: boolean) => void) => void {
  return (keyHash, callback) => {
    const fingerprint = keyHash.toString('hex');
    const verdict = hostKeyStore.verify(host, port, fingerprint);
    if (verdict === 'match') {
      callback(true);
      return;
    }
    void hostKeyPrompt.confirmNewOrChangedKey(host, port, fingerprint, verdict === 'mismatch').then((decision) => {
      if (decision === 'reject') {
        state.rejectedByUser = true;
        callback(false);
        return;
      }
      void hostKeyStore.record(host, port, fingerprint).then(() => callback(true));
    });
  };
}

export class ConnectionPool {
  private readonly entries = new Map<string, PooledEntry>();

  constructor(
    private readonly clientFactory: SftpClientFactory,
    private readonly hostKeyStore: HostKeyStore,
    private readonly hostKeyPrompt: HostKeyPrompt,
    private readonly secrets: ConnectionSecretStore,
  ) {}

  /**
   * Deliberately not `async`: it must return the exact same Promise instance
   * that `connectWithRetry` produced, with a synchronous no-op `.catch`
   * already attached to it (see below). An `async` wrapper here would hand
   * callers a *different*, freshly-adopted promise instead, defeating that.
   */
  getClient(connection: ConnectionConfig): Promise<SftpClientLike> {
    const existing = this.entries.get(connection.id);
    if (existing) {
      this.resetIdleTimer(connection.id, existing);
      return Promise.resolve(existing.client);
    }

    const result = this.connectWithRetry(connection);
    // Attaching a handler in the same synchronous tick the promise is
    // created marks it "handled" for Node's unhandled-rejection tracking,
    // even though every reachable failure path here is one every caller is
    // expected to (and, in tests, does) await/catch on the returned promise
    // itself. Without this, a connect failure that only gets awaited a tick
    // or two later (e.g. after a backoff sleep resumes on the fake-timer
    // clock) is briefly seen as unhandled, which is merely cosmetic (the
    // real rejection still reaches every real caller) but noisy in tests
    // and logs. This no-op subscriber never runs ahead of, replaces, or
    // consumes the rejection for actual callers.
    result.catch(() => {});
    return result;
  }

  private async connectWithRetry(connection: ConnectionConfig): Promise<SftpClientLike> {
    const client = this.clientFactory.create();
    const baseOptions = await resolveConnectOptions(connection, this.secrets);
    const hostVerifierState: HostVerifierState = { rejectedByUser: false };
    const connectOptions = {
      ...baseOptions,
      hostHash: 'sha256' as const,
      hostVerifier: createHostVerifier(
        this.hostKeyStore,
        this.hostKeyPrompt,
        connection.host,
        connection.port,
        hostVerifierState,
      ),
    };

    let lastError: unknown;
    for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
      try {
        await client.connect(connectOptions as unknown as Record<string, unknown>);
        const entry: PooledEntry = { client, idleTimer: this.createIdleTimer(connection.id) };
        this.entries.set(connection.id, entry);
        return client;
      } catch (err) {
        // A user declining a new/changed host key is a security decision,
        // not a transient network blip: never retry it, and never re-prompt
        // for the same connect() call.
        if (hostVerifierState.rejectedByUser) throw err;
        lastError = err;
        if (attempt < BACKOFF_MS.length - 1) await sleep(BACKOFF_MS[attempt]);
      }
    }
    throw lastError;
  }

  private createIdleTimer(connectionId: string): NodeJS.Timeout {
    return setTimeout(() => this.evict(connectionId), IDLE_TIMEOUT_MS);
  }

  private resetIdleTimer(connectionId: string, entry: PooledEntry): void {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = this.createIdleTimer(connectionId);
  }

  private evict(connectionId: string): void {
    const entry = this.entries.get(connectionId);
    if (!entry) return;
    this.entries.delete(connectionId);
    void entry.client.end();
  }

  async dispose(): Promise<void> {
    for (const [id, entry] of this.entries) {
      clearTimeout(entry.idleTimer);
      this.entries.delete(id);
      await entry.client.end();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
