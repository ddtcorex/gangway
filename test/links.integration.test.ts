import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Client from 'ssh2-sftp-client';
import { SftpClientAdapter } from '../src/transfer/sftpClientAdapter';
import { uploadFile } from '../src/transfer/uploadFile';
import { mapListingToEntries } from '../src/remoteListing';
import { isLoopError, resolveLinkEntries } from '../src/linkResolver';
import { BrokenLinkError, gateWriteTarget, resolveTarget } from '../src/realTarget';
import { createDestinationGate } from '../src/destinationGate';
import { chooseDeleteMode } from '../src/remoteOps';
import { AuditLog } from '../src/auditLog';
import type { ConnectionConfig } from '../src/types';
import { HOTFIX2_SEED, seedLinks, SUBDIR_FILE_SEED } from './fixtures/seedLinks';

/**
 * Real-server proof of the symlink behavior the unit fakes only assume. Runs
 * ONLY with GANGWAY_SFTP=1 and the fixture up:
 *
 *   docker compose -f test/fixtures/docker-compose.sftp.yml up -d
 *   GANGWAY_SFTP=1 pnpm test --run test/links.integration.test.ts
 *
 * The link seeds (test/fixtures/seedLinks.ts) are written from the host into
 * the bind-mounted fixture dir before the suite and again after it, so the
 * tests may delete or write through them. The connection is rooted at
 * /var/www/nested: `link-file` and `up` point outside it.
 */
const enabled = process.env.GANGWAY_SFTP === '1';

const SSH = { host: '127.0.0.1', port: 2223, username: 'testuser' };
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'sftp-data');
const ROOT = '/var/www/nested';

const connection: ConnectionConfig = {
  id: 'links-it',
  name: 'links-it',
  ...SSH,
  remotePath: ROOT,
  authMethod: 'password',
};
const frozen: ConnectionConfig = { ...connection, frozen: true };

describe.runIf(enabled)('symlink behavior (docker sftp)', () => {
  let tmpHome: string;
  let auditLog: AuditLog;
  let raw: Client;
  let adapter: SftpClientAdapter;

  async function readRemote(remotePath: string): Promise<string> {
    const local = path.join(tmpHome, `read-${Math.random().toString(36).slice(2)}`);
    await adapter.fastGet(remotePath, local);
    return fs.readFile(local, 'utf8');
  }

  async function caught(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => undefined,
      (err: unknown) => err,
    );
  }

  beforeAll(async () => {
    await seedLinks(FIXTURE_DIR);
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'links-it-'));
    auditLog = new AuditLog(path.join(tmpHome, 'audit.log'));
    raw = new Client();
    await raw.connect({ ...SSH, password: 'testpass' });
    adapter = new SftpClientAdapter(raw as never);
  }, 30_000);

  afterAll(async () => {
    if (raw) await raw.end().catch(() => {});
    if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true });
    await seedLinks(FIXTURE_DIR);
  });

  it('stat follows a link while lstat reports isSymbolicLink', { timeout: 30_000 }, async () => {
    const followed = await adapter.stat(`${ROOT}/link-file`);
    expect(followed.isSymbolicLink).toBe(false);
    expect(followed.isDirectory).toBe(false);
    const own = await adapter.lstat(`${ROOT}/link-file`);
    expect(own.isSymbolicLink).toBe(true);
    expect((await adapter.stat(`${ROOT}/link-dir`)).isDirectory).toBe(true);
    expect(await adapter.lstat(`${ROOT}/link-dir`)).toMatchObject({ isSymbolicLink: true, isDirectory: false });
  });

  it('realPath of a relative link is absolute', { timeout: 30_000 }, async () => {
    expect(await adapter.realPath(`${ROOT}/link-rel`)).toBe(`${ROOT}/hotfix2.php`);
    expect(await adapter.realPath(`${ROOT}/link-file`)).toBe('/var/www/hotfix.php');
    expect(await adapter.realPath(`${ROOT}/link-dir`)).toBe(`${ROOT}/subdir`);
    expect(await adapter.realPath(`${ROOT}/up`)).toBe('/var/www');
  });

  it('realPath of a dangling link returns its missing target, so resolveTarget must lstat', { timeout: 30_000 }, async () => {
    // OpenSSH tolerates a missing last component: no "missing" answer here.
    expect(await adapter.realPath(`${ROOT}/broken`)).toBe(`${ROOT}/does-not-exist`);
    expect(await adapter.realPath(`${ROOT}/plain-missing.php`)).toBe(`${ROOT}/plain-missing.php`);
    const err = await caught(resolveTarget(adapter, connection, `${ROOT}/broken`));
    expect(err).toBeInstanceOf(BrokenLinkError);
    const below = await caught(resolveTarget(adapter, connection, `${ROOT}/broken/new.php`));
    expect(below).toBeInstanceOf(BrokenLinkError);
    expect((below as BrokenLinkError).clickedPath).toBe(`${ROOT}/broken`);
  });

  it('realPath of missing paths under an out-of-root directory link', { timeout: 30_000 }, async () => {
    expect(await adapter.realPath(`${ROOT}/up/missing.php`)).toBe('/var/www/missing.php');
    expect(await adapter.realPath(`${ROOT}/up/a/missing.php`)).toBeUndefined();
    expect(await adapter.realPath(`${ROOT}/up/a/b/missing.php`)).toBeUndefined();
    for (const p of [`${ROOT}/up/missing.php`, `${ROOT}/up/a/missing.php`, `${ROOT}/up/a/b/missing.php`]) {
      const target = await resolveTarget(adapter, connection, p);
      expect(target.realPath).toBe(p.replace(`${ROOT}/up`, '/var/www'));
      expect(target.insideRoot).toBe(false);
    }
  });

  it('the loop pair reads as missing, not as a loop error, and still fails closed', { timeout: 30_000 }, async () => {
    // OpenSSH maps ELOOP to SSH_FX_NO_SUCH_FILE: realpath answers "missing"
    // (the lib resolves '' for status 2) and stat rejects as ENOENT.
    expect(await adapter.realPath(`${ROOT}/loop-a`)).toBeUndefined();
    const statErr = await caught(adapter.stat(`${ROOT}/loop-a`));
    expect(statErr).toMatchObject({ code: 'ENOENT' });
    expect((statErr as Error).message).toMatch(/No such file/);
    expect(isLoopError(statErr)).toBe(false);
    expect((await adapter.lstat(`${ROOT}/loop-a`)).isSymbolicLink).toBe(true);
    // No write can go through it: the dangling-link check refuses it.
    expect(await caught(resolveTarget(adapter, connection, `${ROOT}/loop-a`))).toBeInstanceOf(BrokenLinkError);
  });

  it('resolveLinkEntries classifies the seeded links', { timeout: 30_000 }, async () => {
    const entries = mapListingToEntries(ROOT, await adapter.list(ROOT));
    const resolved = await resolveLinkEntries(adapter, entries);
    const byName = new Map(resolved.map((e) => [path.posix.basename(e.path), e]));
    expect(byName.get('link-file')?.link).toEqual({ realPath: '/var/www/hotfix.php', kind: 'file' });
    expect(byName.get('link-rel')?.link).toEqual({ realPath: `${ROOT}/hotfix2.php`, kind: 'file' });
    expect(byName.get('link-dir')?.link).toEqual({ realPath: `${ROOT}/subdir`, kind: 'dir' });
    expect(byName.get('link-dir')?.isDirectory).toBe(true);
    expect(byName.get('broken')?.link?.kind).toBe('broken');
    expect(byName.get('up')?.link).toEqual({ realPath: '/var/www', kind: 'loop' });
    expect(byName.get('up')?.isDirectory).toBe(true);
    // Reality: the loop pair is indistinguishable from a dangling link here.
    expect(byName.get('loop-a')?.link?.kind).toBe('broken');
    expect(byName.get('loop-b')?.link?.kind).toBe('broken');
    expect(byName.get('hotfix2.php')?.link).toBeUndefined();
  });

  it('upload through a link keeps the link and changes the target', { timeout: 30_000 }, async () => {
    const linkPath = `${ROOT}/link-rel`;
    const target = await resolveTarget(adapter, connection, linkPath);
    expect(target).toMatchObject({ realPath: `${ROOT}/hotfix2.php`, viaLink: true, insideRoot: true });
    const local = path.join(tmpHome, 'edit', 'link-rel');
    await fs.mkdir(path.dirname(local), { recursive: true });
    await fs.writeFile(local, 'through-the-link');
    await uploadFile(adapter, connection.id, local, target.realPath, 16, auditLog, undefined, {
      sidecarRemotePath: linkPath,
    });
    expect((await adapter.lstat(linkPath)).isSymbolicLink).toBe(true);
    expect(await fs.readlink(path.join(FIXTURE_DIR, 'nested', 'link-rel'))).toBe('./subdir/../hotfix2.php');
    expect(await readRemote(`${ROOT}/hotfix2.php`)).toBe('through-the-link');
  });

  it('uploadFile refuses a destination that is a link', { timeout: 30_000 }, async () => {
    await seedLinks(FIXTURE_DIR);
    const local = path.join(tmpHome, 'direct.php');
    await fs.writeFile(local, 'must-not-land');
    await expect(
      uploadFile(adapter, connection.id, local, `${ROOT}/link-rel`, 13, auditLog, undefined, { writeSidecar: false }),
    ).rejects.toThrow(/is a symlink/);
    expect((await adapter.lstat(`${ROOT}/link-rel`)).isSymbolicLink).toBe(true);
    expect(await readRemote(`${ROOT}/hotfix2.php`)).toBe(HOTFIX2_SEED);
  });

  it('delete of a link leaves the target', { timeout: 30_000 }, async () => {
    const linkPath = `${ROOT}/link-dir`;
    const own = await adapter.lstat(linkPath);
    expect(chooseDeleteMode({ isDirectory: true, isSymbolicLink: own.isSymbolicLink })).toBe('link');
    await adapter.delete(linkPath);
    await expect(adapter.lstat(linkPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await adapter.stat(`${ROOT}/subdir`)).isDirectory).toBe(true);
    expect(await readRemote(`${ROOT}/subdir/sub.php`)).toBe(SUBDIR_FILE_SEED);
    await seedLinks(FIXTURE_DIR);
  });

  it('out-of-root target is confirm-gated and frozen blocks it', { timeout: 30_000 }, async () => {
    const target = await resolveTarget(adapter, connection, `${ROOT}/link-file`);
    expect(target).toMatchObject({ realPath: '/var/www/hotfix.php', viaLink: true, insideRoot: false });
    expect(gateWriteTarget(connection, target)).toBe('confirm');
    expect(gateWriteTarget(frozen, target)).toBe('block');
    const inside = await resolveTarget(adapter, connection, `${ROOT}/link-rel`);
    expect(gateWriteTarget(frozen, inside)).toBe('allow');
  });

  it('a bulk destination gate refuses a directory link that points outside the root', { timeout: 30_000 }, async () => {
    const gate = createDestinationGate(adapter, connection);
    await expect(gate(`${ROOT}/up`)).rejects.toThrow(/really is "\/var\/www", outside the connection root/);
    await expect(gate(`${ROOT}/up/new-dir`)).rejects.toThrow(/outside the connection root/);
    await expect(gate(`${ROOT}/link-dir`)).resolves.toBeUndefined();
    await expect(gate(`${ROOT}/broken`)).rejects.toThrow(/broken link/);
  });
});
