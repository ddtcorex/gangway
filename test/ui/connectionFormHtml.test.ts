import { describe, it, expect } from 'vitest';
import { buildConnectionFormHtml } from '../../src/ui/connectionFormHtml';

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
});
