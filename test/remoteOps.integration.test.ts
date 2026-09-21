import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Client from 'ssh2-sftp-client';
import { SftpClientAdapter } from '../src/transfer/sftpClientAdapter';
import { uploadFile } from '../src/transfer/uploadFile';
import { renameRemote } from '../src/remoteOps';
import { AuditLog } from '../src/auditLog';
import type { ConnectionConfig } from '../src/types';

/**
 * Live-server integration for the file/folder-ops batch. Runs ONLY with
 * GANGWAY_SFTP=1 and the fixture up:
 *
 *   docker compose -f test/fixtures/docker-compose.sftp.yml up -d
 *   GANGWAY_SFTP=1 pnpm test --run test/remoteOps.integration.test.ts
 *
 * Plain `pnpm test` skips the whole file (stays hermetic). All remote
 * state lives under /var/www/it-ops/ and is removed afterwards.
 */
const enabled = process.env.GANGWAY_SFTP === '1';

// Port 2223: the fixture's host mapping (docker-compose.sftp.yml). It moved
// off 2222, and on a dev machine that port is commonly another SSH server,
// which turns these suites into a misleading "auth failed" instead of a test.
const SSH = { host: '127.0.0.1', port: 2223, username: 'testuser' };

const connection: ConnectionConfig = {
  id: 'ops-it',
  name: 'ops-it',
  ...SSH,
  remotePath: '/var/www',
  authMethod: 'password',
};

const IT_ROOT = `/var/www/it-ops-${process.pid}`;

describe.runIf(enabled)('remoteOps integration (docker sftp)', () => {
  let tmpHome: string;
  let logPath: string;
  let auditLog: AuditLog;
  let raw: Client;
  let adapter: SftpClientAdapter;

  async function stageLocal(name: string, content: string): Promise<string> {
    const localPath = path.join(tmpHome, name);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, content);
    return localPath;
  }

  beforeAll(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-it-'));
    logPath = path.join(tmpHome, 'audit.log');
    auditLog = new AuditLog(logPath);
    raw = new Client();
    await raw.connect({ ...SSH, password: 'testpass' });
    adapter = new SftpClientAdapter(raw as never);
    await adapter.mkdir(IT_ROOT, true);
  }, 30_000);

  afterAll(async () => {
    // Guarded like the sibling integration suite: when beforeAll's connect
    // throws, `adapter` was never assigned and the teardown must not add a
    // second, louder failure on top of the real one.
    if (adapter) await adapter.rmdir(IT_ROOT, true).catch(() => {});
    if (raw) await raw.end().catch(() => {});
    if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('rename moves server-side and refuses clashes', { timeout: 30_000 }, async () => {
    const local = await stageLocal('a.php', 'aaa');
    await adapter.fastPut(local, `${IT_ROOT}/a.php`);
    const { newPath } = await renameRemote(adapter, connection, `${IT_ROOT}/a.php`, 'b.php', auditLog);
    expect(newPath).toBe(`${IT_ROOT}/b.php`);
    await expect(adapter.stat(`${IT_ROOT}/a.php`)).rejects.toMatchObject({ code: 'ENOENT' });
    await renameRemote(adapter, connection, `${IT_ROOT}/b.php`, 'c.php', auditLog);
    await expect(renameRemote(adapter, connection, `${IT_ROOT}/c.php`, 'c.php', auditLog)).rejects.toThrow(
      /already exists/,
    );
  });

  function trashBackupNames(names: string[]): string[] {
    return names.filter(
      (n) => n.startsWith('.gangway-trash-') || n === '.trash-gangway' || n.startsWith('.gangway-backup-') || n === '.backup-gangway',
    );
  }

  it('delete is a hard delete that creates no trash dir', { timeout: 30_000 }, async () => {
    const before = trashBackupNames((await adapter.list('/var/www')).map((e) => e.name));
    const local = await stageLocal('t.php', 'bye');
    const target = `${IT_ROOT}/t.php`;
    await adapter.fastPut(local, target);
    await adapter.delete(target);
    await expect(adapter.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    const after = trashBackupNames((await adapter.list('/var/www')).map((e) => e.name));
    expect(after).toEqual(before);
  });

  it('upload overwrites directly with no backup copy kept anywhere', { timeout: 30_000 }, async () => {
    const target = `${IT_ROOT}/hot.php`;
    const before = trashBackupNames((await adapter.list('/var/www')).map((e) => e.name));
    await adapter.fastPut(await stageLocal('v1.php', 'version-one'), target);
    await uploadFile(adapter, connection.id, await stageLocal('v2.php', 'version-two'), target, 11, auditLog);
    const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const uploadLine = lines.find((l) => l.op === 'upload' && l.remotePath === target);
    expect(uploadLine).toBeDefined();
    const fresh = path.join(tmpHome, 'fresh.php');
    await adapter.fastGet(target, fresh);
    expect(await fs.readFile(fresh, 'utf8')).toBe('version-two');
    // No backup root may have appeared: neither the sibling form nor the
    // legacy in-root form.
    const after = trashBackupNames((await adapter.list('/var/www')).map((e) => e.name));
    expect(after).toEqual(before);
  });

  it('audit lines never carry secret-shaped keys', { timeout: 30_000 }, async () => {
    const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      for (const key of Object.keys(line)) {
        expect(key).not.toMatch(/password|passphrase|privatekey|secret/i);
      }
      expect(JSON.stringify(line)).not.toContain('testpass');
    }
  });
});
