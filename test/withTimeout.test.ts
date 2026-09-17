import { describe, it, expect, vi, afterEach } from 'vitest';
import { withTimeout } from '../src/withTimeout';

afterEach(() => {
  vi.useRealTimers();
});

describe('withTimeout', () => {
  it('resolves with the value when the promise settles before the timeout', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'timed out')).resolves.toBe('ok');
  });

  it('rejects with the original error when the promise rejects before the timeout', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'timed out')).rejects.toThrow('boom');
  });

  it('rejects with the timeout message once the deadline passes, for a promise that never settles', async () => {
    vi.useFakeTimers();
    const never = new Promise(() => {});

    const result = withTimeout(never, 5000, 'timed out waiting');
    const assertion = expect(result).rejects.toThrow('timed out waiting');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it('accepts a Thenable (not just a real Promise), matching vscode.SecretStorage return types', async () => {
    const thenable: PromiseLike<string> = {
      then: (onFulfilled) => {
        onFulfilled?.('from-thenable');
        return thenable as never;
      },
    };
    await expect(withTimeout(thenable, 1000, 'timed out')).resolves.toBe('from-thenable');
  });
});
