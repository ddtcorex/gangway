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

  if (code === 'ENOENT') {
    return { message: 'The requested path does not exist on the server.', actions: ['retry'] };
  }
  if (code === 'ECONNRESET') {
    return { message: 'The connection was reset by the server.', actions: ['retry', 'disconnect'] };
  }
  if (/permission denied|\b4\d{2}\b/i.test(rawMessage)) {
    return { message: `Permission denied by the server: ${rawMessage}`, actions: ['openOutput'] };
  }
  return { message: rawMessage, actions: ['retry', 'openOutput'] };
}
