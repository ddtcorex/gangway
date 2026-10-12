import path from 'node:path';

// Leaf module: imports nothing from this repo, so any module may use it
// without creating an import cycle.

/**
 * Not-found detection across both error dialects: node:fs uses ENOENT while
 * ssh2-sftp-client reports numeric SFTP status codes ('2' = NO_SUCH_FILE,
 * verified against the lib, see errorMapper.ts). Found live 2026-09-19:
 * every trash/inventory/sweep path that checked ENOENT-only broke against
 * the real docker server on the first missing directory.
 */
export function isNotFoundError(err: unknown): boolean {
  const code =
    typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
  if (code === 'ENOENT' || code === '2') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /no such file/i.test(message);
}

/**
 * Pure lexical containment: true when remotePath is root itself or below it.
 * No server calls; symlinks are not followed (see realTarget.ts for that).
 */
export function isLexicallyInside(root: string, remotePath: string): boolean {
  const relative = path.posix.relative(root, remotePath);
  return !(relative === '..' || relative.startsWith(`..${path.posix.sep}`) || path.posix.isAbsolute(relative));
}
