import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { freshServerCopyPathFor, resolveFileConflict } from '../../src/ui/conflictResolution';
import { readSidecar, writeSidecar } from '../../src/tmpStore';
import type { ConflictResolutionClient, ConflictResolutionUi } from '../../src/ui/conflictResolution';
import type { FileConflictDecision } from '../../src/conflictGuard';

let tmpHome: string;
let localPath: string;

const SERVER_CONTENT = "<?php echo 'server';";
const LOCAL_CONTENT = "<?php echo 'local';";

/** Mimics the real adapter: fastGet writes the server's bytes to the given
 * local path, stat reports the server's current mtime/size. */
function fakeClient(calls: string[] = []): ConflictResolutionClient {
  return {
    fastGet: vi.fn().mockImplementation(async (remotePath: string, destination: string) => {
      calls.push(`fastGet:${remotePath}`);
      await fs.writeFile(destination, SERVER_CONTENT, 'utf8');
    }),
    stat: vi.fn().mockResolvedValue({ mtime: 1800000000, size: SERVER_CONTENT.length, isDirectory: false, isSymbolicLink: false }),
  };
}

function fakeUi(decision: FileConflictDecision, calls: string[]): ConflictResolutionUi {
  return {
    showDiff: vi.fn().mockImplementation(async (left: string, right: string) => {
      calls.push(`showDiff:${path.basename(left)}|${path.basename(right)}`);
    }),
    askDecision: vi.fn().mockImplementation(async () => {
      calls.push(`askDecision:${decision}`);
      return decision;
    }),
  };
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gangway-conflict-test-'));
  localPath = path.join(tmpHome, 'hotfix.php');
  await fs.writeFile(localPath, LOCAL_CONTENT, 'utf8');
  await writeSidecar(localPath, {
    connectionId: 'c1',
    remotePath: '/var/www/hotfix.php',
    mtime: 1700000000,
    size: 11,
    downloadedAt: 1700000000000,
  });
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe('freshServerCopyPathFor', () => {
  it('is a sibling of the local tmp file and never collides with its sidecar', () => {
    const copyPath = freshServerCopyPathFor('/tmp/vs-sftp/abc/app/config.php');
    expect(path.dirname(copyPath)).toBe('/tmp/vs-sftp/abc/app');
    expect(copyPath).not.toBe('/tmp/vs-sftp/abc/app/config.php');
    expect(copyPath.endsWith('.meta.json')).toBe(false);
  });
});

describe('resolveFileConflict', () => {
  it('fetches the current server copy and shows the diff BEFORE asking for a decision', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls);
    const ui = fakeUi('cancel', calls);

    await resolveFileConflict(client, 'c1', localPath, '/var/www/hotfix.php', ui);

    expect(calls[0]).toBe('fastGet:/var/www/hotfix.php');
    expect(calls[1]).toBe(`showDiff:hotfix.php|${path.basename(freshServerCopyPathFor(localPath))}`);
    expect(calls[2]).toBe('askDecision:cancel');
  });

  it("returns 'overwrite' and leaves the local file alone so the caller can push it", async () => {
    const calls: string[] = [];
    const decision = await resolveFileConflict(fakeClient(calls), 'c1', localPath, '/var/www/hotfix.php', fakeUi('overwrite', calls));

    expect(decision).toBe('overwrite');
    await expect(fs.readFile(localPath, 'utf8')).resolves.toBe(LOCAL_CONTENT);
    // The sidecar must NOT be touched here: the upload itself refreshes it
    // after the push actually lands.
    expect((await readSidecar(localPath))!.mtime).toBe(1700000000);
  });

  it("replaces the local file with the server copy and refreshes the sidecar for 'keepServer'", async () => {
    const calls: string[] = [];
    const client = fakeClient(calls);

    const decision = await resolveFileConflict(client, 'c1', localPath, '/var/www/hotfix.php', fakeUi('keepServer', calls));

    expect(decision).toBe('keepServer');
    await expect(fs.readFile(localPath, 'utf8')).resolves.toBe(SERVER_CONTENT);
    // Without the sidecar refresh the very next upload would report a
    // conflict against the stale pre-discard baseline.
    expect(await readSidecar(localPath)).toEqual({
      connectionId: 'c1',
      remotePath: '/var/www/hotfix.php',
      mtime: 1800000000,
      size: SERVER_CONTENT.length,
      downloadedAt: expect.any(Number),
    });
  });

  it("changes nothing on disk for 'cancel'", async () => {
    const calls: string[] = [];
    const decision = await resolveFileConflict(fakeClient(calls), 'c1', localPath, '/var/www/hotfix.php', fakeUi('cancel', calls));

    expect(decision).toBe('cancel');
    await expect(fs.readFile(localPath, 'utf8')).resolves.toBe(LOCAL_CONTENT);
    expect((await readSidecar(localPath))!.mtime).toBe(1700000000);
  });

  it('always removes the throwaway server copy, whichever decision was made', async () => {
    for (const decision of ['overwrite', 'keepServer', 'cancel'] as FileConflictDecision[]) {
      await fs.writeFile(localPath, LOCAL_CONTENT, 'utf8');
      await resolveFileConflict(fakeClient(), 'c1', localPath, '/var/www/hotfix.php', fakeUi(decision, []));
      await expect(fs.access(freshServerCopyPathFor(localPath))).rejects.toThrow();
    }
  });

  it('removes the throwaway server copy even when the decision step throws', async () => {
    const client = fakeClient();
    const ui: ConflictResolutionUi = {
      showDiff: vi.fn().mockResolvedValue(undefined),
      askDecision: vi.fn().mockRejectedValue(new Error('UI exploded')),
    };

    await expect(resolveFileConflict(client, 'c1', localPath, '/var/www/hotfix.php', ui)).rejects.toThrow('UI exploded');
    await expect(fs.access(freshServerCopyPathFor(localPath))).rejects.toThrow();
  });
});
