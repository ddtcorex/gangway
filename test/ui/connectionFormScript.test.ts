import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import type { ConnectionConfig } from '../../src/types';

/**
 * Executes the REAL shipped webview script (src/ui/media/connectionForm/main.js,
 * copied verbatim into dist/media by esbuild.js) against a minimal fake DOM.
 *
 * Why this file exists at all: the previous version of main.js read
 * `document.currentScript.nonce` at its very first statement. The script tag
 * that loads it is `<script type="module">`, and per the HTML spec
 * `document.currentScript` is ALWAYS null inside a module script -- so that
 * line threw a TypeError before anything else ran and the Save button's click
 * listener was never attached. The whole connection form was dead on arrival,
 * yet every string-content assertion on the HTML template still passed,
 * because nothing ever *executed* the script. These tests execute it.
 */
const MAIN_JS_PATH = path.resolve(__dirname, '../../src/ui/media/connectionForm/main.js');

interface FakeEvent {
  defaultPrevented?: boolean;
  preventDefault(): void;
}

/**
 * A minimal, mutable stand-in for a real DOM element/text node. `textContent`
 * follows real DOM semantics (setting it discards any child elements), which
 * is what makes `renderRemotesList()`'s `list.textContent = ''; ...
 * appendChild(...)` pattern behave the same way here as in a real webview.
 */
class FakeElement {
  value = '';
  hidden = false;
  className = '';
  title = '';
  dataset: Record<string, string>;
  readonly children: FakeElement[] = [];
  private _textContent = '';
  private readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();

  constructor(dataset: Record<string, string> = {}) {
    this.dataset = dataset;
  }

  get textContent(): string {
    return this._textContent;
  }

  set textContent(value: string) {
    this._textContent = value;
    this.children.length = 0;
  }

  appendChild(child: FakeElement): void {
    this.children.push(child);
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  /** Test-only: fires whatever listeners the script attached for `type`. */
  emit(type: string, event?: FakeEvent): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event ?? { preventDefault: () => {} });
    }
  }
}

interface PostedMessage {
  nonce: string;
  type: string;
  payload?: Record<string, unknown>;
}

interface FakeDom {
  elements: Map<string, FakeElement>;
  posted: PostedMessage[];
  fieldsFor(authMethod: string): FakeElement[];
  /** Simulates the host replying via `panel.webview.postMessage(...)`. */
  emitWindowMessage(data: unknown): void;
  /** The sidebar's rendered rows, in DOM order, read back from #remotesList's children. */
  remoteRows(): FakeElement[];
}

/**
 * Builds the fake DOM, runs the real main.js inside a fresh vm context, and
 * hands back the handles a test needs. Deliberately a *minimal* stand-in: it
 * exposes only what main.js actually touches (`document.body.dataset`,
 * `getElementById`, `querySelectorAll`, `createElement`, `acquireVsCodeApi`),
 * so any script that reaches for something else (`document.currentScript`,
 * for one) fails loudly here instead of silently in a real webview.
 */
function runConnectionFormScript(options: {
  nonce: string;
  connectionId?: string;
  values?: Record<string, string>;
  connections?: ConnectionConfig[];
}): FakeDom {
  const values = options.values ?? {};
  const ids = [
    'name',
    'host',
    'port',
    'username',
    'remotePath',
    'authMethod',
    'password',
    'keyPath',
    'keyPassphrase',
    'save',
    'browseKeyPath',
    'addRemote',
    'formHeading',
    'remotesList',
  ];
  const elements = new Map<string, FakeElement>();
  for (const id of ids) {
    const el = new FakeElement();
    el.value = values[id] ?? '';
    elements.set(id, el);
  }

  const connectionsDataEl = new FakeElement();
  connectionsDataEl.textContent = JSON.stringify(options.connections ?? []);
  elements.set('connections-data', connectionsDataEl);

  const authFields: FakeElement[] = [
    new FakeElement({ authField: 'password' }),
    new FakeElement({ authField: 'key' }),
    new FakeElement({ authField: 'key' }),
  ];

  const posted: PostedMessage[] = [];
  const windowListeners = new Map<string, Array<(event: unknown) => void>>();
  const context = vm.createContext({
    acquireVsCodeApi: () => ({
      postMessage: (message: PostedMessage) => {
        posted.push(message);
      },
    }),
    document: {
      body: { dataset: { nonce: options.nonce, connectionId: options.connectionId ?? '' } },
      getElementById: (id: string) => elements.get(id),
      querySelectorAll: (selector: string) => (selector === '[data-auth-field]' ? authFields : []),
      createElement: (_tag: string) => new FakeElement(),
    },
    window: {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        const existing = windowListeners.get(type) ?? [];
        existing.push(listener);
        windowListeners.set(type, existing);
      },
    },
  });

  vm.runInContext(fs.readFileSync(MAIN_JS_PATH, 'utf8'), context, { filename: MAIN_JS_PATH });

  return {
    elements,
    posted,
    fieldsFor: (authMethod: string) => authFields.filter((field) => field.dataset.authField === authMethod),
    emitWindowMessage: (data: unknown) => {
      for (const listener of windowListeners.get('message') ?? []) listener({ data });
    },
    remoteRows: () => elements.get('remotesList')!.children,
  };
}

describe('connection form webview script', () => {
  it('attaches a working Save click handler that posts the form with the nonce from <body data-nonce>', () => {
    const dom = runConnectionFormScript({
      nonce: 'nonce-from-body',
      values: {
        name: 'staging',
        host: 'example.com',
        port: '2222',
        username: 'deploy',
        remotePath: '/var/www',
        authMethod: 'password',
        password: 'hunter2',
      },
    });

    dom.elements.get('save')!.emit('click');

    expect(dom.posted).toHaveLength(1);
    expect(dom.posted[0]).toMatchObject({
      nonce: 'nonce-from-body',
      type: 'saveConnection',
      payload: {
        name: 'staging',
        host: 'example.com',
        port: 2222,
        username: 'deploy',
        remotePath: '/var/www',
        authMethod: 'password',
      },
    });
  });

  it('calls preventDefault so the Save button never submits the form and reloads the webview', () => {
    const dom = runConnectionFormScript({ nonce: 'n', values: { authMethod: 'password' } });
    let prevented = false;

    dom.elements.get('save')!.emit('click', {
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(prevented).toBe(true);
  });

  it('sends the typed password for password auth, and no key fields', () => {
    const dom = runConnectionFormScript({
      nonce: 'n',
      values: { authMethod: 'password', password: 'hunter2', keyPath: '/leftover/path' },
    });

    dom.elements.get('save')!.emit('click');

    expect(dom.posted[0].payload).toMatchObject({ authMethod: 'password', password: 'hunter2' });
    expect(dom.posted[0].payload).not.toHaveProperty('keyPath');
    expect(dom.posted[0].payload).not.toHaveProperty('keyPassphrase');
  });

  it('sends keyPath and keyPassphrase for key auth, and no password', () => {
    const dom = runConnectionFormScript({
      nonce: 'n',
      values: {
        authMethod: 'key',
        password: 'leftover-password',
        keyPath: '/home/deploy/.ssh/id_ed25519',
        keyPassphrase: 'phrase',
      },
    });

    dom.elements.get('save')!.emit('click');

    expect(dom.posted[0].payload).toMatchObject({
      authMethod: 'key',
      keyPath: '/home/deploy/.ssh/id_ed25519',
      keyPassphrase: 'phrase',
    });
    expect(dom.posted[0].payload).not.toHaveProperty('password');
  });

  it('omits the optional passphrase when the user left it blank', () => {
    const dom = runConnectionFormScript({
      nonce: 'n',
      values: { authMethod: 'key', keyPath: '/home/deploy/.ssh/id_ed25519', keyPassphrase: '' },
    });

    dom.elements.get('save')!.emit('click');

    expect(dom.posted[0].payload).toMatchObject({ keyPath: '/home/deploy/.ssh/id_ed25519' });
    expect(dom.posted[0].payload).not.toHaveProperty('keyPassphrase');
  });

  it('sends no credential fields at all for agent auth', () => {
    const dom = runConnectionFormScript({
      nonce: 'n',
      values: { authMethod: 'agent', password: 'leftover', keyPath: '/leftover' },
    });

    dom.elements.get('save')!.emit('click');

    expect(dom.posted[0].payload).not.toHaveProperty('password');
    expect(dom.posted[0].payload).not.toHaveProperty('keyPath');
    expect(dom.posted[0].payload).not.toHaveProperty('keyPassphrase');
  });

  it('shows only the fields belonging to the selected auth method, on load and on every change', () => {
    const dom = runConnectionFormScript({ nonce: 'n', values: { authMethod: 'password' } });

    expect(dom.fieldsFor('password').every((field) => field.hidden === false)).toBe(true);
    expect(dom.fieldsFor('key').every((field) => field.hidden === true)).toBe(true);

    dom.elements.get('authMethod')!.value = 'key';
    dom.elements.get('authMethod')!.emit('change');

    expect(dom.fieldsFor('password').every((field) => field.hidden === true)).toBe(true);
    expect(dom.fieldsFor('key').every((field) => field.hidden === false)).toBe(true);

    dom.elements.get('authMethod')!.value = 'agent';
    dom.elements.get('authMethod')!.emit('change');

    expect(dom.fieldsFor('password').every((field) => field.hidden === true)).toBe(true);
    expect(dom.fieldsFor('key').every((field) => field.hidden === true)).toBe(true);
  });

  it('includes no id when creating a new connection', () => {
    const dom = runConnectionFormScript({ nonce: 'n', values: { authMethod: 'agent' } });

    dom.elements.get('save')!.emit('click');

    expect(dom.posted[0].payload).not.toHaveProperty('id');
  });

  it('includes the connection id from the host-rendered dataset when editing', () => {
    const dom = runConnectionFormScript({ nonce: 'n', connectionId: 'c1', values: { authMethod: 'agent' } });

    dom.elements.get('save')!.emit('click');

    expect(dom.posted[0].payload).toMatchObject({ id: 'c1' });
  });

  it('asks the host to browse for a key file when the Browse button is clicked', () => {
    const dom = runConnectionFormScript({ nonce: 'browse-nonce', values: { authMethod: 'key' } });

    dom.elements.get('browseKeyPath')!.emit('click');

    expect(dom.posted).toEqual([{ nonce: 'browse-nonce', type: 'browseKeyPath' }]);
  });

  it('fills the key path field when the host replies with a chosen path', () => {
    const dom = runConnectionFormScript({ nonce: 'n', values: { authMethod: 'key', keyPath: '' } });

    dom.emitWindowMessage({ type: 'keyPathSelected', path: '/home/deploy/.ssh/id_ed25519' });

    expect(dom.elements.get('keyPath')!.value).toBe('/home/deploy/.ssh/id_ed25519');
  });

  it('ignores an unrelated message posted to the window', () => {
    const dom = runConnectionFormScript({ nonce: 'n', values: { authMethod: 'key', keyPath: 'unchanged' } });

    dom.emitWindowMessage({ type: 'somethingElse', path: '/should/not/apply' });

    expect(dom.elements.get('keyPath')!.value).toBe('unchanged');
  });

  describe('the remotes sidebar', () => {
    const staging: ConnectionConfig = {
      id: 'c1',
      name: 'staging',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      remotePath: '/var/www',
      authMethod: 'password',
    };
    const prod: ConnectionConfig = {
      id: 'c2',
      name: 'prod',
      host: 'prod.example.com',
      port: 2222,
      username: 'deploy',
      remotePath: '/var/www',
      authMethod: 'agent',
    };

    it('renders one row per saved connection, sorted by name, on load', () => {
      const dom = runConnectionFormScript({ nonce: 'n', connections: [prod, staging] });

      const names = dom.remoteRows().map((row) => row.children[0].children[0].textContent);
      expect(names).toEqual(['prod', 'staging']);
    });

    it('shows a placeholder when there are no saved connections', () => {
      const dom = runConnectionFormScript({ nonce: 'n', connections: [] });

      expect(dom.remoteRows()).toHaveLength(1);
      expect(dom.remoteRows()[0].className).toBe('empty-remotes');
    });

    it('loads a row into the form when clicked, without any host round trip', () => {
      const dom = runConnectionFormScript({ nonce: 'n', connections: [staging] });

      dom.remoteRows()[0].emit('click');

      expect(dom.elements.get('name')!.value).toBe('staging');
      expect(dom.elements.get('host')!.value).toBe('example.com');
      expect(dom.elements.get('port')!.value).toBe('22');
      expect(dom.elements.get('authMethod')!.value).toBe('password');
      expect(dom.elements.get('formHeading')!.textContent).toBe('Edit Connection: staging');
      expect(dom.posted).toEqual([]);
    });

    it('marks the row matching the current connectionId as active', () => {
      const dom = runConnectionFormScript({ nonce: 'n', connectionId: 'c2', connections: [staging, prod] });

      const active = dom.remoteRows().find((row) => row.className.includes('active'));
      expect(active?.children[0].children[0].textContent).toBe('prod');
    });

    it('never pre-fills the password or key passphrase when a row is loaded', () => {
      const dom = runConnectionFormScript({ nonce: 'n', connections: [staging], values: { password: 'leftover' } });

      dom.remoteRows()[0].emit('click');

      expect(dom.elements.get('password')!.value).toBe('');
      expect(dom.elements.get('keyPassphrase')!.value).toBe('');
    });

    it('clears the form to a blank new-connection state when "+ Add" is clicked', () => {
      const dom = runConnectionFormScript({ nonce: 'n', connectionId: 'c1', connections: [staging] });
      dom.remoteRows()[0].emit('click');

      dom.elements.get('addRemote')!.emit('click');
      dom.elements.get('save')!.emit('click');

      expect(dom.elements.get('formHeading')!.textContent).toBe('New Connection');
      expect(dom.elements.get('name')!.value).toBe('');
      expect(dom.elements.get('port')!.value).toBe('22');
      expect(dom.posted[0].payload).not.toHaveProperty('id');
    });

    it('posts deleteConnection with the row id when its delete button is clicked', () => {
      const dom = runConnectionFormScript({ nonce: 'delete-nonce', connections: [staging] });

      const deleteButton = dom.remoteRows()[0].children[1];
      deleteButton.emit('click', { preventDefault: () => {}, stopPropagation: () => {} } as never);

      expect(dom.posted).toEqual([{ nonce: 'delete-nonce', type: 'deleteConnection', payload: { id: 'c1' } }]);
    });

    it('re-renders the sidebar and switches the form to edit mode for a newly saved connection', () => {
      const dom = runConnectionFormScript({ nonce: 'n', connections: [] });

      dom.emitWindowMessage({
        type: 'connectionsUpdated',
        connections: [staging],
        savedId: 'c1',
      });

      expect(dom.remoteRows()).toHaveLength(1);
      expect(dom.elements.get('formHeading')!.textContent).toBe('Edit Connection: staging');
      expect(dom.elements.get('name')!.value).toBe('staging');
    });

    it('clears the form when the connection currently being edited is deleted elsewhere', () => {
      const dom = runConnectionFormScript({ nonce: 'n', connectionId: 'c1', connections: [staging] });

      dom.emitWindowMessage({ type: 'connectionsUpdated', connections: [], deletedId: 'c1' });

      expect(dom.elements.get('formHeading')!.textContent).toBe('New Connection');
      expect(dom.remoteRows()[0].className).toBe('empty-remotes');
    });

    it('only re-renders the list, leaving the form alone, when a different connection was deleted', () => {
      const dom = runConnectionFormScript({ nonce: 'n', connectionId: 'c1', connections: [staging, prod] });
      dom.remoteRows().find((r) => r.children[0].children[0].textContent === 'staging')!.emit('click');

      dom.emitWindowMessage({ type: 'connectionsUpdated', connections: [staging], deletedId: 'c2' });

      expect(dom.elements.get('formHeading')!.textContent).toBe('Edit Connection: staging');
      expect(dom.remoteRows()).toHaveLength(1);
    });
  });
});
