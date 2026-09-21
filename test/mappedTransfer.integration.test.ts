import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Client from 'ssh2-sftp-client';
import { SftpClientAdapter } from '../src/transfer/sftpClientAdapter';
import { pullMappedFile, pushMappedFile, walkMappedLocalFiles } from '../src/mappedTransfer';
import { matchesExcludes } from '../src/excludes';
import { isNotFoundError } from '../src/remoteOps';

/**
 * Live-server integration for the mapped-sync batch (spec §4/§6). Runs ONLY
 * with GANGWAY_SFTP=1 and the docker `atmoz/sftp` fixture up:
 *
 *   docker compose -f test/fixtures/docker-compose.sftp.yml up -d --wait
 *   GANGWAY_SFTP=1 pnpm vitest run test/mappedTransfer.integration.test.ts
 *
 * Plain `pnpm test` skips the whole file (no docker needed, stays hermetic).
 *
 * What only a real server can prove here: `fastPut` + `posixRename` really
 * replace an EXISTING remote file, `mkdir` really creates the nested parents
 * a mapped push assumes, and a not-found really arrives as the real client's
 * `ENOENT`/numeric dialect instead of a mock's assumption.
 *
 * Port 2223 is the fixture's host mapping (docker-compose.sftp.yml). It is
 * deliberately not 2222: that port is what the fixture used before it moved,
 * and on a dev machine it is commonly another SSH server, which turns this
 * suite into a false "auth failed" instead of a transfer test.
 *
 * Fixture state: every file this suite writes lives under IT_ROOT (unique per
 * process) and is removed again in afterAll, so no run depends on — or
 * leaves behind — seed data the E2E reset does not own.
 */
const SSH = { host: '127.0.0.1', port: 2223, username: 'testuser' };
const IT_ROOT = `/var/www/mapped-it-${process.pid}`;

/** Asserts a remote path is absent using the production not-found helper
 * (node:fs `ENOENT` vs the real client's numeric SFTP dialect — the mocking
 * blind spot docs/testing.md rule 8 exists for). */
async function expectNotFound(run: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected the remote path to be absent, but the call succeeded').toBeDefined();
  expect(isNotFoundError(caught), `expected a not-found failure, got: ${String(caught)}`).toBe(true);
}

describe.skipIf(process.env.GANGWAY_SFTP !== '1')('mapped transfer integration (docker sftp)', () => {
  let tmpHome: string;
  let raw: Client;
  let adapter: SftpClientAdapter;

  /** Nested file names under `dir`, posix-joined, sorted — the whole
   * server-side truth for "what actually landed". */
  async function remoteTree(root: string): Promise<string[]> {
    const found: string[] = [];
    const stack = [{ dir: root, prefix: '' }];
    while (stack.length > 0) {
      const { dir, prefix } = stack.pop() as { dir: string; prefix: string };
      for (const entry of await adapter.list(dir)) {
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.type === 'd') stack.push({ dir: `${dir}/${entry.name}`, prefix: rel });
        else found.push(rel);
      }
    }
    return found.sort();
  }

  async function fetchRemoteText(remotePath: string, label: string): Promise<string> {
    const copy = path.join(tmpHome, `fetched-${label}`);
    await adapter.fastGet(remotePath, copy);
    return fs.readFile(copy, 'utf8');
  }

  beforeAll(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mapped-it-'));
    raw = new Client();
    await raw.connect({ ...SSH, password: 'testpass' });
    adapter = new SftpClientAdapter(raw as never);
    await adapter.mkdir(IT_ROOT, true);
  }, 30_000);

  afterAll(async () => {
    if (adapter) await adapter.rmdir(IT_ROOT, true).catch(() => {});
    if (raw) await raw.end().catch(() => {});
    if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('pushes a workspace file and pulls it back byte-identical', { timeout: 30_000 }, async () => {
    const remotePath = `${IT_ROOT}/roundtrip.php`;
    const localSource = path.join(tmpHome, 'roundtrip.php');
    // Multi-byte characters and a trailing newline: an encoding-damaging
    // transfer (or a text-mode one) would not survive the round trip.
    const original = "<?php echo 'round-trip ünïcode ✓';\n";
    await fs.writeFile(localSource, original, 'utf8');

    await pushMappedFile(adapter, localSource, remotePath);

    const pushed = await adapter.stat(remotePath);
    expect(pushed).toMatchObject({ size: Buffer.byteLength(original), isDirectory: false });
    await expectNotFound(() => adapter.stat(`${remotePath}.tmp`));

    const localDest = path.join(tmpHome, 'pulled.php');
    await pullMappedFile(adapter, remotePath, localDest);
    expect(await fs.readFile(localDest, 'utf8')).toBe(original);

    // Pull reflects the LIVE server copy, not the local file it overwrote:
    // edit the server side out of band, dirty the destination, pull again.
    const serverContent = "<?php echo 'live-server';\n";
    const stagedEdit = path.join(tmpHome, 'server-edit.php');
    await fs.writeFile(stagedEdit, serverContent, 'utf8');
    await adapter.fastPut(stagedEdit, remotePath);
    await fs.writeFile(localDest, 'stale local copy that must be overwritten by pure B');
    await pullMappedFile(adapter, remotePath, localDest);
    expect(await fs.readFile(localDest, 'utf8')).toBe(serverContent);

    // Pure-B carve-out (spec §4) seen from the server side: direct overwrite
    // with no backup copy, no `.tmp` orphan, no sidecar/audit artifact, and
    // no staging file left next to the local destination.
    expect(await remoteTree(IT_ROOT)).toEqual(['roundtrip.php']);
    const localNames = await fs.readdir(tmpHome);
    expect(localNames.filter((name) => name.includes('.gangway-'))).toEqual([]);
  });

  it('walks + pushes a folder honoring excludes', { timeout: 30_000 }, async () => {
    const localRoot = path.join(tmpHome, 'tree');
    await fs.mkdir(path.join(localRoot, 'sub'), { recursive: true });
    await fs.mkdir(path.join(localRoot, 'skip'), { recursive: true });
    await fs.writeFile(path.join(localRoot, 'a.php'), 'aaa');
    await fs.writeFile(path.join(localRoot, 'sub', 'b.php'), 'bbb');
    await fs.writeFile(path.join(localRoot, 'skip', 'c.php'), 'ccc');
    await fs.writeFile(path.join(localRoot, 'note.tmp'), 'tmp');
    await fs.writeFile(path.join(localRoot, 'side.meta.json'), '{}');
    await fs.writeFile(path.join(localRoot, 'cmp.gangway-compare-fresh'), 'x');
    await fs.symlink(path.join(localRoot, 'a.php'), path.join(localRoot, 'link.php'));

    // The real matcher with real patterns, not a hand-rolled predicate: the
    // excludes are the thing under test.
    const patterns = ['skip/**', '*.tmp'];
    const walk = await walkMappedLocalFiles(localRoot, (rel) => matchesExcludes(rel, patterns));
    expect(walk.files.map((file) => file.rel)).toEqual(['a.php', 'sub/b.php']);
    expect(walk.excluded).toBe(2);
    expect(walk.skippedSymlinks).toEqual(['link.php']);

    const remoteRoot = `${IT_ROOT}/tree`;
    for (const file of walk.files) {
      await pushMappedFile(adapter, file.localPath, `${remoteRoot}/${file.rel}`);
    }

    // The nested parent only exists because pushMappedFile mkdirs it.
    expect(await fetchRemoteText(`${remoteRoot}/sub/b.php`, 'b.php')).toBe('bbb');
    expect(await remoteTree(remoteRoot)).toEqual(['a.php', 'sub/b.php']);

    // Nothing excluded may reach the server — not even the excluded
    // directory, and never the symlink (which would arrive as a plain copy).
    await expectNotFound(() => adapter.stat(`${remoteRoot}/skip`));
    await expectNotFound(() => adapter.stat(`${remoteRoot}/skip/c.php`));
    await expectNotFound(() => adapter.stat(`${remoteRoot}/note.tmp`));
    await expectNotFound(() => adapter.stat(`${remoteRoot}/link.php`));
  });
});
