import fs from 'node:fs/promises';

export interface AuditLogEntry {
  connectionId: string;
  remotePath: string;
  timestamp: number;
  byteSize: number;
}

export class AuditLog {
  constructor(private readonly logFilePath: string) {}

  async append(entry: AuditLogEntry): Promise<void> {
    await fs.appendFile(this.logFilePath, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}
