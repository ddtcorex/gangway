import { describe, it, expect, vi } from 'vitest';
import { raceWithCancellation, type CancellationTokenLike } from '../../src/ui/cancellable';
import { TransferCancelledError } from '../../src/folderQueue';

function deferredToken(): { token: CancellationTokenLike; cancel: () => void } {
  const listeners: Array<() => void> = [];
  return {
    token: {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        listeners.push(listener);
      },
    },
    cancel: () => {
      for (const listener of listeners) listener();
    },
  };
}

describe('raceWithCancellation', () => {
  it('resolves with the task result when nothing cancels', async () => {
    const { token } = deferredToken();
    const onCancel = vi.fn();

    await expect(raceWithCancellation(Promise.resolve('ok'), token, onCancel)).resolves.toBe('ok');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('passes task rejections through untouched when nothing cancels', async () => {
    const { token } = deferredToken();
    const failure = new Error('ECONNREFUSED');

    await expect(raceWithCancellation(Promise.reject(failure), token)).rejects.toBe(failure);
  });

  it('rejects with TransferCancelledError and runs onCancel when the token fires', async () => {
    const { token, cancel } = deferredToken();
    const onCancel = vi.fn();
    const pending = raceWithCancellation(new Promise(() => {}), token, onCancel);

    cancel();

    await expect(pending).rejects.toBeInstanceOf(TransferCancelledError);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('rejects immediately when already cancelled before the race starts', async () => {
    const onCancel = vi.fn();
    const token: CancellationTokenLike = {
      isCancellationRequested: true,
      onCancellationRequested: () => {},
    };

    await expect(raceWithCancellation(new Promise(() => {}), token, onCancel)).rejects.toBeInstanceOf(
      TransferCancelledError,
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
