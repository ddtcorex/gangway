import { describe, it, expect } from 'vitest';
import { mapSftpError, actionLabel } from '../src/errorMapper';

describe('actionLabel', () => {
  it('never returns the raw action token as its own label', () => {
    expect(actionLabel('retry')).toBe('Retry');
    expect(actionLabel('openOutput')).toBe('Open Output');
    expect(actionLabel('disconnect')).toBe('Disconnect');
  });
});

describe('mapSftpError', () => {
  it('maps ENOENT to a human message with a Retry action', () => {
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    const mapped = mapSftpError(err);
    expect(mapped.message).toMatch(/does not exist on the server/i);
    expect(mapped.actions).toContain('retry');
  });

  it('maps ECONNRESET to a human message with Retry and Disconnect actions', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const mapped = mapSftpError(err);
    expect(mapped.message).toMatch(/connection was reset/i);
    expect(mapped.actions).toEqual(expect.arrayContaining(['retry', 'disconnect']));
  });

  it('maps a permission-denied message to a human message with Open Output action, no Retry', () => {
    const err = new Error('Permission denied (4xx)');
    const mapped = mapSftpError(err);
    expect(mapped.message).toMatch(/permission denied/i);
    expect(mapped.actions).toEqual(['openOutput']);
  });

  it('falls back to the raw message with Retry and Open Output for anything unrecognized', () => {
    const err = new Error('something exotic happened');
    const mapped = mapSftpError(err);
    expect(mapped.message).toContain('something exotic happened');
    expect(mapped.actions).toEqual(expect.arrayContaining(['retry', 'openOutput']));
  });

  it('does not misclassify incidental 3-digit numbers as permission-denied', () => {
    const err = new Error('Failed to connect: timeout after 400ms');
    const mapped = mapSftpError(err);
    expect(mapped.message).toContain('Failed to connect: timeout after 400ms');
    expect(mapped.actions).toEqual(['retry', 'openOutput']);
  });

  it('correctly identifies real 4xx permission-denied codes with word boundaries', () => {
    const err = new Error('SFTP error: 403 Forbidden');
    const mapped = mapSftpError(err);
    expect(mapped.message).toMatch(/permission denied/i);
    expect(mapped.actions).toEqual(['openOutput']);
  });
});
