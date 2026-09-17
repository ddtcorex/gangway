import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildConnectionFormHtml } from '../../src/ui/connectionFormHtml';

/** Strips HTML comments and collapses whitespace, so the two hand-synced
 * copies of the form markup can be compared for real structural drift
 * without their differing explanatory comments counting as a difference. */
function normalizeMarkup(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('buildConnectionFormHtml', () => {
  it('never references an external domain, only the nonce-scoped local script and the given webview URIs', () => {
    const html = buildConnectionFormHtml({
      toolkitUri: 'vscode-webview-resource://abc/media/connectionForm/toolkit.min.js',
      mainScriptUri: 'vscode-webview-resource://abc/media/connectionForm/main.js',
      cspSource: 'vscode-webview://abc',
      nonce: 'test-nonce-123',
    });

    expect(html).toContain('vscode-webview-resource://abc/media/connectionForm/toolkit.min.js');
    expect(html).toContain('vscode-webview-resource://abc/media/connectionForm/main.js');
    expect(html).toContain('nonce="test-nonce-123"');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('sets a strict CSP that only allows the nonce-scoped scripts and the given cspSource for styles', () => {
    const html = buildConnectionFormHtml({
      toolkitUri: 'vscode-webview-resource://abc/media/connectionForm/toolkit.min.js',
      mainScriptUri: 'vscode-webview-resource://abc/media/connectionForm/main.js',
      cspSource: 'vscode-webview://abc',
      nonce: 'test-nonce-123',
    });
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-test-nonce-123'");
    expect(html).toContain('style-src vscode-webview://abc');
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
    });

    expect(html).toContain('<body data-nonce="test-nonce-123">');
  });

  it('keeps the inlined TEMPLATE and the reference index.html copy structurally identical', () => {
    // These two are hand-synced by convention (the template string is what
    // actually ships; index.html is the readable reference copy). A field
    // added to one and forgotten in the other is exactly the kind of silent
    // drift that let the form ship without password/key inputs.
    const referencePath = path.resolve(__dirname, '../../src/ui/media/connectionForm/index.html');
    const reference = fs.readFileSync(referencePath, 'utf8');
    const template = buildConnectionFormHtml({
      toolkitUri: '{{TOOLKIT_URI}}',
      mainScriptUri: '{{MAIN_URI}}',
      cspSource: '{{CSP_SOURCE}}',
      nonce: '{{NONCE}}',
    });

    expect(normalizeMarkup(template)).toBe(normalizeMarkup(reference));
  });
});
