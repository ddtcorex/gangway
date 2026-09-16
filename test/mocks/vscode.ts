export class Disposable {
  constructor(private readonly onDispose: () => void = () => {}) {}
  dispose(): void {
    this.onDispose();
  }
}

export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];
  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.push(listener);
    return new Disposable(() => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    });
  };
  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
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
};

export enum ViewColumn {
  Active = -1,
  One = 1,
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
    __test_fireMessage: (msg: unknown) => onDidReceiveMessage.fire(msg),
  };
}

export const window = {
  createWebviewPanel: (..._args: unknown[]) => createFakeWebviewPanel(),
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
  }),
  showWarningMessage: async (_msg: string, ..._items: string[]) => undefined,
  showErrorMessage: async (_msg: string, ..._items: string[]) => undefined,
  showInformationMessage: async (_msg: string, ..._items: string[]) => undefined,
  showQuickPick: async (_items: unknown[], _opts?: unknown) => undefined,
  showTextDocument: async (_uri: unknown) => ({}),
};

export const commands = {
  registerCommand: (_id: string, _handler: (...args: unknown[]) => unknown) => new Disposable(),
};
