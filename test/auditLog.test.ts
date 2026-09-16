import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../src/auditLog';

let logPath: string;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auditlog-test-'));
  logPath = path.join(dir, 'uploads.log');
});

afterEach(async () => {
  await fs.rm(path.dirname(logPath), { recursive: true, force: true });
});

describe('AuditLog', () => {
  it('appends one JSON line per entry, creating the file on first write', async () => {
    const log = new AuditLog(logPath);
    await log.append({ connectionId: 'c1', remotePath: '/var/www/a.php', timestamp: 1, byteSize: 10 });
    await log.append({ connectionId: 'c1', remotePath: '/var/www/b.php', timestamp: 2, byteSize: 20 });

    const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ connectionId: 'c1', remotePath: '/var/www/a.php', timestamp: 1, byteSize: 10 });
    expect(JSON.parse(lines[1])).toEqual({ connectionId: 'c1', remotePath: '/var/www/b.php', timestamp: 2, byteSize: 20 });
  });
});
