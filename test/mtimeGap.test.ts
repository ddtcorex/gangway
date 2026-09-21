import { describe, it, expect, vi } from 'vitest';
import { waitForWriteBucket } from './e2e/mtimeGap';

/**
 * waitForWriteBucket() gates the workspace-down e2e's out-of-band server
 * write on the wall clock: the write must land in a whole-second bucket
 * strictly past local + classifyRow()'s 2000ms no-sidecar tolerance, because
 * SFTP floors server mtimes and same-size files snap to Same inside the
 * tolerance. Fixed sleeps flake both ways (CI 2026-09-21: a post-write
 * 2600ms sleep left a 1970ms floored gap; writing immediately with no sleep
 * lands in the same bucket with a ~18ms gap that no polling can ever grow).
 */
describe('waitForWriteBucket', () => {
  it('resolves immediately when the current bucket already clears the tolerance', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await waitForWriteBucket(33030, { sleep, now: () => 36500 });

    expect(result).toEqual({ localMtimeMs: 33030, writeFloorMs: 36000 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('polls until the wall clock enters a bucket past local + tolerance', async () => {
    let now = 34000;
    const sleep = vi.fn().mockImplementation(async () => {
      now += 500;
    });

    const result = await waitForWriteBucket(33030, { sleep, pollMs: 500, now: () => now });

    expect(result.writeFloorMs - 33030).toBeGreaterThan(2000);
    expect(sleep).toHaveBeenCalled();
  });

  it('floors the clock exactly like SFTP whole-second attrs', async () => {
    // now=35999 floors to 35000: 35000 - 33030 = 1970 <= 2000, so the
    // bucket must NOT count as cleared (the CI failure shape verbatim);
    // now=36000 floors to 36000 and clears it.
    const ticks = [35999, 35999, 36000];
    let calls = 0;
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await waitForWriteBucket(33030, {
      sleep,
      pollMs: 250,
      now: () => ticks[Math.min(calls++, ticks.length - 1)],
    });

    expect(result).toEqual({ localMtimeMs: 33030, writeFloorMs: 36000 });
    // One sleep: iteration 1 checks the bucket (35999 -> 1970ms, hold) then
    // the deadline, iteration 2 sees 36000 and returns without sleeping.
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('throws a diagnostic naming local, bucket, and tolerance on timeout', async () => {
    let now = 34000;
    const sleep = vi.fn().mockImplementation(async () => {
      now += 250;
    });

    let err: unknown;
    try {
      await waitForWriteBucket(33030, { sleep, pollMs: 250, timeoutMs: 1000, now: () => now });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('33030');
    expect(message).toContain('2000');
  });
});
