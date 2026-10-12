import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Client from 'ssh2-sftp-client';
import { SftpClientAdapter } from '../src/transfer/sftpClientAdapter';
import { moveByDrop, type DropMoveDeps } from '../src/dropMove';
import { AuditLog } from '../src/auditLog';
import { TransferCancelledError } from '../src/folderQueue';
import type { ConnectionConfig } from '../src/types';

/**
 * Real-server proof that moveByDrop (cut-and-paste semantics) renames files
 * and folders server-side and leaves the server untouched when a drop is
 * refused. Runs ONLY with GANGWAY_SFTP=1 and the fixture up:
 *
 *   docker compose -f test/fixtures/docker-compose.sftp.yml up -d
 *   GANGWAY_SFTP=1 pnpm test --run test/dropMove.integration.test.ts
 *
 * Everything lives under a private folder it creates and removes itself.
 */
const enabled = process.env.GANGWAY_SFTP === '1';

const SSH = { host: '127.0.0.1', port: 2223, username: 'testuser' };
const ROOT = '/var/www/drop-it';

const connection: ConnectionConfig = {
  id: 'drop-it',
  name: 'drop-it',
  ...SSH,
  remotePath: ROOT,
  authMethod: 'password',
};

describe.runIf(enabled)('drop move (docker sftp)', () => {
  let tmpHome: string;
  let raw: Client;
  let adapter: SftpClientAdapter;

  const put = async (remotePath: string, content: string) => {
    const local = path.join(tmpHome, `put-${Math.random().toString(36).slice(2)}`);
    await fs.writeFile(local, content);
    await adapter.fastPut(local, remotePath);
  };
  const exists = (remotePath: string) =>
    adapter.lstat(remotePath).then(
      () => true,
      () => false,
    );
  async function readRemote(remotePath: string): Promise<string> {
    const local = path.join(tmpHome, `read-${Math.random().toString(36).slice(2)}`);
    await adapter.fastGet(remotePath, local);
    return fs.readFile(local, 'utf8');
  }
  const deps = (overrides: Partial<DropMoveDeps> = {}): DropMoveDeps => ({
    confirmOverwrite: async () => 'keepServer',
    chooseConflictPolicy: async () => 'skip',
    auditLog: new AuditLog(path.join(tmpHome, 'audit.log')),
    ...overrides,
  });

  beforeAll(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-it-'));
    raw = new Client();
    await raw.connect({ ...SSH, password: 'testpass' });
    adapter = new SftpClientAdapter(raw as never);
  }, 30_000);

  afterAll(async () => {
    if (raw) {
      await adapter.rmdir(ROOT, true).catch(() => {});
      await raw.end();
    }
    if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await adapter.rmdir(ROOT, true).catch(() => {});
    await adapter.mkdir(`${ROOT}/dest`, true);
    await adapter.mkdir(`${ROOT}/dir/inner`, true);
    await put(`${ROOT}/a.php`, 'A');
    await put(`${ROOT}/b.php`, 'B');
    await put(`${ROOT}/dir/inner/deep.php`, 'DEEP');
  });

  it('moves a file and a folder server-side, keeping their content', async () => {
    const result = await moveByDrop(adapter, connection, [`${ROOT}/a.php`, `${ROOT}/dir`], `${ROOT}/dest`, deps());
    expect(result.pasted).toEqual([`${ROOT}/dest/a.php`, `${ROOT}/dest/dir`]);
    expect(result.skipped).toEqual([]);
    expect(await exists(`${ROOT}/a.php`)).toBe(false);
    expect(await exists(`${ROOT}/dir`)).toBe(false);
    expect(await readRemote(`${ROOT}/dest/a.php`)).toBe('A');
    expect(await readRemote(`${ROOT}/dest/dir/inner/deep.php`)).toBe('DEEP');
  });

  it('refuses a folder dropped on its own descendant and changes nothing', async () => {
    const result = await moveByDrop(adapter, connection, [`${ROOT}/dir`], `${ROOT}/dir/inner`, deps());
    expect(result.pasted).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ path: `${ROOT}/dir`, reason: 'cannot move a folder into itself' });
    expect(await readRemote(`${ROOT}/dir/inner/deep.php`)).toBe('DEEP');
  });

  it('treats a drop onto the current parent as a no-op', async () => {
    const result = await moveByDrop(adapter, connection, [`${ROOT}/a.php`], ROOT, deps());
    expect(result).toEqual({ pasted: [], skipped: [] });
    expect(await readRemote(`${ROOT}/a.php`)).toBe('A');
  });

  it('skip leaves a conflicting server file untouched and still moves the rest', async () => {
    await put(`${ROOT}/dest/a.php`, 'SERVER-A');
    await put(`${ROOT}/dest/b.php`, 'SERVER-B');
    await put(`${ROOT}/c.php`, 'C');
    const result = await moveByDrop(
      adapter,
      connection,
      [`${ROOT}/a.php`, `${ROOT}/b.php`, `${ROOT}/c.php`],
      `${ROOT}/dest`,
      deps({ chooseConflictPolicy: async () => 'skip' }),
    );
    expect(result.pasted).toEqual([`${ROOT}/dest/c.php`]);
    expect(await readRemote(`${ROOT}/dest/a.php`)).toBe('SERVER-A');
    expect(await readRemote(`${ROOT}/dest/b.php`)).toBe('SERVER-B');
    expect(await readRemote(`${ROOT}/a.php`)).toBe('A');
  });

  it('cancel on the conflict prompt changes nothing on the server', async () => {
    await put(`${ROOT}/dest/a.php`, 'SERVER-A');
    await put(`${ROOT}/dest/b.php`, 'SERVER-B');
    await expect(
      moveByDrop(adapter, connection, [`${ROOT}/a.php`, `${ROOT}/b.php`], `${ROOT}/dest`, deps({ chooseConflictPolicy: async () => 'cancel' })),
    ).rejects.toBeInstanceOf(TransferCancelledError);
    expect(await readRemote(`${ROOT}/a.php`)).toBe('A');
    expect(await readRemote(`${ROOT}/dest/a.php`)).toBe('SERVER-A');
  });
});
