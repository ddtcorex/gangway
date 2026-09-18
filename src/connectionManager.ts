import crypto from 'node:crypto';
import type { ConnectionConfig, ConnectionScope, KeyValueStore } from './types';

const CONNECTIONS_KEY = 'gangway.connections';
const WORKSPACE_BINDING_KEY = 'gangway.workspaceBinding';

/**
 * Global-scope connections live in globalState (visible from every
 * workspace, the historical-only behavior); workspace-scope connections live
 * in workspaceState (VS Code already partitions this per workspace session,
 * so no home-grown workspace-id scheme is needed). Both stores use the same
 * key name -- they are separate Mementos, so there is no collision.
 *
 * The store a record lives in is the single source of truth for its scope:
 * list() always overwrites `scope` from where it read the record, rather
 * than trusting a stored field, so scope can never drift from where the
 * record actually is (and a pre-this-feature globalState record with no
 * `scope` field at all reads back as 'global' for free).
 */
export class ConnectionManager {
  constructor(
    private readonly globalState: KeyValueStore,
    private readonly workspaceState: KeyValueStore,
  ) {}

  private storeFor(scope: ConnectionScope): KeyValueStore {
    return scope === 'workspace' ? this.workspaceState : this.globalState;
  }

  private rawList(store: KeyValueStore): ConnectionConfig[] {
    return store.get<ConnectionConfig[]>(CONNECTIONS_KEY) ?? [];
  }

  private scopeOf(id: string): ConnectionScope | undefined {
    if (this.rawList(this.globalState).some((c) => c.id === id)) return 'global';
    if (this.rawList(this.workspaceState).some((c) => c.id === id)) return 'workspace';
    return undefined;
  }

  list(): ConnectionConfig[] {
    return [
      ...this.rawList(this.globalState).map((c) => ({ ...c, scope: 'global' as const })),
      ...this.rawList(this.workspaceState).map((c) => ({ ...c, scope: 'workspace' as const })),
    ];
  }

  async add(input: Omit<ConnectionConfig, 'id'>): Promise<ConnectionConfig> {
    const scope: ConnectionScope = input.scope ?? 'global';
    const created: ConnectionConfig = { ...input, id: crypto.randomUUID(), scope };
    const store = this.storeFor(scope);
    await store.update(CONNECTIONS_KEY, [...this.rawList(store), created]);
    return created;
  }

  async update(id: string, patch: Partial<Omit<ConnectionConfig, 'id'>>): Promise<ConnectionConfig> {
    const currentScope = this.scopeOf(id);
    if (!currentScope) throw new Error(`No connection with id "${id}"`);
    const nextScope: ConnectionScope = patch.scope ?? currentScope;

    const currentStore = this.storeFor(currentScope);
    const currentList = this.rawList(currentStore);
    const existing = currentList.find((c) => c.id === id);
    if (!existing) throw new Error(`No connection with id "${id}"`);
    const updated: ConnectionConfig = { ...existing, ...patch, scope: nextScope };

    if (nextScope === currentScope) {
      await currentStore.update(
        CONNECTIONS_KEY,
        currentList.map((c) => (c.id === id ? updated : c)),
      );
      return updated;
    }

    // A scope change moves the record between Mementos: remove from the old
    // store first, then add to the new one, so the connection never
    // transiently exists in neither (or, on a partial failure, in both).
    await currentStore.update(
      CONNECTIONS_KEY,
      currentList.filter((c) => c.id !== id),
    );
    const nextStore = this.storeFor(nextScope);
    await nextStore.update(CONNECTIONS_KEY, [...this.rawList(nextStore), updated]);
    return updated;
  }

  async remove(id: string): Promise<void> {
    const scope = this.scopeOf(id);
    if (!scope) return;
    const store = this.storeFor(scope);
    await store.update(
      CONNECTIONS_KEY,
      this.rawList(store).filter((c) => c.id !== id),
    );
  }

  getWorkspaceBinding(): string | undefined {
    return this.workspaceState.get<string>(WORKSPACE_BINDING_KEY);
  }

  async setWorkspaceBinding(connectionId: string | undefined): Promise<void> {
    await this.workspaceState.update(WORKSPACE_BINDING_KEY, connectionId);
  }
}
