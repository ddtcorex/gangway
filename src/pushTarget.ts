import { gateWriteTarget, LinkRetargetedError, resolveTarget, type ResolvedTarget, type TargetClient } from './realTarget';
import type { ConnectionConfig, SidecarMeta } from './types';

export type PushPreparation =
  | { status: 'ready'; target: ResolvedTarget; sidecarUpdate?: Partial<SidecarMeta> }
  | { status: 'blocked' | 'declined' };

/**
 * Decides where a single-file push lands. The bytes always go to the freshly
 * resolved real path, never to the clicked path, so a link is never replaced
 * by a regular file. Fails closed: resolution errors (broken link, loop,
 * transport) propagate, and a link that now points somewhere other than the
 * real path recorded at download time throws LinkRetargetedError, which
 * includes a link replaced by a regular file. A sidecar without realPath
 * (written before links were tracked, or a plain file) pushes to the fresh
 * real path. A real path outside the connection root is blocked on a frozen
 * connection and otherwise needs one confirmation per real path, remembered
 * through sidecarUpdate. The freeze gate itself runs before this, separately.
 */
export async function preparePush(
  client: TargetClient,
  connection: ConnectionConfig,
  sidecar: SidecarMeta | undefined,
  remotePath: string,
  confirm: (realPath: string) => Promise<boolean>,
): Promise<PushPreparation> {
  const target = await resolveTarget(client, connection, remotePath);
  if (sidecar?.realPath !== undefined && sidecar.realPath !== target.realPath) {
    throw new LinkRetargetedError(remotePath, sidecar.realPath, target.realPath);
  }

  const gate = gateWriteTarget(connection, target);
  if (gate === 'block') return { status: 'blocked' };
  if (gate === 'allow') return { status: 'ready', target };

  if (sidecar?.outsideRootConfirmedFor === target.realPath) return { status: 'ready', target };
  if (!(await confirm(target.realPath))) return { status: 'declined' };
  return { status: 'ready', target, sidecarUpdate: { outsideRootConfirmedFor: target.realPath } };
}
