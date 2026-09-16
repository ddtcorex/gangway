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
      const privateKey = await readFile(connection.keyPath);
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
