import fs from 'node:fs/promises';
import path from 'node:path';

export interface AuditLogEntry {
  connectionId: string;
  remotePath: string;
  timestamp: number;
  byteSize: number;
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
