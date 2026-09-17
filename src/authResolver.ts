import fs from 'node:fs/promises';
import { assertNever } from './types';
import type { ConnectionConfig } from './types';
import type { ConnectionSecretStore } from './secretStore';

export class AuthResolutionError extends Error {}

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
      const password = await secrets.get(connection.id, 'password');
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
      const passphrase = await secrets.get(connection.id, 'keyPassphrase');
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
