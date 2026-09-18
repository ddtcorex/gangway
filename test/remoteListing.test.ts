import { describe, it, expect, vi } from 'vitest';
import { isSafeListingName, mapListingToEntries } from '../src/remoteListing';

describe('isSafeListingName', () => {
  it('accepts ordinary file and directory names', () => {
    for (const name of ['config.php', '.env', 'a b c', 'x..y', 'weird:name', '...']) {
      expect(isSafeListingName(name)).toBe(true);
    }
  });

  it('rejects the names that let a hostile server escape the tmp root', () => {
    // The threat model is exactly the one TOFU host-key verification exists
    // for: a compromised or spoofed server. An honest OpenSSH server never
    // emits these, so rejecting them costs nothing.
    for (const name of ['', '.', '..', '../../../etc/passwd', 'a/b', '/abs', 'back\\slash', 'nul\0byte']) {
      expect(isSafeListingName(name)).toBe(false);
    }
  });
});

describe('mapListingToEntries', () => {
  it('maps safe entries to remote entries under the listed directory', () => {
    const entries = mapListingToEntries('/var/www/app', [
      { name: 'config.php', type: '-' },
      { name: 'vendor', type: 'd' },
      { name: 'current', type: 'l' },
    ]);

    expect(entries).toEqual([
      { path: '/var/www/app/config.php', isDirectory: false, isSymbolicLink: false, size: 0 },
      { path: '/var/www/app/vendor', isDirectory: true, isSymbolicLink: false, size: 0 },
      { path: '/var/www/app/current', isDirectory: false, isSymbolicLink: true, size: 0 },
    ]);
  });

  it('skips a malicious entry name instead of building an escaping path, and reports it', () => {
    const onUnsafeName = vi.fn();

    const entries = mapListingToEntries(
      '/var/www/app',
      [
        { name: '../../../../../home/user/.gangway-pwned', type: '-' },
        { name: 'config.php', type: '-' },
      ],
      onUnsafeName,
    );

    expect(entries).toEqual([{ path: '/var/www/app/config.php', isDirectory: false, isSymbolicLink: false, size: 0 }]);
    expect(onUnsafeName).toHaveBeenCalledWith('../../../../../home/user/.gangway-pwned');
  });

  it('does not produce a doubled separator when listing the filesystem root', () => {
    expect(mapListingToEntries('/', [{ name: 'srv', type: 'd' }])[0].path).toBe('/srv');
  });

  it('carries real listing sizes through, defaulting a missing size to 0 instead of NaN', () => {
    const entries = mapListingToEntries('/var/www', [
      { name: 'big.bin', type: '-', size: 6 * 1024 * 1024 },
      { name: 'legacy.php', type: '-' },
    ]);
    expect(entries.find((e) => e.path === '/var/www/big.bin')?.size).toBe(6 * 1024 * 1024);
    expect(entries.find((e) => e.path === '/var/www/legacy.php')?.size).toBe(0);
  });
});
