import fs from 'node:fs/promises';
import { assertNever } from './types';
import type { ConnectionConfig } from './types';
import type { ConnectionSecretStore } from './secretStore';
import { withTimeout } from './withTimeout';

export class AuthResolutionError extends Error {}

/**
 * The OS secret store is an external system service (keyring/keychain) that
 * can be locked, unavailable, or unresponsive independently of anything this
 * extension does. Discovered against a real Extension Development Host: an
 * unresponsive secrets.get() left a connection attempt hanging forever, with
 * no error and nothing for the caller (the Gangway tree's root listing, in
 * particular) to catch -- every unit test's fake secret store always
 * resolves instantly, so this never surfaced there. Bounding the read turns
 * that silent hang into the same AuthResolutionError a genuinely missing
 * secret already produces, which the rest of the extension already knows
 * how to show the user.
 */
const SECRET_READ_TIMEOUT_MS = 5_000;

async function readSecretWithTimeout(
  secrets: ConnectionSecretStore,
  connectionId: string,
  key: 'password' | 'keyPassphrase',
  connectionName: string,
): Promise<string | undefined> {
  try {
    return await withTimeout(secrets.get(connectionId, key), SECRET_READ_TIMEOUT_MS, 'timed out reading from the system secret store');
  } catch (err) {
    throw new AuthResolutionError(
      `Could not read the stored ${key === 'password' ? 'password' : 'key passphrase'} for connection "${connectionName}": ` +
        `${err instanceof Error ? err.message : String(err)}. This is a local secret-store problem, not a server error.`,
    );
  }
}

export interface ConnectOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: Buffer;
  passphrase?: string;
  agent?: string;
}

type ReadFile = (path: string) => Promise<Buffer>;

export async function resolveConnectOptions(
  connection: ConnectionConfig,
  secrets: ConnectionSecretStore,
  readFile: ReadFile = (path) => fs.readFile(path),
): Promise<ConnectOptions> {
  const shared = { host: connection.host, port: connection.port, username: connection.username };

  switch (connection.authMethod) {
    case 'password': {
      const password = await readSecretWithTimeout(secrets, connection.id, 'password', connection.name);
      if (!password) {
        throw new AuthResolutionError(
          `No password stored for connection "${connection.name}". Open the connection form and re-enter the password.`,
        );
      }
      return { ...shared, password };
    }
    case 'key': {
      if (!connection.keyPath) {
        throw new AuthResolutionError(
          `No key path configured for connection "${connection.name}". Open the connection form and set the SSH key path.`,
        );
      }
      // A raw Node fs error here used to propagate untouched all the way to
      // extension.ts's generic mapSftpError(), whose ENOENT branch tells the
      // user "The requested path does not exist on the server" -- badly
      // misleading for what is actually a stale or unreadable key path on
      // this machine. This is the only place that knows the failed read was a
      // key file, so this is where it gets named.
      let privateKey: Buffer;
      try {
        privateKey = await readFile(connection.keyPath);
      } catch (err) {
        throw new AuthResolutionError(
          `Cannot read the SSH key file at "${connection.keyPath}" for connection "${connection.name}": ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            'This is a local key-path problem, not a server error: fix the path in the connection form.',
        );
      }
      const passphrase = await readSecretWithTimeout(secrets, connection.id, 'keyPassphrase', connection.name);
      return { ...shared, privateKey, ...(passphrase ? { passphrase } : {}) };
    }
    case 'agent': {
      const agent = process.env.SSH_AUTH_SOCK;
      if (!agent) {
        throw new AuthResolutionError(
          `No SSH agent detected (SSH_AUTH_SOCK is not set) for connection "${connection.name}".`,
        );
      }
      return { ...shared, agent };
    }
    default:
      return assertNever(connection.authMethod);
  }
}
