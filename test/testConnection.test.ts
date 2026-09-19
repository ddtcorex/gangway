import { describe, it, expect, vi } from 'vitest';
import { testConnection } from '../src/testConnection';

function throwingDeps(error: unknown) {
  return {
    createClient: () => {
      throw error;
    },
    hostKeyStore: { verify: () => 'match' as const },
    prompt: { confirmNewOrChangedKey: async () => 'accept' as const },
    readFile: async () => Buffer.from(''),
  };
}

const draft = { host: 'h', port: 22, username: 'u', authMethod: 'password' as const, password: 'x' };

describe('testConnection classification', () => {
  it('classifies a wrong password without leaking it', async () => {
    const result = await testConnection(
      throwingDeps(
        Object.assign(new Error('All configured authentication methods failed for hunter2-canary'), {}),
      ) as never,
      { ...draft, password: 'hunter2-canary' },
    );
    expect(result).toMatchObject({ ok: false, kind: 'auth-failed' });
    expect(JSON.stringify(result)).not.toContain('hunter2-canary');
  });

  it('reports keyboard-interactive before generic auth failure', async () => {
    const result = await testConnection(
      throwingDeps(new Error('Cannot parse keyboard-interactive prompt')) as never,
      draft,
    );
    expect(result).toMatchObject({ ok: false, kind: 'unsupported-auth' });
  });

  it('reports unreachable hosts distinctly', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:22'), { code: 'ECONNREFUSED' });
    const result = await testConnection(throwingDeps(refused) as never, draft);
    expect(result).toMatchObject({ ok: false, kind: 'unreachable' });
  });

  it('reports success with the host fingerprint', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const end = vi.fn().mockResolvedValue(undefined);
    const deps = {
      createClient: () => ({ connect, end }),
      hostKeyStore: { verify: () => 'match' as const },
      prompt: { confirmNewOrChangedKey: async () => 'accept' as const },
      readFile: async () => Buffer.from(''),
    };
    const result = await testConnection(deps as never, draft);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true });
  });
});

describe('testConnection secret hygiene', () => {
  it('never leaks the draft password through classification or replies', async () => {
    const CANARY = 'hunter2-canary-draft';
    const failing = await testConnection(
      {
        createClient: () => {
          throw new Error(`All configured authentication methods failed for ${CANARY}`);
        },
        hostKeyStore: { verify: () => 'match' as const },
        prompt: { confirmNewOrChangedKey: async () => 'accept' as const },
        readFile: async () => Buffer.from(''),
      } as never,
      { host: 'h', port: 22, username: 'u', authMethod: 'password' as const, password: CANARY },
    );
    expect(JSON.stringify(failing)).not.toContain(CANARY);
  });
});
