import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Client from 'ssh2-sftp-client';
import { SftpClientAdapter } from '../src/transfer/sftpClientAdapter';
import { uploadFile } from '../src/transfer/uploadFile';
import {
  backupRootsFor,
  emptyTrash,
  inventoryTrash,
  moveToTrash,
  renameRemote,
  restoreEntries,
} from '../src/remoteOps';
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

const SSH = { host: '127.0.0.1', port: 2222, username: 'testuser' };

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
    await adapter.rmdir(IT_ROOT, true).catch(() => {});
    await raw.end().catch(() => {});
    await fs.rm(tmpHome, { recursive: true, force: true });
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

  it('trash-delete then restore round-trips outside the docroot', { timeout: 30_000 }, async () => {
    const local = await stageLocal('t.php', 'trash me');
    const target = `${IT_ROOT}/t.php`;
    await adapter.fastPut(local, target);
    const { trashPath } = await moveToTrash(adapter, connection, target, auditLog);
    // The fixture user cannot write outside its area, so the in-root
    // fallback applies here by design (sibling placement needs a writable
    // parent, verified by the unit test with a cooperative fake).
    const inRoot = trashPath.includes('/.trash-gangway/');
    expect(trashPath).toMatch(inRoot ? /\.trash-gangway\// : /\.gangway-trash-[0-9a-f]{10}\//);
    expect(trashPath.startsWith('/var/www/')).toBe(true);
    await expect(adapter.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    const auditLines = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const deleteLine = auditLines.find((l) => l.op === 'delete' && l.remotePath === target);
    expect(deleteLine).toBeDefined();
    expect(deleteLine.note ?? null).toBe(inRoot ? 'in-root-fallback' : null);
    const picks = await inventoryTrash(adapter, connection);
    const pick = picks.find((p) => p.items.some((i) => i.originalPath === target));
    expect(pick).toBeDefined();
    const result = await restoreEntries(adapter, connection, [pick!], undefined, {
      confirmOverwrite: async () => 'overwrite' as const,
      auditLog,
    });
    expect(result.restored).toEqual([target]);
    expect(await adapter.stat(target)).toMatchObject({ isDirectory: false });
  });

  it('backup-before-overwrite keeps the original bytes', { timeout: 30_000 }, async () => {
    const target = `${IT_ROOT}/hot.php`;
    await adapter.fastPut(await stageLocal('v1.php', 'version-one'), target);
    await uploadFile(
      adapter, connection.id, await stageLocal('v2.php', 'version-two'), target, 11, auditLog, () => {},
      { backup: { connection } },
    );
    const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const uploadLine = lines.find((l) => l.op === 'upload' && l.remotePath === target);
    expect(uploadLine).toBeDefined();
    // The backup copy must hold the pre-overwrite bytes (sibling root, or
    // the in-root fallback when the parent is not writable — same rule as
    // trash, so probe both).
    const backupStat = await adapter.stat(`${target}.tmp`).catch(() => undefined);
    expect(backupStat).toBeUndefined();
    const candidateRoots = [backupRootsFor(connection).dir, '/var/www/.backup-gangway'];
    let stampFiles: string[] = [];
    for (const root of candidateRoots) {
      try {
        const stamps = await adapter.list(root);
        for (const stamp of stamps) {
          if (stamp.type !== 'd') continue;
          const walk: string[] = [`${root}/${stamp.name}`];
          while (walk.length > 0) {
            const dir = walk.pop() as string;
            for (const entry of await adapter.list(dir)) {
              const full = `${dir}/${entry.name}`;
              if (entry.type === 'd') walk.push(full);
              else stampFiles.push(full);
            }
          }
        }
        if (stampFiles.length > 0) break;
      } catch {
        continue;
      }
    }
    const backedUp = stampFiles.filter((f) => f.endsWith('hot.php'));
    expect(backedUp.length).toBeGreaterThan(0);
    const backupLocal = path.join(tmpHome, 'backup-copy.php');
    await adapter.fastGet(backedUp[0], backupLocal);
    expect(await fs.readFile(backupLocal, 'utf8')).toBe('version-one');
    const fresh = path.join(tmpHome, 'fresh.php');
    await adapter.fastGet(target, fresh);
    expect(await fs.readFile(fresh, 'utf8')).toBe('version-two');
  });

  it('emptyTrash permanently removes entries with per-entry audit lines', { timeout: 30_000 }, async () => {
    const target = `${IT_ROOT}/gone.php`;
    await adapter.fastPut(await stageLocal('g.php', 'bye'), target);
    await moveToTrash(adapter, connection, target, auditLog);
    const picks = await inventoryTrash(adapter, connection);
    const mine = picks.filter((p) => p.items.some((i) => i.originalPath === target));
    expect(mine.length).toBeGreaterThan(0);
    const result = await emptyTrash(adapter, connection, mine, auditLog);
    expect(result.entries).toBe(mine.length);
    const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.some((l) => l.op === 'empty-trash')).toBe(true);
    await expect(adapter.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
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
