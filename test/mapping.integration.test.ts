import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Client from 'ssh2-sftp-client';
import { testConnection } from '../src/testConnection';
import { HostKeyStore } from '../src/hostKeyStore';
import { SftpClientAdapter } from '../src/transfer/sftpClientAdapter';
import { uploadFile } from '../src/transfer/uploadFile';
import { downloadFile } from '../src/transfer/downloadFile';
import { AuditLog } from '../src/auditLog';
import type { ConnectionConfig } from '../src/types';

/**
 * Live-server integration for the mapping/test-connection batch. Runs ONLY
 * with GANGWAY_SFTP=1 and a real `atmoz/sftp` fixture up:
 *
 *   docker compose -f test/fixtures/docker-compose.sftp.yml up -d
 *   GANGWAY_SFTP=1 pnpm test --run test/mapping.integration.test.ts
 *
 * Plain `pnpm test` skips the whole file (no docker needed, stays hermetic).
 */
const enabled = process.env.GANGWAY_SFTP === '1';

function fakeKeyValueStore() {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      data.set(key, value);
    },
  };
}

const SSH = { host: '127.0.0.1', port: 2223, username: 'testuser' };

const connection: ConnectionConfig = {
  id: 'mapping-it',
  name: 'mapping-it',
  ...SSH,
  remotePath: '/var/www',
  authMethod: 'password',
};

describe.runIf(enabled)('mapping integration (docker sftp)', () => {
  it('testConnection reports ok with the fixture password', { timeout: 30_000 }, async () => {
    const hostKeyStore = new HostKeyStore(fakeKeyValueStore());
    const result = await testConnection(
      {
        createClient: () => new Client() as never,
        hostKeyStore,
        prompt: { confirmNewOrChangedKey: async () => 'accept' as const },
        readFile: (p) => fs.readFile(p),
      },
      { ...SSH, authMethod: 'password', password: 'testpass' },
    );
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.fingerprint).toMatch(/^[0-9a-f]{32,}$/);
  });

  it('testConnection reports auth-failed for a wrong password', { timeout: 30_000 }, async () => {
    const hostKeyStore = new HostKeyStore(fakeKeyValueStore());
    const result = await testConnection(
      {
        createClient: () => new Client() as never,
        hostKeyStore,
        prompt: { confirmNewOrChangedKey: async () => 'accept' as const },
        readFile: (p) => fs.readFile(p),
      },
      { ...SSH, authMethod: 'password', password: 'wrongpass' },
    );
    expect(result).toMatchObject({ ok: false, kind: 'auth-failed' });
  });

  it('direct-overwrite upload then download round-trips bytes', { timeout: 30_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mapping-it-'));
    const localPath = path.join(dir, 'roundtrip.php');
    const content = `<?php echo 'it-${Date.now()}';`;
    await fs.writeFile(localPath, content);
    const remotePath = `/var/www/mapping-it-${process.pid}.php`;
    const raw = new Client();
    await raw.connect({ ...SSH, password: 'testpass' });
    const adapter = new SftpClientAdapter(raw as never);
    try {
      const logPath = path.join(dir, 'audit.log');
      const auditLog = new AuditLog(logPath);
      const byteSize = (await fs.stat(localPath)).size;
      await uploadFile(adapter, connection.id, localPath, remotePath, byteSize, auditLog);
      const { localPath: downloaded } = await downloadFile(adapter, connection, remotePath);
      expect(await fs.readFile(downloaded, 'utf8')).toBe(content);
    } finally {
      await raw.delete(remotePath).catch(() => {});
      await raw.end().catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
