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

/**
 * `ssh2-sftp-client` retries connect() on its own (`retries: 1` with a 25s
 * `retry_minTimeout`, verified in node_modules/ssh2-sftp-client/src/index.js).
 * Nested inside this pool's own 3-attempt 1/2/4s backoff that is two
 * competing retry policies and a worst case measured in minutes, with the
 * user staring at a frozen command. Turning the library's off leaves exactly
 * one policy, the one this file documents and tests.
 */
const LIBRARY_INTERNAL_RETRIES = 0;

/**
 * ssh2's `readyTimeout` bounds the WHOLE handshake, and the TOFU host-key
 * prompt is shown from inside it (the hostVerifier callback). The 20s default
 * is a timeout on a human reading a fingerprint and deciding whether to trust
 * it, which is far too short: the connection would die underneath them, and
 * the next attempt would ask all over again.
 *
 * Disclosed trade-off (V1, deliberate): combined with BACKOFF_MS.length (3)
 * attempts, a genuinely black-holed host (firewall drop, not a fast refusal)
 * can leave a single-file command blocking for up to ~6 minutes
 * (3 x 120s + the 1s/2s/4s backoff between attempts) with no progress
 * indicator or cancel affordance -- unlike the folder commands, which run
 * inside a cancellable `withProgress` notification. Shortening either number
 * would also shorten the time a real, slow-but-alive handshake (a loaded
 * host, a distant TOFU prompt) gets to complete, so this is a deliberate
 * worst case accepted for V1, not an oversight.
 */
const READY_TIMEOUT_MS = 120_000;

interface PooledEntry {
  client: SftpClientLike;
  idleTimer: NodeJS.Timeout;
}

/** Mutable out-param: lets getClient's catch block tell a host-key decision
 * that must never be retried (the user declined, or the trust decision could
 * not be persisted) apart from a transient connect() failure, without parsing
 * error text. */
interface HostVerifierState {
  blockedByHostKey: boolean;
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
    // ssh2 only resolves or rejects connect() once this callback fires, so
    // EVERY path out of here must call it. A rejected prompt or a rejected
    // record() used to skip the .then() chain entirely, leaving a live
    // handshake stalled until ssh2's internal readyTimeout -- silently, in
    // the middle of a network connection.
    void (async () => {
      try {
        const decision = await hostKeyPrompt.confirmNewOrChangedKey(host, port, fingerprint, verdict === 'mismatch');
        if (decision === 'reject') {
          state.blockedByHostKey = true;
          callback(false);
          return;
        }
        await hostKeyStore.record(host, port, fingerprint);
        callback(true);
      } catch {
        // Fail closed. We cannot be sure the trust decision was persisted (or
        // even made), and proceeding on an unrecorded one would defeat the
        // point of TOFU: the next connect would prompt again as if this were
        // still a first contact. Blocking lets the user retry instead. This
        // is a security decision, so it is not retried with backoff either.
        state.blockedByHostKey = true;
        callback(false);
      }
    })();
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
    const hostVerifierState: HostVerifierState = { blockedByHostKey: false };
    const connectOptions = {
      ...baseOptions,
      retries: LIBRARY_INTERNAL_RETRIES,
      readyTimeout: READY_TIMEOUT_MS,
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
        // A blocked host key is a security decision, not a transient network
        // blip: never retry it, and never re-prompt for the same connect()
        // call. Covers both a user declining and a trust decision that could
        // not be persisted.
        if (hostVerifierState.blockedByHostKey) throw err;
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
