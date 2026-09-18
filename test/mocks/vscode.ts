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

const onDidChangeActiveTextEditorEmitter = new EventEmitter<MockTextEditor | undefined>();

export const window = {
  // Mutable so tests can simulate "the user has this file open" by
  // assigning `vscode.window.activeTextEditor = { document: { uri: { fsPath: '...' } } }`
  // before invoking a command handler, and reset to undefined afterwards.
  activeTextEditor: undefined as MockTextEditor | undefined,
  createWebviewPanel: (..._args: unknown[]) => createFakeWebviewPanel(),
  createTreeView: (_id: string, _options: unknown) => ({
    visible: false,
    dispose: () => {},
  }),
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
  showWarningMessage: async (_msg: string, ..._items: string[]) => undefined,
  showErrorMessage: async (_msg: string, ..._items: string[]) => undefined,
  showInformationMessage: async (_msg: string, ..._items: string[]) => undefined,
  showQuickPick: async (_items: unknown[], _opts?: unknown) => undefined,
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

export const workspace = {
  onDidSaveTextDocument: onDidSaveTextDocumentEmitter.event,
  /** Test-only: fires the real onDidSaveTextDocument listeners a production
   * subscriber attached, simulating a real editor save. */
  __test_fireDidSaveTextDocument: (uri: { fsPath: string }) => onDidSaveTextDocumentEmitter.fire({ uri }),
};

export const commands = {
  registerCommand: (_id: string, _handler: (...args: unknown[]) => unknown) => new Disposable(),
  // Used by the Conflict Guard to open the built-in diff editor
  // (`vscode.diff`). Tests spy on this to assert the diff was really opened
  // before the overwrite/keep-server/cancel choice was offered.
  executeCommand: async (_command: string, ..._args: unknown[]): Promise<unknown> => undefined,
};
