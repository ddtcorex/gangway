import { TransferCancelledError } from '../folderQueue';

/** The minimal VS Code CancellationToken surface this helper needs. */
export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): unknown;
}

/**
 * Races a task against a VS Code cancellation token. On cancel, runs
 * onCancel (pool invalidation, at the call site) and rejects with
 * TransferCancelledError -- the same type the folder queues throw, so every
 * command's catch block reports a cancellation as "Cancelled.", never as a
 * connection failure with Retry buttons.
 */
export function raceWithCancellation<T>(
  task: Promise<T>,
  token: CancellationTokenLike,
  onCancel: () => void = () => {},
): Promise<T> {
  if (token.isCancellationRequested) {
    onCancel();
    return Promise.reject(new TransferCancelledError());
  }
  return new Promise<T>((resolve, reject) => {
    token.onCancellationRequested(() => {
      onCancel();
      reject(new TransferCancelledError());
    });
    task.then(resolve, reject);
  });
}
