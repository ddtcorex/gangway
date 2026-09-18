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
  let raw: string;
  try {
    raw = await fs.readFile(sidecarPathFor(tmpFilePath), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  // A torn write (crash between writeFile's open and flush) leaves invalid
  // JSON; a foreign file leaves valid JSON of the wrong shape. Both must
  // read as "no usable baseline" rather than throw: every caller already
  // handles undefined (warn-and-stop for derived paths, push-with-fresh-
  // check for explicit ones), while a throw aborts the command AND the
  // retention sweep that also reads sidecars.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as SidecarMeta).mtime !== 'number' ||
    typeof (parsed as SidecarMeta).size !== 'number' ||
    typeof (parsed as SidecarMeta).remotePath !== 'string' ||
    typeof (parsed as SidecarMeta).connectionId !== 'string'
  ) {
    return undefined;
  }
  return parsed as SidecarMeta;
}
