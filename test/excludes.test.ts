import { describe, it, expect } from 'vitest';
import { effectiveExcludes, matchesExcludes } from '../src/excludes';
import { DEFAULT_EXCLUDES } from '../src/remoteOps';

describe('matchesExcludes', () => {
  it('excludes nested node_modules but never an explicitly picked file', () => {
    expect(matchesExcludes('node_modules/x.js', ['node_modules/**'])).toBe(true);
    expect(matchesExcludes('node_modules', ['node_modules/**'])).toBe(true);
    expect(matchesExcludes('a.php', ['node_modules/**'])).toBe(false);
    expect(matchesExcludes('src/var/x.php', ['var/**'])).toBe(false);
    expect(matchesExcludes('var/cache/x.php', ['var/**'])).toBe(true);
  });

  it('supports exact names, star segments, and ? wildcards', () => {
    expect(matchesExcludes('.git/config', ['.git/**'])).toBe(true);
    expect(matchesExcludes('dist/bundle.js', ['dist/*.js'])).toBe(true);
    expect(matchesExcludes('dist/sub/bundle.js', ['dist/*.js'])).toBe(false);
    expect(matchesExcludes('a.php', ['?.php'])).toBe(true);
    expect(matchesExcludes('ab.php', ['?.php'])).toBe(false);
  });
});

describe('effectiveExcludes', () => {
  it('falls back to DEFAULT_EXCLUDES when the connection sets none', () => {
    expect(effectiveExcludes({} as never)).toEqual(DEFAULT_EXCLUDES);
    expect(effectiveExcludes({ excludePatterns: ['dist/**'] } as never)).toEqual(['dist/**']);
  });
});
