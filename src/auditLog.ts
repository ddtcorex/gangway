import fs from 'node:fs/promises';
import path from 'node:path';

export type AuditOp =
  | 'upload'
  | 'create'
  | 'rename'
  | 'delete'
  | 'duplicate'
  | 'move'
  | 'chmod'
  | 'sync'
  | 'restore'
  | 'empty-trash';

export interface AuditLogEntry {
  connectionId: string;
  remotePath: string;
  timestamp: number;
  byteSize?: number;
  op: AuditOp;
  count?: number;
  note?: string;
}

const KNOWN_OPS: ReadonlySet<string> = new Set([
  'upload',
  'create',
  'rename',
  'delete',
  'duplicate',
  'move',
  'chmod',
  'sync',
  'restore',
  'empty-trash',
]);

/**
 * Reads one audit line. Legacy 4-field lines (written before the `op`
 * field existed) parse as `op: 'upload'`; torn writes and foreign JSON
 * read as `undefined` rather than throwing, so a mixed or partially
 * corrupt log never breaks a reader.
 */
export function parseAuditLine(line: string): AuditLogEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const e = parsed as Record<string, unknown>;
  if (
    typeof e['connectionId'] !== 'string' ||
    typeof e['remotePath'] !== 'string' ||
    typeof e['timestamp'] !== 'number'
  ) {
    return undefined;
  }
  const op = typeof e['op'] === 'string' && KNOWN_OPS.has(e['op']) ? (e['op'] as AuditOp) : 'upload';
  return {
    connectionId: e['connectionId'] as string,
    remotePath: e['remotePath'] as string,
    timestamp: e['timestamp'] as number,
    ...(typeof e['byteSize'] === 'number' ? { byteSize: e['byteSize'] } : {}),
    op,
    ...(typeof e['count'] === 'number' ? { count: e['count'] } : {}),
    ...(typeof e['note'] === 'string' ? { note: e['note'] } : {}),
  };
}

export class AuditLog {
  constructor(private readonly logFilePath: string) {}

  async append(entry: AuditLogEntry): Promise<void> {
    // The log lives under `context.globalStorageUri`, which VS Code
    // guarantees is writable but does NOT create for you: an extension that
    // has never written there gets a path to a directory that does not exist
    // yet, and a bare appendFile would fail with ENOENT on the very first
    // upload.
    await fs.mkdir(path.dirname(this.logFilePath), { recursive: true });
    await fs.appendFile(this.logFilePath, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}
