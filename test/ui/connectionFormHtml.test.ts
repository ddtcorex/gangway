import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildConnectionFormHtml, resolveConnectionFormFields, toConnectionsJson } from '../../src/ui/connectionFormHtml';

/** Strips HTML comments and collapses whitespace, so the two hand-synced
 * copies of the form markup can be compared for real structural drift
 * without their differing explanatory comments counting as a difference. */
function normalizeMarkup(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const IDENTITY_FIELDS = {
  heading: '{{HEADING}}',
  connectionId: '{{CONNECTION_ID}}',
  name: '{{NAME}}',
  host: '{{HOST}}',
  port: '{{PORT}}',
  username: '{{USERNAME}}',
  remotePath: '{{REMOTE_PATH}}',
  keyPath: '{{KEY_PATH}}',
  passwordSelected: '{{PASSWORD_SELECTED}}',
  keySelected: '{{KEY_SELECTED}}',
  agentSelected: '{{AGENT_SELECTED}}',
  passwordHint: '{{PASSWORD_BLANK_HINT}}',
  passphraseHint: '{{PASSPHRASE_BLANK_HINT}}',
  connectionsJson: '{{CONNECTIONS_JSON}}',
};

describe('buildConnectionFormHtml', () => {
  it('never references an external domain, only the nonce-scoped local script and the given webview URIs', () => {
    const html = buildConnectionFormHtml({
      toolkitUri: 'vscode-webview-resource://abc/media/connectionForm/toolkit.min.js',
      mainScriptUri: 'vscode-webview-resource://abc/media/connectionForm/main.js',
      cspSource: 'vscode-webview://abc',
      nonce: 'test-nonce-123',
      ...IDENTITY_FIELDS,
    });

    expect(html).toContain('vscode-webview-resource://abc/media/connectionForm/toolkit.min.js');
    expect(html).toContain('vscode-webview-resource://abc/media/connectionForm/main.js');
    expect(html).toContain('nonce="test-nonce-123"');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('sets a strict CSP that only allows the nonce-scoped scripts/styles and the given cspSource for styles', () => {
    const html = buildConnectionFormHtml({
      toolkitUri: 'vscode-webview-resource://abc/media/connectionForm/toolkit.min.js',
      mainScriptUri: 'vscode-webview-resource://abc/media/connectionForm/main.js',
      cspSource: 'vscode-webview://abc',
      nonce: 'test-nonce-123',
      ...IDENTITY_FIELDS,
    });
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-test-nonce-123'");
    expect(html).toContain("style-src vscode-webview://abc 'nonce-test-nonce-123'");
  });

  it('exposes the nonce on <body data-nonce>, the only place a module script can reliably read it', () => {
    // main.js used to read document.currentScript.nonce, which is always null
    // in a `<script type="module">` -- the read threw and the whole webview
    // script died before attaching the Save handler. The nonce must therefore
    // live somewhere the DOM exposes unconditionally.
    const html = buildConnectionFormHtml({
      toolkitUri: 'vscode-webview-resource://abc/toolkit.min.js',
      mainScriptUri: 'vscode-webview-resource://abc/main.js',
      cspSource: 'vscode-webview://abc',
      nonce: 'test-nonce-123',
      ...IDENTITY_FIELDS,
    });

    expect(html).toContain('<body data-nonce="test-nonce-123" data-connection-id="{{CONNECTION_ID}}">');
  });

  it('keeps the inlined TEMPLATE and the reference index.html copy structurally identical', () => {
    // These two are hand-synced by convention (the template string is what
    // actually ships; index.html is the readable reference copy). A field
    // added to one and forgotten in the other is exactly the kind of silent
    // drift that let the form ship without password/key inputs. Every field
    // here is a literal, unconditional substitution (see
    // resolveConnectionFormFields for the add-vs-edit-mode logic that feeds
    // real values in at runtime), so passing each token's own name back in
    // as its value is a no-op and the rendered output must equal the raw
    // reference file byte-for-byte (after whitespace/comment normalization).
    const referencePath = path.resolve(__dirname, '../../src/ui/media/connectionForm/index.html');
    const reference = fs.readFileSync(referencePath, 'utf8');
    const template = buildConnectionFormHtml({
      toolkitUri: '{{TOOLKIT_URI}}',
      mainScriptUri: '{{MAIN_URI}}',
      cspSource: '{{CSP_SOURCE}}',
      nonce: '{{NONCE}}',
      ...IDENTITY_FIELDS,
    });

    expect(normalizeMarkup(template)).toBe(normalizeMarkup(reference));
  });
});

describe('resolveConnectionFormFields', () => {
  it('defaults to a fresh, empty "New Connection" form with no existing connection', () => {
    const fields = resolveConnectionFormFields();

    expect(fields.heading).toBe('New Connection');
    expect(fields.connectionId).toBe('');
    expect(fields.name).toBe('');
    expect(fields.port).toBe('22');
    expect(fields.passwordSelected).toBe(' selected');
    expect(fields.keySelected).toBe('');
    expect(fields.agentSelected).toBe('');
    expect(fields.passwordHint).toBe('');
    expect(fields.passphraseHint).toBe('');
  });

  it('pre-fills every field and marks the stored auth method selected when editing', () => {
    const fields = resolveConnectionFormFields({
      id: 'c1',
      name: 'staging',
      host: 'example.com',
      port: 2222,
      username: 'deploy',
      remotePath: '/var/www',
      authMethod: 'key',
      keyPath: '/home/deploy/.ssh/id_ed25519',
    });

    expect(fields.heading).toBe('Edit Connection: staging');
    expect(fields.connectionId).toBe('c1');
    expect(fields.name).toBe('staging');
    expect(fields.host).toBe('example.com');
    expect(fields.port).toBe('2222');
    expect(fields.username).toBe('deploy');
    expect(fields.remotePath).toBe('/var/www');
    expect(fields.keyPath).toBe('/home/deploy/.ssh/id_ed25519');
    expect(fields.keySelected).toBe(' selected');
    expect(fields.passwordSelected).toBe('');
    expect(fields.agentSelected).toBe('');
    expect(fields.passwordHint).toBe(' (leave blank to keep the current one)');
    expect(fields.passphraseHint).toBe(' (leave blank to keep the current one)');
  });

  it('escapes HTML-significant characters in user-supplied fields', () => {
    const fields = resolveConnectionFormFields({
      id: 'c1',
      name: '<script>alert(1)</script>',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      remotePath: '/var/www',
      authMethod: 'password',
    });

    expect(fields.heading).not.toContain('<script>');
    expect(fields.name).not.toContain('<script>');
  });
});

describe('toConnectionsJson', () => {
  it('serializes the connections list as parseable JSON', () => {
    const json = toConnectionsJson([
      { id: 'c1', name: 'staging', host: 'example.com', port: 22, username: 'deploy', remotePath: '/var/www', authMethod: 'password' },
    ]);

    expect(JSON.parse(json)).toEqual([
      { id: 'c1', name: 'staging', host: 'example.com', port: 22, username: 'deploy', remotePath: '/var/www', authMethod: 'password' },
    ]);
  });

  it('escapes "<" so a connection name containing </script> can never break out of the embedding script tag', () => {
    const json = toConnectionsJson([
      { id: 'c1', name: '</script><script>alert(1)</script>', host: 'x', port: 22, username: 'x', remotePath: '/', authMethod: 'agent' },
    ]);

    expect(json).not.toContain('</script>');
    expect(JSON.parse(json)[0].name).toBe('</script><script>alert(1)</script>');
  });
});
