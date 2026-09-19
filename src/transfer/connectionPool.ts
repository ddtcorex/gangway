import type { ConnectionConfig } from '../types';
import type { HostKeyStore } from '../hostKeyStore';
import type { ConnectionSecretStore } from '../secretStore';
import { resolveConnectOptions } from '../authResolver';
import { createHostVerifier, type HostKeyPrompt, type HostVerifierState } from '../hostVerifier';

export interface SftpClientLike {
  connect(options: Record<string, unknown>): Promise<void>;
  end(): Promise<void>;
}

export interface SftpClientFactory {
  create(): SftpClientLike;
}

const BACKOFF_MS = [1000, 2000, 4000];
const IDLE_TIMEOUT_MS = 60_000;

/**
 * ssh-level keepalive for a pooled client that otherwise sits silent between
 * hotfixes: without it, a stateful middlebox or the server's own idle
 * timeout can drop the TCP connection while the pool still considers the
 * client alive, and the next command fails on a dead socket. 10s interval
 * with 3 missed replies is chatty enough to hold NAT mappings yet quiet
 * enough to never matter on any real link.
 */
const KEEPALIVE_INTERVAL_MS = 10_000;
const KEEPALIVE_COUNT_MAX = 3;

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

export class ConnectionPool {
  private readonly entries = new Map<string, PooledEntry>();
  /**
   * Connects currently being established, keyed by connection id. Two
   * commands racing the first getClient() for the same connection must
   * share one handshake: without this, each creates its own client and the
   * loser's entry overwrites the winner's, orphaning a live socket plus its
   * idle timer. Cleared on settle; success moves the client to `entries`.
   */
  private readonly pending = new Map<string, Promise<SftpClientLike>>();
  /**
   * Connection ids invalidated/disposed while their connect was still in
   * `pending`. invalidate() and dispose() cannot remove an entry that does
   * not exist in `entries` yet, so they record the intent here instead; once
   * the in-flight connect settles, getClient()'s own resolution handler
   * checks this set and tears the just-pooled client back down immediately
   * -- otherwise a cancelled-while-connecting client would land in the pool
   * anyway and get silently reused by the next command.
   */
  private readonly cancelledWhilePending = new Set<string>();

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

    const inFlight = this.pending.get(connection.id);
    if (inFlight) return inFlight;

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
    this.pending.set(connection.id, result);
    // then(onFulfilled, onRejected) -- never bare .then(cleanup): the
    // derived promise must settle successfully either way, or a failed
    // connect surfaces as a second, unhandled rejection from this line.
    result.then(
      () => {
        this.pending.delete(connection.id);
        // The connect succeeded after invalidate()/dispose() already ran
        // while it was still in-flight: entries.set() above just pooled it
        // regardless, so undo that now instead of leaving a "cancelled"
        // client live and reusable.
        if (this.cancelledWhilePending.delete(connection.id)) this.invalidate(connection.id);
      },
      () => {
        this.pending.delete(connection.id);
        this.cancelledWhilePending.delete(connection.id);
      },
    );
    return result;
  }

  /**
   * Drops whatever is pooled for this connection and best-effort ends it.
   * The stale-client contract: commands that catch a connection-level
   * failure (reset, dropped socket) call this, so the failure is a
   * one-command event -- the next getClient() reconnects instead of reusing
   * the dead socket. Sync API by design (it is called from catch blocks);
   * the end() runs detached and can never throw here.
   *
   * A connect still in `pending` for this id has no entry to remove yet --
   * record the intent in `cancelledWhilePending` so getClient()'s own
   * resolution handler tears it down the moment it lands instead of
   * silently pooling a client this call meant to discard.
   */
  invalidate(connectionId: string): void {
    if (this.pending.has(connectionId)) this.cancelledWhilePending.add(connectionId);
    const entry = this.entries.get(connectionId);
    if (!entry) return;
    this.entries.delete(connectionId);
    clearTimeout(entry.idleTimer);
    void entry.client.end().catch(() => {});
  }

  /** True once a client for this connection is actually pooled and ready to
   * reuse -- a cache hit, not merely "a connect is in flight". Callers use
   * this to skip showing connect-progress UI for what will be an instant
   * getClient() resolution. */
  hasClient(connectionId: string): boolean {
    return this.entries.has(connectionId);
  }

  private async connectWithRetry(connection: ConnectionConfig): Promise<SftpClientLike> {
    // Resolved before the client is created: a locked/slow keyring throwing
    // here (see authResolver's timeout) must not leak a live client/socket
    // that nothing would ever .end().
    const baseOptions = await resolveConnectOptions(connection, this.secrets);
    const client = this.clientFactory.create();
    const hostVerifierState: HostVerifierState = { blockedByHostKey: false };
    const connectOptions = {
      ...baseOptions,
      retries: LIBRARY_INTERNAL_RETRIES,
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
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
        if (hostVerifierState.blockedByHostKey) {
          await endQuietly(client);
          throw err;
        }
        lastError = err;
        if (attempt < BACKOFF_MS.length - 1) await sleep(BACKOFF_MS[attempt]);
      }
    }
    // Every attempt failed: the client never connected, but the factory
    // handed us a live object holding a socket/timer. Ending it here keeps
    // a failing server from leaking one client per retry cycle.
    await endQuietly(client);
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
    // Timer-driven and detached: a failing end() must not surface as an
    // unhandled rejection from a setTimeout callback.
    void entry.client.end().catch(() => {});
  }

  async dispose(): Promise<void> {
    // A connect still in-flight at deactivation must not be allowed to land
    // in the pool afterward: mark it cancelled first, same as invalidate(),
    // then wait for it to settle -- getClient()'s own resolution handler
    // ends it via invalidate() once it does.
    for (const connectionId of this.pending.keys()) this.cancelledWhilePending.add(connectionId);
    const pendingSettled = Promise.allSettled([...this.pending.values()]);
    const closings = [...this.entries.values()].map(async (entry) => {
      clearTimeout(entry.idleTimer);
      // One already-dead client must never strand the rest: each close is
      // independent, so await them all and swallow individually.
      try {
        await entry.client.end();
      } catch {
        /* already gone */
      }
    });
    this.entries.clear();
    await Promise.all([...closings, pendingSettled]);
  }
}

async function endQuietly(client: SftpClientLike): Promise<void> {
  try {
    await client.end();
  } catch {
    /* best effort: the connect already failed, there is nothing useful to report about the teardown */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
