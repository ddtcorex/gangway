import type { HostKeyStore } from './hostKeyStore';

export type HostKeyDecision = 'accept' | 'reject';

export interface HostKeyPrompt {
  confirmNewOrChangedKey(host: string, port: number, fingerprint: string, isChange: boolean): Promise<HostKeyDecision>;
}

/** Mutable out-param: lets a connect's catch block tell a host-key decision
 * that must never be retried (the user declined, or the trust decision could
 * not be persisted) apart from a transient connect() failure, without parsing
 * error text. */
export interface HostVerifierState {
  blockedByHostKey: boolean;
  /** Receives every presented fingerprint (match or not) — lets one-off
   * dials report what they saw without re-reading the store. */
  onFingerprint?: (fingerprint: string) => void;
}

/**
 * Builds an ssh2-compatible hostVerifier(keyHash, callback). Passed into
 * connect options alongside { hostHash: 'sha256' }, ssh2 invokes this itself
 * during the handshake and only resolves connect() once callback(true) has
 * been called: this is what makes TOFU verification actually gate the
 * connection, rather than run as an afterthought once a connection already
 * exists.
 */
export function createHostVerifier(
  hostKeyStore: HostKeyStore,
  hostKeyPrompt: HostKeyPrompt,
  host: string,
  port: number,
  state: HostVerifierState,
): (keyHash: Buffer, callback: (matches: boolean) => void) => void {
  return (keyHash, callback) => {
    const fingerprint = keyHash.toString('hex');
    state.onFingerprint?.(fingerprint);
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
