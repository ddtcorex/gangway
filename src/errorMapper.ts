import { AuthResolutionError } from './authResolver';

export type ErrorAction = 'retry' | 'openOutput' | 'disconnect';

export interface MappedError {
  message: string;
  actions: ErrorAction[];
}

function codeOf(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

const ACTION_LABELS: Record<ErrorAction, string> = {
  retry: 'Retry',
  openOutput: 'Open Output',
  disconnect: 'Disconnect',
};

/** The human-facing button label for a mapped error action (never show the raw token to the user). */
export function actionLabel(action: ErrorAction): string {
  return ACTION_LABELS[action];
}

export function mapSftpError(err: unknown): MappedError {
  const code = codeOf(err);
  const rawMessage = err instanceof Error ? err.message : String(err);

  // Auth resolution failures are already written for the user and describe a
  // LOCAL configuration problem (missing password, unreadable key file, no
  // agent). Their text routinely embeds the underlying fs message
  // ("ENOENT: ...", "EACCES: permission denied"), which the server-flavoured
  // branches below would otherwise rewrite into a server-side explanation.
  if (err instanceof AuthResolutionError) {
    return { message: rawMessage, actions: ['openOutput'] };
  }

  if (code === 'ENOENT' || code === '2') {
    return { message: 'The requested path does not exist on the server.', actions: ['retry'] };
  }
  if (code === 'ECONNRESET') {
    return { message: 'The connection was reset by the server.', actions: ['retry', 'disconnect'] };
  }
  // SFTP status codes arrive NUMERIC on err.code (verified against
  // ssh2/ssh2-sftp-client: 2 NO_SUCH_FILE, 3 PERMISSION_DENIED, 4 FAILURE,
  // ...), while system errors arrive named. A numeric 3 is therefore the
  // same fact as the words "Permission denied", even when the message text
  // itself is barren.
  if (code === '3' || /permission denied|\b4\d{2}\b/i.test(rawMessage)) {
    return { message: `Permission denied by the server: ${redactSecrets(rawMessage)}`, actions: ['openOutput'] };
  }
  return { message: redactSecrets(rawMessage), actions: ['retry', 'openOutput'] };
}

/**
 * Connection-level failures -- the pooled client for this connection can no
 * longer be trusted, and the caller should pool.invalidate() it so the next
 * command reconnects instead of reusing a dead socket. Anything else (a
 * missing path, a denied permission) says nothing about the health of the
 * connection itself.
 */
export function isConnectionError(err: unknown): boolean {
  const code = codeOf(err);
  if (code && ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', '6', '7'].includes(code)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /socket hang up|connection (was )?(reset|closed|aborted|lost)|no connection/i.test(message);
}

/**
 * Best-effort credential scrubber for server/transport text echoed to the
 * user. Safety here is layered: nothing in the product logs secrets in the
 * first place, and this is the backstop for text we did not author (server
 * banners, transport errors) that might embed a URL with userinfo or a
 * password assignment.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(\w+:\/\/[^/:@\s]+:)[^@\s]+@/g, '$1***@')
    .replace(/password\s*[:=]\s*(['"]?)\S+\1/gi, 'password: ***');
}
