import { describe, expect, it } from 'vitest';
import { isLexicallyInside, isNotFoundError } from '../src/remotePathUtils';
import * as remoteOps from '../src/remoteOps';

describe('remotePathUtils', () => {
  it('isLexicallyInside accepts the root and descendants, rejects escapes and siblings', () => {
    expect(isLexicallyInside('/srv/app', '/srv/app')).toBe(true);
    expect(isLexicallyInside('/srv/app', '/srv/app/a/b.php')).toBe(true);
    expect(isLexicallyInside('/srv/app', '/srv/app/../other')).toBe(false);
    expect(isLexicallyInside('/srv/app', '/srv/application/x')).toBe(false);
    expect(isLexicallyInside('/srv/app', '/srv')).toBe(false);
  });

  it('isNotFoundError recognises both error dialects and nothing else', () => {
    expect(isNotFoundError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(true);
    expect(isNotFoundError(Object.assign(new Error('x'), { code: 2 }))).toBe(true);
    expect(isNotFoundError(new Error('_stat: No such file: /a'))).toBe(true);
    expect(isNotFoundError(new Error('Connection lost'))).toBe(false);
    expect(isNotFoundError(Object.assign(new Error('Permission denied'), { code: '3' }))).toBe(false);
  });

  it('remoteOps still re-exports both helpers', () => {
    expect(remoteOps.isLexicallyInside).toBe(isLexicallyInside);
    expect(remoteOps.isNotFoundError).toBe(isNotFoundError);
  });
});
