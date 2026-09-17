import type { RemoteEntry } from './folderQueue';
import type { RawSftpListEntry } from './transfer/sftpClientAdapter';

/**
 * A listing entry name is attacker-controlled data: it comes from whatever
 * the server says is in a directory, and it is concatenated into paths that
 * end up at `tmpFilePathFor()`, `fs.mkdir` and `fastGet` on the local disk. A
 * malicious or MITM'd server returning an entry named
 * `../../../../../home/user/.gangway-pwned` would resolve well outside the
 * tmp root. That is exactly the threat model TOFU host-key verification
 * exists for (spec §4), so it is defended against here even though an honest
 * OpenSSH server never emits such a name.
 *
 * Rejected: empty, `.`, `..`, and anything containing a path separator or a
 * NUL byte. The backslash is rejected too even though it is a legal character
 * in a POSIX filename: this extension also runs on Windows hosts, where
 * `path.join` would treat it as a separator.
 */
const UNSAFE_NAME_CHARACTERS = /[/\\\0]/;

export function isSafeListingName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  return !UNSAFE_NAME_CHARACTERS.test(name);
}

/**
 * The single place a server listing becomes local `RemoteEntry` paths. All
 * three former call sites (the tree provider and both folder commands) built
 * `${dirPath}/${entry.name}` inline with no validation; they now share this.
 */
export function mapListingToEntries(
  dirPath: string,
  entries: readonly RawSftpListEntry[],
  onUnsafeName: (name: string) => void = () => {},
): RemoteEntry[] {
  // Listing `/` would otherwise produce `//srv`.
  const base = dirPath.endsWith('/') ? dirPath.slice(0, -1) : dirPath;

  const safe: RemoteEntry[] = [];
  for (const entry of entries) {
    if (!isSafeListingName(entry.name)) {
      onUnsafeName(entry.name);
      continue;
    }
    safe.push({
      path: `${base}/${entry.name}`,
      isDirectory: entry.type === 'd',
      isSymbolicLink: entry.type === 'l',
      size: 0,
    });
  }
  return safe;
}
