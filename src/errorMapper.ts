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

  if (code === 'ENOENT') {
    return { message: 'The requested path does not exist on the server.', actions: ['retry'] };
  }
  if (code === 'ECONNRESET') {
    return { message: 'The connection was reset by the server.', actions: ['retry', 'disconnect'] };
  }
  if (/permission denied|4\d\d/i.test(rawMessage)) {
    return { message: `Permission denied by the server: ${rawMessage}`, actions: ['openOutput'] };
  }
  return { message: rawMessage, actions: ['retry', 'openOutput'] };
}
