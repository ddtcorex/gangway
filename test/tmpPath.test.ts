import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { tmpRootFor, tmpFilePathFor, sidecarPathFor } from '../src/tmpPath';
import type { ConnectionConfig } from '../src/types';

const connection: ConnectionConfig = {
  id: 'c1',
  name: 'staging',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  remotePath: '/var/www',
  authMethod: 'password',
};

describe('tmpPath', () => {
  it('roots the tmp dir under os.tmpdir()/vs-sftp/<10-char sha1 slug>', () => {
    const root = tmpRootFor(connection);
    expect(root.startsWith(path.join(os.tmpdir(), 'vs-sftp'))).toBe(true);
    const slug = path.basename(root);
    expect(slug).toMatch(/^[0-9a-f]{10}$/);
  });

  it('is stable for the same host:user:port and differs across connections', () => {
    const other: ConnectionConfig = { ...connection, id: 'c2', host: 'other.example.com' };
    const withDifferentId: ConnectionConfig = { ...connection, id: 'different-id' };
    expect(tmpRootFor(connection)).toBe(tmpRootFor(withDifferentId));
    expect(tmpRootFor(connection)).not.toBe(tmpRootFor(other));
  });

  it('maps a remote relative path under the tmp root', () => {
    const tmpFile = tmpFilePathFor(connection, '/var/www/app/config.php');
    expect(tmpFile).toBe(path.join(tmpRootFor(connection), 'app/config.php'));
  });

  it('refuses to map a remote path that would resolve outside the connection tmp root', () => {
    // Defense in depth behind remoteListing's name validation: even if some
    // other path ever reached here, a tmp file must never be written outside
    // the per-connection root.
    expect(() => tmpFilePathFor(connection, '/var/www/../../etc/passwd')).toThrow(/outside/i);
  });

  it('derives the sidecar path by appending .meta.json', () => {
    const tmpFile = tmpFilePathFor(connection, '/var/www/app/config.php');
    expect(sidecarPathFor(tmpFile)).toBe(`${tmpFile}.meta.json`);
  });
});
