export class Disposable {
  constructor(private readonly onDispose: () => void = () => {}) {}
  dispose(): void {
    this.onDispose();
  }
}

export class EventEmitter<T> {
  private listeners: Array<(value: T) => void | Promise<void>> = [];
  readonly event = (listener: (value: T) => void | Promise<void>): Disposable => {
    this.listeners.push(listener);
    return new Disposable(() => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    });
  };
  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
  async fireAsync(value: T): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const listener of this.listeners) {
      const result = listener(value);
      if (result instanceof Promise) {
        promises.push(result);
      }
    }
    await Promise.all(promises);
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class ThemeIcon {
  constructor(public readonly id: string) {}
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class TreeItem {
  label: string;
  collapsibleState?: TreeItemCollapsibleState;
  iconPath?: ThemeIcon;
  contextValue?: string;
  constructor(label: string, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export const Uri = {
  file: (fsPath: string) => ({ fsPath, scheme: 'file' }),
  joinPath: (base: { fsPath: string }, ...segments: string[]) => ({
    fsPath: [base.fsPath, ...segments].join('/'),
    scheme: 'file',
  }),
};

export enum ViewColumn {
  Active = -1,
  One = 1,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

function createFakeWebviewPanel() {
  const onDidReceiveMessage = new EventEmitter<unknown>();
  return {
    webview: {
      html: '',
      onDidReceiveMessage: onDidReceiveMessage.event,
      postMessage: async (_msg: unknown) => true,
      asWebviewUri: (uri: { fsPath: string }) => uri,
      cspSource: 'vscode-webview://mock',
    },
    onDidDispose: () => new Disposable(),
    dispose: () => {},
    reveal: () => {},
    __test_fireMessage: (msg: unknown) => onDidReceiveMessage.fireAsync(msg),
  };
}

export interface MockTextEditor {
  document: { uri: { fsPath: string } };
}

const answerQueues: {
  warning: (string | undefined)[];
  error: (string | undefined)[];
  info: (string | undefined)[];
  pick: unknown[];
  input: (string | undefined)[];
} = { warning: [], error: [], info: [], pick: [], input: [] };

const onDidChangeActiveTextEditorEmitter = new EventEmitter<MockTextEditor | undefined>();

export const window = {
  // Mutable so tests can simulate "the user has this file open" by
  // assigning `vscode.window.activeTextEditor = { document: { uri: { fsPath: '...' } } }`
  // before invoking a command handler, and reset to undefined afterwards.
  activeTextEditor: undefined as MockTextEditor | undefined,
  // FIFO answer queues for prompt buttons and inputs. Tests push the user's
  // answers with __test_queueWarning/__test_queueError/__test_queueInfo/
  // __test_queuePick/__test_queueInput before invoking a handler; an empty
  // queue resolves undefined (the user dismissed the prompt), preserving the
  // old always-undefined behavior for tests that queue nothing.
  __test_queueWarning(...answers: (string | undefined)[]): void {
    answerQueues.warning.push(...answers);
  },
  __test_queueError(...answers: (string | undefined)[]): void {
    answerQueues.error.push(...answers);
  },
  __test_queueInfo(...answers: (string | undefined)[]): void {
    answerQueues.info.push(...answers);
  },
  __test_queuePick(...answers: unknown[]): void {
    answerQueues.pick.push(...answers);
  },
  __test_queueInput(...answers: (string | undefined)[]): void {
    answerQueues.input.push(...answers);
  },
  /** Test-only: drains every answer queue. */
  __test_resetAnswers(): void {
    answerQueues.warning.length = 0;
    answerQueues.error.length = 0;
    answerQueues.info.length = 0;
    answerQueues.pick.length = 0;
    answerQueues.input.length = 0;
  },
  createWebviewPanel: (..._args: unknown[]) => createFakeWebviewPanel(),
  createTreeView: (_id: string, _options: unknown) => {
    const selectionEmitter = new EventEmitter<{ selection: unknown[] }>();
    return {
      visible: false,
      dispose: () => {},
      onDidChangeSelection: selectionEmitter.event,
      /** Test-only: simulates the user clicking a tree row (once per call;
       * call twice with the same node within the double-click window to
       * simulate a double click). */
      __test_fireDidChangeSelection: (node: unknown) => selectionEmitter.fire({ selection: [node] }),
    };
  },
  createStatusBarItem: (..._args: unknown[]) => ({
    text: '',
    color: undefined as ThemeColor | undefined,
    tooltip: '',
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
  createOutputChannel: (_name: string) => ({
    appendLine: (_line: string) => {},
    show: () => {},
    dispose: () => {},
  }),
  showWarningMessage: async (_msg: string, ..._items: string[]) => answerQueues.warning.shift(),
  showErrorMessage: async (_msg: string, ..._items: string[]) => answerQueues.error.shift(),
  showInformationMessage: async (_msg: string, ..._items: string[]) => answerQueues.info.shift(),
  showQuickPick: async (_items: unknown[], _opts?: unknown) => answerQueues.pick.shift(),
  showInputBox: async (_opts?: unknown) => answerQueues.input.shift(),
  showTextDocument: async (_uri: unknown) => ({}),
  // The token mirrors vscode.CancellationToken closely enough for the folder
  // commands, which translate onCancellationRequested into an AbortController.
  withProgress: async <T>(
    _opts: unknown,
    task: (
      progress: { report: (v: unknown) => void },
      token: { isCancellationRequested: boolean; onCancellationRequested: (listener: () => void) => Disposable },
    ) => Promise<T>,
  ) => task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => new Disposable() }),
  registerFileDecorationProvider: (_provider: unknown) => new Disposable(),
  onDidChangeActiveTextEditor: onDidChangeActiveTextEditorEmitter.event,
  /** Test-only: simulates the user switching editor tabs. */
  __test_fireDidChangeActiveTextEditor: (editor: MockTextEditor | undefined) =>
    onDidChangeActiveTextEditorEmitter.fire(editor),
};

const onDidSaveTextDocumentEmitter = new EventEmitter<{ uri: { fsPath: string } }>();
const onDidCloseTextDocumentEmitter = new EventEmitter<{ uri: { fsPath: string } }>();
const onDidChangeWorkspaceFoldersEmitter = new EventEmitter<unknown>();

export interface MockWorkspaceFolder {
  uri: { fsPath: string };
  name: string;
}

export const workspace = {
  onDidSaveTextDocument: onDidSaveTextDocumentEmitter.event,
  /** Test-only: fires the real onDidSaveTextDocument listeners a production
   * subscriber attached, simulating a real editor save. */
  __test_fireDidSaveTextDocument: (uri: { fsPath: string }) => onDidSaveTextDocumentEmitter.fire({ uri }),
  onDidCloseTextDocument: onDidCloseTextDocumentEmitter.event,
  /** Test-only: simulates the user closing an editor tab. */
  __test_fireDidCloseTextDocument: (uri: { fsPath: string }) => onDidCloseTextDocumentEmitter.fire({ uri }),
  /** Mutable so tests can simulate an open govard project by assigning folders. */
  workspaceFolders: [] as MockWorkspaceFolder[],
  onDidChangeWorkspaceFolders: onDidChangeWorkspaceFoldersEmitter.event,
  /** Test-only: simulates adding/removing workspace folders. */
  __test_fireDidChangeWorkspaceFolders: () => onDidChangeWorkspaceFoldersEmitter.fire({}),
};

export const commands = {
  registerCommand: (_id: string, _handler: (...args: unknown[]) => unknown) => new Disposable(),
  // Used by the Conflict Guard to open the built-in diff editor
  // (`vscode.diff`). Tests spy on this to assert the diff was really opened
  // before the overwrite/keep-server/cancel choice was offered.
  executeCommand: async (_command: string, ..._args: unknown[]): Promise<unknown> => undefined,
};
