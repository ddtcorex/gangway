import fs from 'node:fs/promises';
import { sidecarPathFor } from './tmpPath';
import type { SidecarMeta } from './types';

export async function ensureOwnerOnlyPermissions(filePath: string): Promise<void> {
  await fs.chmod(filePath, 0o600);
}

export async function writeSidecar(tmpFilePath: string, meta: SidecarMeta): Promise<void> {
  const sidecarPath = sidecarPathFor(tmpFilePath);
  await fs.writeFile(sidecarPath, JSON.stringify(meta), 'utf8');
  await ensureOwnerOnlyPermissions(tmpFilePath);
  await ensureOwnerOnlyPermissions(sidecarPath);
}

export async function readSidecar(tmpFilePath: string): Promise<SidecarMeta | undefined> {
  try {
    const raw = await fs.readFile(sidecarPathFor(tmpFilePath), 'utf8');
    return JSON.parse(raw) as SidecarMeta;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
