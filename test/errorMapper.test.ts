import { describe, it, expect } from 'vitest';
import { mapSftpError, actionLabel, isConnectionError, redactSecrets } from '../src/errorMapper';
import { AuthResolutionError } from '../src/authResolver';

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

  it('passes an AuthResolutionError through verbatim instead of blaming the server', () => {
    // These errors are already written for the user and describe a LOCAL
    // configuration problem. Their text routinely embeds the underlying fs
    // message ("ENOENT: ...", "EACCES: permission denied"), which the generic
    // branches below would otherwise rewrite into a server-side explanation.
    const err = new AuthResolutionError(
      'Cannot read the SSH key file at "/home/user/.ssh/id_ed25519": EACCES: permission denied',
    );

    const mapped = mapSftpError(err);

    expect(mapped.message).toBe(err.message);
    expect(mapped.message).not.toMatch(/on the server/i);
    expect(mapped.message).not.toMatch(/denied by the server/i);
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

  it('maps numeric SFTP status code 3 (PERMISSION_DENIED) even when the message text is barren', () => {
    const err = Object.assign(new Error('fastPut failed'), { code: 3 });
    const mapped = mapSftpError(err);
    expect(mapped.message).toMatch(/permission denied/i);
    expect(mapped.actions).toEqual(['openOutput']);
  });

  it('maps numeric SFTP status code 2 (NO_SUCH_FILE) to the not-exist message with Retry', () => {
    const err = Object.assign(new Error('stat failed'), { code: 2 });
    const mapped = mapSftpError(err);
    expect(mapped.message).toMatch(/does not exist on the server/i);
    expect(mapped.actions).toContain('retry');
  });

  it('leaves other numeric SFTP status codes on the generic path with their message intact', () => {
    const err = Object.assign(new Error('rename failed'), { code: 4 });
    const mapped = mapSftpError(err);
    expect(mapped.message).toContain('rename failed');
    expect(mapped.actions).toEqual(expect.arrayContaining(['retry', 'openOutput']));
  });

  it('redacts embedded credentials before echoing server text to the user', () => {
    const err = new Error('connect failed for sftp://deploy:hunter2@example.com/var/www');
    const mapped = mapSftpError(err);
    expect(mapped.message).not.toContain('hunter2');
    expect(mapped.message).toContain('deploy:***@');
  });
});

describe('isConnectionError', () => {
  it.each(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND'])('treats %s as connection-level', (code) => {
    expect(isConnectionError(Object.assign(new Error('x'), { code }))).toBe(true);
  });

  it('treats numeric SFTP NO_CONNECTION/CONNECTION_LOST as connection-level', () => {
    expect(isConnectionError(Object.assign(new Error('x'), { code: 6 }))).toBe(true);
    expect(isConnectionError(Object.assign(new Error('x'), { code: 7 }))).toBe(true);
  });

  it('does not treat application errors as connection-level', () => {
    expect(isConnectionError(Object.assign(new Error('no such file'), { code: 'ENOENT' }))).toBe(false);
    expect(isConnectionError(new Error('Permission denied'))).toBe(false);
    expect(isConnectionError(Object.assign(new Error('rename failed'), { code: 4 }))).toBe(false);
  });
});

describe('redactSecrets', () => {
  it('masks userinfo passwords in URLs', () => {
    expect(redactSecrets('open sftp://deploy:hunter2@example.com/x')).toBe('open sftp://deploy:***@example.com/x');
  });

  it('masks password assignments', () => {
    expect(redactSecrets('save failed: password=hunter2')).toBe('save failed: password: ***');
  });

  it('leaves ordinary messages untouched', () => {
    expect(redactSecrets('Permission denied by the server')).toBe('Permission denied by the server');
  });
});
