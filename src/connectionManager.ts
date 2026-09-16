import crypto from 'node:crypto';
import type { ConnectionConfig, KeyValueStore } from './types';

const CONNECTIONS_KEY = 'gangway.connections';
const WORKSPACE_BINDING_KEY = 'gangway.workspaceBinding';

export class ConnectionManager {
  constructor(
    private readonly globalState: KeyValueStore,
    private readonly workspaceState: KeyValueStore,
  ) {}

  list(): ConnectionConfig[] {
    return this.globalState.get<ConnectionConfig[]>(CONNECTIONS_KEY) ?? [];
  }

  async add(input: Omit<ConnectionConfig, 'id'>): Promise<ConnectionConfig> {
    const created: ConnectionConfig = { ...input, id: crypto.randomUUID() };
    await this.globalState.update(CONNECTIONS_KEY, [...this.list(), created]);
    return created;
  }

  async update(id: string, patch: Partial<Omit<ConnectionConfig, 'id'>>): Promise<ConnectionConfig> {
    const next = this.list().map((c) => (c.id === id ? { ...c, ...patch } : c));
    await this.globalState.update(CONNECTIONS_KEY, next);
    const updated = next.find((c) => c.id === id);
    if (!updated) throw new Error(`No connection with id "${id}"`);
    return updated;
  }

  async remove(id: string): Promise<void> {
    await this.globalState.update(
      CONNECTIONS_KEY,
      this.list().filter((c) => c.id !== id),
    );
  }

  getWorkspaceBinding(): string | undefined {
    return this.workspaceState.get<string>(WORKSPACE_BINDING_KEY);
  }

  async setWorkspaceBinding(connectionId: string | undefined): Promise<void> {
    await this.workspaceState.update(WORKSPACE_BINDING_KEY, connectionId);
  }
}
