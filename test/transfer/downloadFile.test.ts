import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadFile } from '../../src/transfer/downloadFile';
import { readSidecar } from '../../src/tmpStore';
import { tmpFilePathFor } from '../../src/tmpPath';
import type { ConnectionConfig } from '../../src/types';

const connection: ConnectionConfig = {
  id: 'c1',
  name: 'staging',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  remotePath: '/var/www',
  authMethod: 'password',
};

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'download-test-'));
  vi.spyOn(os, 'tmpdir').mockReturnValue(tmpHome);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe('downloadFile', () => {
  it('creates the tmp file owner-only BEFORE any server bytes are written into it', async () => {
    // Tmp files hold client production data. writeSidecar() chmods 600, but
    // it only runs after a successful download: a transfer that crashed
    // mid-stream left the file at the default umask mode (typically 0644),
    // world-readable, for as long as it sat there. Pre-creating it closes the
    // window entirely rather than narrowing it.
    let modeDuringTransfer: number | undefined;
    const client = {
      stat: vi.fn().mockResolvedValue({ mtime: 1700000000, size: 42, isDirectory: false, isSymbolicLink: false }),
      fastGet: vi.fn().mockImplementation(async (_remote: string, local: string) => {
        modeDuringTransfer = (await fs.stat(local)).mode & 0o777;
        await fs.writeFile(local, 'server content');
      }),
    };

    await downloadFile(client, connection, '/var/www/app/config.php');

    expect(modeDuringTransfer).toBe(0o600);
  });

  it('streams the remote file to tmp and writes a sidecar with the fresh stat', async () => {
    const client = {
      stat: vi.fn().mockResolvedValue({ mtime: 1700000000, size: 42, isDirectory: false, isSymbolicLink: false }),
      fastGet: vi.fn().mockImplementation(async (_remote: string, local: string) => {
        await fs.mkdir(path.dirname(local), { recursive: true });
        await fs.writeFile(local, 'server content');
      }),
    };

    const result = await downloadFile(client, connection, '/var/www/app/config.php');

    expect(client.stat).toHaveBeenCalledWith('/var/www/app/config.php');
    // fastGet writes to a `.gangway-downloading` sibling, not straight into
    // result.localPath -- see the atomic-rename test below for why.
    expect(client.fastGet).toHaveBeenCalledWith('/var/www/app/config.php', `${result.localPath}.gangway-downloading`);
    expect(await fs.readFile(result.localPath, 'utf8')).toBe('server content');

    const sidecar = await readSidecar(result.localPath);
    expect(sidecar).toEqual({
      connectionId: 'c1',
      remotePath: '/var/www/app/config.php',
      mtime: 1700000000,
      size: 42,
      downloadedAt: expect.any(Number),
      localMtimeMs: expect.any(Number),
    });
    expect(result.meta).toEqual(sidecar);
  });

  it('never truncates a previous good copy at localPath when a re-download fails partway', async () => {
    // Re-downloading (the "discard local edits, refresh from server" gesture)
    // targets a localPath that may already hold a perfectly good copy from an
    // earlier download. Writing fastGet's bytes straight into that path used
    // to leave it holding only whatever partial bytes had arrived before a
    // crash/disconnect; the fix stages into a sibling and only renames over
    // localPath on success.
    const remotePath = '/var/www/app/config.php';
    const localPath = tmpFilePathFor(connection, remotePath);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, 'previous good copy');

    const client = {
      stat: vi.fn().mockResolvedValue({ mtime: 1700000000, size: 42, isDirectory: false, isSymbolicLink: false }),
      fastGet: vi.fn().mockImplementation(async (_remote: string, local: string) => {
        await fs.writeFile(local, 'partial garbage from a dropped connection');
        throw new Error('ECONNRESET');
      }),
    };

    await expect(downloadFile(client, connection, remotePath)).rejects.toThrow('ECONNRESET');

    expect(await fs.readFile(localPath, 'utf8')).toBe('previous good copy');
    // The failed attempt's staging file must not linger either.
    await expect(fs.access(`${localPath}.gangway-downloading`)).rejects.toThrow();
  });
});
