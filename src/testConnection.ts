import { TransferCancelledError } from './folderQueue';
import { createHostVerifier, type HostKeyPrompt, type HostVerifierState } from './hostVerifier';
import type { HostKeyStore } from './hostKeyStore';
import type { AuthMethod } from './types';

/** Unsaved form values for one test dial. Secrets live in RAM for the call only. */
export interface TestDraft {
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  keyPath?: string;
  password?: string;
  passphrase?: string;
}

export type TestFailureKind = 'auth-failed' | 'host-key' | 'unreachable' | 'unsupported-auth' | 'timeout';

export type TestResult = { ok: true; fingerprint: string } | { ok: false; kind: TestFailureKind; message: string };

export interface TestClient {
  connect(options: Record<string, unknown>): Promise<void>;
  end(): Promise<void>;
}

export interface TestConnectionDeps {
  createClient(): TestClient;
  hostKeyStore: HostKeyStore;
  prompt: HostKeyPrompt;
  readFile(path: string): Promise<Buffer>;
  /**
   * Cooperative cancellation (the extension wires VS Code's cancellation
   * token here): aborting destroys the in-flight handshake and rejects with
   * TransferCancelledError, which callers must let through unclassified.
   */
  signal?: AbortSignal;
}

/**
 * Bound for one test dial. The pool's 120s readyTimeout is for real
 * commands (with a human reading a TOFU prompt inside it); a test button
 * that hangs for minutes is a bug, so the whole attempt gets 15s.
 */
const TEST_TIMEOUT_MS = 15_000;

/**
 * Dials once with the draft's own values — never the secret store, never
 * persisted, never pooled. Classifier messages are STATIC per kind: no raw
 * server text is ever returned, so draft secrets cannot leak through an
 * error no matter what the server echoes.
 */
export async function testConnection(deps: TestConnectionDeps, draft: TestDraft): Promise<TestResult> {
  let fingerprint = '';
  let options: Record<string, unknown>;
  try {
    options = await resolveDraftOptions(deps, draft);
  } catch (err) {
    return {
      ok: false,
      kind: 'auth-failed',
      message: err instanceof Error ? err.message : 'Could not prepare the test connection.',
    };
  }
  const state: HostVerifierState = { blockedByHostKey: false, onFingerprint: (fp) => (fingerprint = fp) };
  let client: TestClient;
  try {
    client = deps.createClient();
  } catch (err) {
    return classifyTestError(err, state, draft);
  }
  try {
    await dialWithTimeout(
      client,
      deps,
      {
        ...options,
        retries: 0,
        readyTimeout: TEST_TIMEOUT_MS,
        hostHash: 'sha256' as const,
        hostVerifier: createHostVerifier(deps.hostKeyStore, deps.prompt, draft.host, draft.port, state),
      },
      state,
    );
    return { ok: true, fingerprint };
  } catch (err) {
    // Cancellations propagate unclassified: the user asked to stop, and a
    // failure verdict for that would be a lie.
    if (err instanceof TransferCancelledError) throw err;
    return classifyTestError(err, state, draft);
  } finally {
    try {
      await client.end();
    } catch {
      /* best effort: the dial already failed or succeeded, teardown must not mask it */
    }
  }
}

/**
 * One connect attempt bounded for a test button (the pool's 120s
 * readyTimeout is for real commands, not a UI affordance) and abortable:
 * cancelling destroys the handshake client-side and rejects promptly
 * instead of leaving the attempt running behind a dismissed dialog.
 */
function dialWithTimeout(
  client: TestClient,
  deps: TestConnectionDeps,
  options: Record<string, unknown>,
  state: HostVerifierState,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (deps.signal?.aborted) {
      reject(new TransferCancelledError());
      return;
    }
    const timer = setTimeout(() => reject(new Error('Timed out while connecting')), TEST_TIMEOUT_MS);
    const settle = (outcome: () => void): void => {
      clearTimeout(timer);
      deps.signal?.removeEventListener('abort', onAbort);
      outcome();
    };
    const onAbort = (): void => {
      // No client.end() here: the outer finally owns teardown (single end,
      // best-effort). Rejecting unblocks the race immediately; the finally
      // destroys the handshake socket on the way out, so nothing leaks.
      settle(() => reject(new TransferCancelledError()));
    };
    deps.signal?.addEventListener('abort', onAbort, { once: true });
    client.connect(options).then(
      () => settle(resolve),
      (err: unknown) => settle(() => reject(err instanceof Error ? err : new Error(String(err)))),
    );
  });
}

async function resolveDraftOptions(
  deps: TestConnectionDeps,
  draft: TestDraft,
): Promise<Record<string, unknown>> {
  const shared = { host: draft.host, port: draft.port, username: draft.username };
  switch (draft.authMethod) {
    case 'password':
      return { ...shared, password: draft.password ?? '' };
    case 'key': {
      if (!draft.keyPath) throw new Error('No SSH key file selected.');
      let privateKey: Buffer;
      try {
        privateKey = await deps.readFile(draft.keyPath);
      } catch (err) {
        throw new Error(
          `Could not read key file ${draft.keyPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return { ...shared, privateKey, passphrase: draft.passphrase };
    }
    case 'agent': {
      const agent = process.env.SSH_AUTH_SOCK;
      if (!agent) throw new Error('No SSH agent detected (SSH_AUTH_SOCK is not set).');
      return { ...shared, agent };
    }
  }
}

function classifyTestError(err: unknown, state: HostVerifierState, draft: TestDraft): TestResult {
  if (state.blockedByHostKey) {
    return {
      ok: false,
      kind: 'host-key',
      message: 'Host key verification blocked the connection (declined, or the trust decision could not be recorded).',
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  const code =
    typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
  if (/timed out while connecting|ETIMEDOUT/i.test(code ?? '') || /timed out while connecting/i.test(message)) {
    return {
      ok: false,
      kind: 'timeout',
      message: `Connection to ${draft.host}:${draft.port} timed out after 15s — the host may be unreachable or dropping packets.`,
    };
  }
  if (/keyboard-interactive/i.test(message)) {
    return {
      ok: false,
      kind: 'unsupported-auth',
      message: 'The server requires keyboard-interactive authentication, which Gangway does not support.',
    };
  }
  if (
    /authentication|auth failed|no supported authentication|publickey|password/i.test(message) ||
    code === '4'
  ) {
    return {
      ok: false,
      kind: 'auth-failed',
      message: 'Authentication failed — check the username, password/key, and auth method.',
    };
  }
  if (code && ['ENOTFOUND', 'ENOTCONN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) {
    return {
      ok: false,
      kind: 'unreachable',
      message: `Could not reach ${draft.host}:${draft.port} — check the hostname, port, and firewall.`,
    };
  }
  return {
    ok: false,
    kind: 'unreachable',
    message: `Could not reach ${draft.host}:${draft.port} — check the hostname, port, and firewall.`,
  }
}
