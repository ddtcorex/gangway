import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

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

interface FakeElement {
  id: string;
  value: string;
  hidden: boolean;
  dataset: Record<string, string>;
  addEventListener(type: string, listener: (event: FakeEvent) => void): void;
  /** Test-only: fires whatever listeners the script attached for `type`. */
  emit(type: string, event?: FakeEvent): void;
}

interface FakeEvent {
  defaultPrevented?: boolean;
  preventDefault(): void;
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
}

function makeElement(id: string, value = '', dataset: Record<string, string> = {}): FakeElement {
  const listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  return {
    id,
    value,
    hidden: false,
    dataset,
    addEventListener(type, listener) {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
    emit(type, event) {
      for (const listener of listeners.get(type) ?? []) {
        listener(event ?? { preventDefault: () => {} });
      }
    },
  };
}

/**
 * Builds the fake DOM, runs the real main.js inside a fresh vm context, and
 * hands back the handles a test needs. Deliberately a *minimal* stand-in: it
 * exposes only `document.body.dataset`, `getElementById`, `querySelectorAll`
 * and `acquireVsCodeApi`, so any script that reaches for something else
 * (`document.currentScript`, for one) fails loudly here instead of silently
 * in a real webview where nobody sees the console.
 */
function runConnectionFormScript(options: {
  nonce: string;
  connectionId?: string;
  values?: Record<string, string>;
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
  ];
  const elements = new Map<string, FakeElement>();
  for (const id of ids) elements.set(id, makeElement(id, values[id] ?? ''));

  const authFields: FakeElement[] = [
    makeElement('wrap-password', '', { authField: 'password' }),
    makeElement('wrap-keyPath', '', { authField: 'key' }),
    makeElement('wrap-keyPassphrase', '', { authField: 'key' }),
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
});
