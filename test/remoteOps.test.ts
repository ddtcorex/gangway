import { describe, it, expect, vi } from 'vitest';
// The mock module imported relatively: at runtime vitest aliases bare
// 'vscode' to this same file, so this is the identical module instance the
// code under test uses — but only the relative import carries the
// test-only __test_* queue helpers in tsc (which typechecks bare 'vscode'
// against the real @types/vscode, like every other test file).
import { window as mockWindow } from './mocks/vscode';
import { connectionSlug } from '../src/tmpPath';
import {
  assertInsideRoot,
  assertMutatingAllowed,
  assertNotReserved,
  FrozenError,
  guardUploadTarget,
  moveToTrash,
  trashRootsFor,
  WrongServerError,
} from '../src/remoteOps';
import { AuditLog } from '../src/auditLog';
import type { ConnectionConfig } from '../src/types';

const connection: ConnectionConfig = {
  id: 'c1',
  name: 'p',
  host: 'h',
  port: 22,
  username: 'u',
  remotePath: '/srv/app',
  authMethod: 'agent',
};

const frozenConnection: ConnectionConfig = { ...connection, frozen: true };

function fakeAuditLog() {
  return { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLog;
}

describe('remoteOps paths', () => {
  it('refuses reserved trash targets and paths outside the root', () => {
    expect(trashRootsFor(connection).dir).toBe(`/srv/.gangway-trash-${connectionSlug(connection)}`);
    expect(() => assertNotReserved(connection, `${trashRootsFor(connection).dir}/20240101-x/f.php`)).toThrow(
      /reserved/,
    );
    expect(() => assertInsideRoot(connection, '/srv/other/x.php')).toThrow(/outside/);
  });

  it('retries the in-root fallback and notes it when the sibling mkdir fails', async () => {
    const mkdir = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
      .mockResolvedValue(undefined);
    const renamed: string[] = [];
    const client = {
      mkdir,
      posixRename: vi.fn().mockImplementation(async (from: string, to: string) => {
        renamed.push(`${from}->${to}`);
      }),
      delete: vi.fn().mockResolvedValue(undefined),
      rmdir: vi.fn().mockResolvedValue(undefined),
      fastGet: vi.fn().mockResolvedValue(undefined),
      fastPut: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ mtime: 1, size: 1, isDirectory: false, isSymbolicLink: false }),
      chmod: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    };
    const auditLog = fakeAuditLog();
    const { trashPath } = await moveToTrash(client as never, connection, '/srv/app/a.php', auditLog);
    expect(trashPath).toMatch(/^\/srv\/app\/\.trash-gangway\//);
    expect(auditLog.append).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'delete', remotePath: '/srv/app/a.php', note: 'in-root-fallback' }),
    );
  });

  it('blocks every mutating op while frozen', () => {
    expect(() => assertMutatingAllowed(frozenConnection)).toThrow(FrozenError);
    expect(() => assertMutatingAllowed(frozenConnection)).toThrow(/Toggle Freeze/);
    expect(() => assertMutatingAllowed(connection)).not.toThrow();
  });

  it('moveToTrash posixRenames server-side and audits op delete', async () => {
    const calls: string[] = [];
    const client = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      posixRename: vi.fn().mockImplementation(async (from: string, to: string) => {
        calls.push(`${from}->${to}`);
      }),
      delete: vi.fn().mockResolvedValue(undefined),
      rmdir: vi.fn().mockResolvedValue(undefined),
      fastGet: vi.fn().mockResolvedValue(undefined),
      fastPut: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ mtime: 1, size: 1, isDirectory: false, isSymbolicLink: false }),
      chmod: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    };
    const auditLog = fakeAuditLog();
    const { trashPath } = await moveToTrash(client as never, connection, '/srv/app/a.php', auditLog);
    expect(calls[0]).toMatch(/^\/srv\/app\/a\.php->\/srv\/.gangway-trash-[0-9a-f]{10}\//);
    expect(trashPath).toBe(calls[0].split('->')[1]);
    expect(auditLog.append).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'delete', remotePath: '/srv/app/a.php' }),
    );
  });

  it('guards upload targets wrong-server-first, frozen-second', () => {
    const sidecarA = { connectionId: 'c1', remotePath: '/srv/app/a.php', mtime: 1, size: 1, downloadedAt: 1 };
    const sidecarB = { ...sidecarA, connectionId: 'c2' };
    expect(() => guardUploadTarget(connection, sidecarB)).toThrow(WrongServerError);
    expect(() => guardUploadTarget(frozenConnection, sidecarA)).toThrow(FrozenError);
    expect(() => guardUploadTarget(connection, sidecarA)).not.toThrow();
    expect(() => guardUploadTarget(connection, undefined)).not.toThrow();
  });
});

describe('vscode mock answer queues', () => {
  it('drives showInputBox from a FIFO queue, empty queue means dismissed', async () => {
    mockWindow.__test_queueInput('myname');
    mockWindow.__test_queueInput(undefined);
    await expect(mockWindow.showInputBox({})).resolves.toBe('myname');
    await expect(mockWindow.showInputBox({})).resolves.toBeUndefined();
    await expect(mockWindow.showInputBox({})).resolves.toBeUndefined();
    mockWindow.__test_resetAnswers();
  });
});
