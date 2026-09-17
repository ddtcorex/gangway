/**
 * Bounds a promise (or Thenable, matching vscode.SecretStorage's own return
 * type) so a slow or genuinely hung external call can only ever cost a
 * bounded wait, never block its caller forever. Written for SecretStorage's
 * OS-keyring backing: discovered against a real Extension Development Host
 * that a locked or unavailable keyring can leave a `secrets.get()`/`.set()`
 * call pending indefinitely, with no error and no timeout of its own --
 * every unit test's fake secret store always settles instantly, so nothing
 * short of a real desktop session ever exercised this path.
 */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number, onTimeoutMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(onTimeoutMessage)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
