import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkEditSession, acquireEditSession, releaseEditSession, remoteLockBase } from '../src/editSession';

let tmpDir: string;
let file: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'editsession-test-'));
  file = path.join(tmpDir, 'config.php');
  await fs.writeFile(file, 'content');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('editSession', () => {
  it('reports ok when no session lock exists', async () => {
    await expect(checkEditSession(file)).resolves.toEqual({ status: 'ok' });
  });

  it('reports ok for a lock this same process already owns', async () => {
    await acquireEditSession(file);
    await expect(checkEditSession(file)).resolves.toEqual({ status: 'ok' });
  });

  it('reports ok for a stale lock whose owning process is gone, instead of blocking forever', async () => {
    await fs.writeFile(`${file}.gangway-session.json`, JSON.stringify({ pid: 999999, startedAt: 1 }), 'utf8');
    const isAlive = () => false;
    await expect(checkEditSession(file, isAlive)).resolves.toEqual({ status: 'ok' });
  });

  it('reports ownedByAnotherLiveSession for a lock held by a different, still-running process', async () => {
    await fs.writeFile(`${file}.gangway-session.json`, JSON.stringify({ pid: 424242, startedAt: 1700000000000 }), 'utf8');
    const isAlive = (pid: number) => pid === 424242;
    await expect(checkEditSession(file, isAlive)).resolves.toEqual({
      status: 'ownedByAnotherLiveSession',
      owner: { pid: 424242, startedAt: 1700000000000 },
    });
  });

  it('reports ok for a torn/foreign lock file instead of throwing', async () => {
    await fs.writeFile(`${file}.gangway-session.json`, '{not json', 'utf8');
    await expect(checkEditSession(file)).resolves.toEqual({ status: 'ok' });
  });

  it('acquireEditSession writes a lock naming this process; releaseEditSession removes it', async () => {
    await acquireEditSession(file);
    const raw = JSON.parse(await fs.readFile(`${file}.gangway-session.json`, 'utf8'));
    expect(raw.pid).toBe(process.pid);
    expect(typeof raw.startedAt).toBe('number');

    await releaseEditSession(file);
    await expect(fs.access(`${file}.gangway-session.json`)).rejects.toThrow();
  });

  it('releaseEditSession tolerates a lock that was never created', async () => {
    await expect(releaseEditSession(file)).resolves.toBeUndefined();
  });
});

describe('remote lock keys', () => {
  it('same real path from two clicked paths shares one lock key', () => {
    const a = remoteLockBase(tmpDir, 'conn-1', '/srv/app/real.php');
    const b = remoteLockBase(tmpDir, 'conn-1', '/srv/app/real.php');
    expect(a).toBe(b);
    expect(a).toMatch(/\.remote-locks[\\/][0-9a-f]{16}$/);
    expect(path.dirname(path.dirname(a))).toBe(tmpDir);
  });

  it('different connections never share a key', () => {
    expect(remoteLockBase(tmpDir, 'conn-1', '/srv/app/real.php')).not.toBe(
      remoteLockBase(tmpDir, 'conn-2', '/srv/app/real.php'),
    );
  });

  it('acquire creates the .remote-locks directory', async () => {
    const base = remoteLockBase(tmpDir, 'conn-1', '/srv/app/real.php');
    await acquireEditSession(base);
    await expect(fs.stat(path.dirname(base))).resolves.toBeTruthy();
    await expect(checkEditSession(base, () => true)).resolves.toEqual({ status: 'ok' });
    await releaseEditSession(base);
  });

  it('stale pid lock is ignored for remote keys too', async () => {
    const base = remoteLockBase(tmpDir, 'conn-1', '/srv/app/real.php');
    await fs.mkdir(path.dirname(base), { recursive: true });
    await fs.writeFile(`${base}.gangway-session.json`, JSON.stringify({ pid: 999999, startedAt: 1 }));
    await expect(checkEditSession(base, () => false)).resolves.toEqual({ status: 'ok' });
    await expect(checkEditSession(base, () => true)).resolves.toMatchObject({ status: 'ownedByAnotherLiveSession' });
  });
});
