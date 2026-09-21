/**
 * Condition gate for the workspace-down e2e precondition: the out-of-band
 * server write must land in a whole-second bucket strictly past the local
 * file's mtime + classifyRow()'s no-sidecar tolerance (same size +
 * |local - remote| <= 2000ms snaps to Same). SFTP attrs carry whole seconds,
 * so the gate floors the wall clock exactly as the server will report the
 * write -- a fixed sleep cannot guarantee this and flakes both ways:
 *   - post-write sleep too short (or floored away): the gap sits inside the
 *     tolerance and the down-sync wrongly reports No differences (CI
 *     2026-09-21: 2600ms sleep left a 1970ms floored gap);
 *   - no sleep at all: the write lands in the same bucket as the upload
 *     (~18ms gap), which no amount of post-write polling can ever grow.
 * Gate the write, then write immediately: the write lands within
 * milliseconds, in the verified bucket or a later one (which only grows
 * the gap).
 *
 * Pure (no vscode import) so unit tests can drive it with a fake clock; the
 * bucket prediction holds because the container bind-mounts the same host
 * tree, so host clock == filesystem mtime source on both sides.
 */
export interface WriteBucketOptions {
  /** Mirrors classifyRow()'s NO_BASELINE_TOLERANCE_MS. Default 2000. */
  toleranceMs?: number;
  /** Loud failure budget. Default 15000. */
  timeoutMs?: number;
  /** Delay between clock polls. Default 250. */
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WriteBucket {
  localMtimeMs: number;
  /** Whole-second bucket a write issued now would land in. */
  writeFloorMs: number;
}

export async function waitForWriteBucket(
  localMtimeMs: number,
  options?: WriteBucketOptions,
): Promise<WriteBucket> {
  const toleranceMs = options?.toleranceMs ?? 2000;
  const timeoutMs = options?.timeoutMs ?? 15000;
  const pollMs = options?.pollMs ?? 250;
  const now = options?.now ?? Date.now;
  const sleep = options?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  for (;;) {
    // Floor to whole seconds: this is the exact value SFTP will report for
    // a write issued now, so the gap proven here is the gap classifyRow()
    // will see, not a sub-second illusion the server rounds away.
    const writeFloorMs = Math.floor(now() / 1000) * 1000;
    if (writeFloorMs - localMtimeMs > toleranceMs) {
      return { localMtimeMs, writeFloorMs };
    }
    if (now() >= deadline) {
      throw new Error(
        `Timed out waiting for a server-write bucket past the no-baseline tolerance: ` +
          `local=${localMtimeMs} bucket=${writeFloorMs} tolerance=${toleranceMs} ` +
          `(gap ${writeFloorMs - localMtimeMs}ms <= ${toleranceMs}ms after ${timeoutMs}ms). ` +
          `The wall clock did not advance far enough past the local file's mtime.`,
      );
    }
    await sleep(pollMs);
  }
}
