import * as vscode from 'vscode';
import path from 'node:path';
import Client from 'ssh2-sftp-client';
import { ConnectionManager } from './connectionManager';
import { ConnectionSecretStore } from './secretStore';
import { HostKeyStore } from './hostKeyStore';
import { ConnectionPool } from './transfer/connectionPool';
import { downloadFile } from './transfer/downloadFile';
import { uploadFile } from './transfer/uploadFile';
import { AuditLog } from './auditLog';
import { checkConflict } from './conflictGuard';
import { readSidecar } from './tmpStore';
import { purgeExpiredTmp, sweepUnknownTmpRoots } from './tmpRetention';
import { tmpFilePathFor, tmpRootFor, connectionSlug } from './tmpPath';
import { mapSftpError, actionLabel, isConnectionError } from './errorMapper';
import { mapListingToEntries } from './remoteListing';
import { GangwayTreeProvider, isSelectorNode, type RemoteTreeNode, type GangwayTreeNode } from './ui/gangwayTreeProvider';
import { TmpStatusBar } from './ui/statusBar';
import { AUTO_OPEN_PROMPT_THRESHOLD_BYTES, isProbablyBinary } from './folderQueue';
import { DirtyDecorationProvider } from './ui/dirtyDecoration';
import { buildConnectionFormHtml, resolveConnectionFormFields, toConnectionsJson } from './ui/connectionFormHtml';
import { ConnectionFormPanel } from './ui/connectionFormPanel';
import { SftpClientAdapter, type RawSftpClient } from './transfer/sftpClientAdapter';
import { runFolderDownload, runFolderUpload } from './ui/folderTransferCommands';
import { parseGovardYaml, mapGovardRemote, filterNewRemotes, type MappedRemote, type GovardConfig } from './govardImport';
import { raceWithCancellation } from './ui/cancellable';
import { TransferCancelledError } from './folderQueue';
import { resolveFileConflict, type ConflictResolutionUi } from './ui/conflictResolution';
import { checkEditSession, acquireEditSession, releaseEditSession } from './editSession';
import {
  FrozenError,
  assertMutatingAllowed,
  backupRootsFor,
  chmodRemote,
  collectDropUploads,
  createRemote,
  duplicateRemote,
  emptyTrash,
  guardUploadTarget,
  inventoryTrash,
  moveToTrash,
  parseUriList,
  pasteEntries,
  renameRemote,
  restoreEntries,
  sweepOldRemoteDirs,
  trashRootsFor,
  typedConfirmMatches,
} from './remoteOps';
import { clearClipboard, copyToClipboard, cutToClipboard, type ClipboardState } from './ui/treeClipboard';
import type { FileConflictDecision } from './conflictGuard';
import type { ConnectionConfig } from './types';

export function activate(context: vscode.ExtensionContext): { connectionManager: ConnectionManager; secrets: ConnectionSecretStore } {
  const connectionManager = new ConnectionManager(context.globalState, context.workspaceState);
  const secrets = new ConnectionSecretStore(context.secrets);
  const hostKeyStore = new HostKeyStore(context.globalState);
  const output = vscode.window.createOutputChannel('Gangway');

  /**
   * `globalStorageUri` is the per-extension directory VS Code guarantees is
   * writable, so the audit trail always has somewhere real to live. The
   * previous scheme read a `gangway.auditLogPath` globalState key that
   * nothing in the product ever wrote, so it always fell back to `.` -- the
   * extension host's process cwd, which is neither configurable, predictable,
   * nor guaranteed writable (a real E2E run dropped the log in the repo root).
   */
  const auditLog = new AuditLog(path.join(context.globalStorageUri.fsPath, 'sftp-hotfix-uploads.log'));

  const pool = new ConnectionPool(
    { create: () => new Client() as never },
    hostKeyStore,
    { confirmNewOrChangedKey: async (host, port, fingerprint, isChange) => {
        const choice = await vscode.window.showWarningMessage(
          isChange
            ? `Host key for ${host}:${port} changed to ${fingerprint}. Trust it?`
            : `First connection to ${host}:${port}. Trust host key ${fingerprint}?`,
          'Trust',
          'Cancel',
        );
        return choice === 'Trust' ? 'accept' : 'reject';
      },
    },
    secrets,
  );

  /**
   * Resolved fresh on every command invocation, never cached at activate()
   * time: a brand-new user has no connection yet when the extension boots,
   * creates one later via gangway.manageRemotes, and the download/upload
   * keybindings must work in that same session without a window reload.
   */
  function getActiveConnection() {
    const activeConnectionId = connectionManager.getWorkspaceBinding();
    return connectionManager.list().find((c) => c.id === activeConnectionId);
  }

  function requireActiveConnection(): ReturnType<typeof getActiveConnection> {
    const connection = getActiveConnection();
    if (!connection) {
      void vscode.window.showWarningMessage(
        'No SFTP connection is bound to this workspace yet. Run "Gangway: Open Connection Form" first.',
      );
    }
    return connection;
  }

  /**
   * A tree node (file/folder, or a folder command invoked from one) always
   * names its own connection: resolve THAT one, never the workspace binding,
   * so browsing or acting on a connection other than the bound one can never
   * silently operate against the wrong server. Only a keybinding invocation
   * -- which has no tree node to read a connectionId from -- falls back to
   * the single bound connection.
   */
  function resolveConnection(node?: RemoteTreeNode): ConnectionConfig | undefined {
    if (!node) return requireActiveConnection();
    const connection = connectionManager.list().find((c) => c.id === node.connectionId);
    if (!connection) {
      void vscode.window.showErrorMessage(`Gangway: no saved connection matches this item anymore (id ${node.connectionId}).`);
    }
    return connection;
  }

  /**
   * The one place the pooled client (typed only as the minimal
   * `SftpClientLike` connect/end pair) gets cast back to the real
   * `ssh2-sftp-client` shape and wrapped in `SftpClientAdapter`, which
   * translates the real client's `modifyTime` field to the `mtime` that
   * `RemoteStat`/`checkConflict` expect. Every command below goes through
   * this instead of casting ad-hoc at each call site.
   */
  async function getAdapter(connection: ConnectionConfig): Promise<SftpClientAdapter> {
    // A cache hit (the common case: a command right after a download, or
    // any second command against the same connection) resolves getClient()
    // in the same tick. Wrapping that in withProgress used to still flash a
    // "connecting..." notification alongside whatever progress the command
    // itself shows next (e.g. "uploading...") -- two notifications for one
    // action. Skip the wrapper entirely when there is nothing to wait for.
    if (pool.hasClient(connection.id)) {
      const client = await pool.getClient(connection);
      return new SftpClientAdapter(client as unknown as RawSftpClient);
    }
    // A black-holed host can otherwise block a single-file command for ~6
    // minutes (3 x 120s readyTimeout + backoff) behind a frozen UI. The
    // progress is cancellable; cancelling drops the wait, not the pool --
    // an in-flight handshake that later succeeds still lands a healthy
    // client, and a Retry reconnects through the same path.
    const client = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Gangway: connecting to ${connection.host}`,
        cancellable: true,
      },
      (_progress, token) =>
        raceWithCancellation(pool.getClient(connection), token, () => pool.invalidate(connection.id)),
    );
    const adapter = new SftpClientAdapter(client as unknown as RawSftpClient);
    // Trash/backup retention is lazy, not boot-time: the first successful
    // connect per connection sweeps expired trash/backup entries once per
    // session. A boot-time sweep would SSH on startup, which this extension
    // never does unasked.
    void sweepTrashFor(connection, adapter);
    return adapter;
  };

  const sweptTrashRoots = new Set<string>();

  /** Trash + backup retention: 30 days, swept lazily on first connect (see getAdapter). */
  const TRASH_BACKUP_RETENTION_MS = 30 * 24 * 3600 * 1000;

  async function sweepTrashFor(connection: ConnectionConfig, adapter: SftpClientAdapter): Promise<void> {
    if (sweptTrashRoots.has(connection.id)) return;
    sweptTrashRoots.add(connection.id);
    const roots = [
      trashRootsFor(connection).dir,
      `${connection.remotePath}/.trash-gangway`,
      backupRootsFor(connection).dir,
      `${connection.remotePath}/.backup-gangway`,
    ];
    for (const root of roots) {
      try {
        await sweepOldRemoteDirs(adapter, root, TRASH_BACKUP_RETENTION_MS);
      } catch {
        // Best-effort: a later command retries the sweep the same way.
      }
    }
  }

  /**
   * A listing entry the server sent that could not be turned into a safe
   * local path (see remoteListing.ts). Skipped rather than trusted, and
   * recorded so a genuinely odd server is diagnosable instead of silent.
   */
  function reportUnsafeListingName(name: string): void {
    output.appendLine(`Skipped a server listing entry with an unsafe name: ${JSON.stringify(name)}`);
  }

  /**
   * The native half of the Conflict Guard: the built-in diff editor plus a
   * three-way choice matching `FileConflictDecision`. Kept here (and injected
   * into `resolveFileConflict`) so the decision flow itself stays testable
   * outside a VS Code extension host, matching how every other module in this
   * extension takes its collaborators.
   */
  const conflictUi: ConflictResolutionUi = {
    showDiff: async (localPath, serverCopyPath, title) => {
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(localPath),
        vscode.Uri.file(serverCopyPath),
        title,
      );
    },
    askDecision: async (remotePath): Promise<FileConflictDecision> => {
      // Keep the phrase "changed on the server" in this copy: the E2E suite
      // recognises the conflict prompt by it.
      const choice = await vscode.window.showWarningMessage(
        `${remotePath} changed on the server since it was downloaded. Review the diff, then choose what to do.`,
        'Overwrite server',
        'Keep server',
        'Cancel',
      );
      if (choice === 'Overwrite server') return 'overwrite';
      if (choice === 'Keep server') return 'keepServer';
      // A dismissed notification (undefined) must never mean "push anyway".
      return 'cancel';
    },
  };

  /**
   * The single funnel for every command's catch block. Previously each site
   * rendered the mapped actions and discarded the user's choice, so Retry /
   * Open Output / Disconnect were buttons that did nothing. Now:
   *   - a connection-level failure first invalidates the pooled client, so a
   *     Retry reconnects instead of reusing the dead socket;
   *   - only the actions the call site can actually honor are shown (no
   *     Retry without a retry closure, no Disconnect without a connection),
   *     so a rendered button can never be dead by construction;
   *   - Retry re-invokes the command; anything else (including dismissing
   *     the notification) stops -- retries never chain on their own.
   */
  async function showCommandError(
    err: unknown,
    options: { retry?: () => Promise<void>; connection?: ConnectionConfig } = {},
  ): Promise<void> {
    const { retry, connection } = options;
    // A cancellation is the user answering "stop", not a failure: report it
    // plainly with no Retry buttons (which would just re-ask the question).
    if (err instanceof TransferCancelledError) {
      await vscode.window.showInformationMessage('Cancelled.');
      return;
    }
    if (connection && isConnectionError(err)) pool.invalidate(connection.id);
    const mapped = mapSftpError(err);
    const available = mapped.actions.filter((action) =>
      action === 'retry' ? retry !== undefined : action === 'disconnect' ? connection !== undefined : true,
    );
    if (available.length === 0) {
      await vscode.window.showErrorMessage(mapped.message);
      return;
    }
    const choice = await vscode.window.showErrorMessage(mapped.message, ...available.map(actionLabel));
    const picked = mapped.actions.find((action) => actionLabel(action) === choice);
    if (picked === 'openOutput') output.show();
    else if (picked === 'disconnect' && connection) pool.invalidate(connection.id);
    else if (picked === 'retry' && retry) await retry();
  }

  /**
   * Opens a downloaded tmp file for editing, unless another still-running
   * Gangway session (another VS Code window, on this machine) already has
   * it open -- editing the same deterministic local path in two windows at
   * once means whichever uploads last silently wins over the other's
   * changes. The user decides whether to open here anyway; either way the
   * file was already downloaded/refreshed by the caller before this runs.
   */
  async function openForEditing(localPath: string): Promise<void> {
    const check = await checkEditSession(localPath);
    if (check.status === 'ownedByAnotherLiveSession') {
      const startedAt = new Date(check.owner.startedAt).toLocaleTimeString();
      const choice = await vscode.window.showWarningMessage(
        `This file is already open for editing in another Gangway session (started at ${startedAt}). ` +
          'Editing it here too can cause one session\'s changes to silently overwrite the other\'s. ' +
          'Switch to that session instead, or open it here anyway?',
        { modal: true },
        'Open here anyway',
      );
      if (choice !== 'Open here anyway') return;
    }
    await acquireEditSession(localPath);
    await vscode.window.showTextDocument(vscode.Uri.file(localPath) as never);
  }

  /**
   * Spec §2.3: a download always proceeds, but a file over 5MB or one that
   * looks binary does not auto-open in the editor unasked. Small text files
   * keep the old instant-open behavior.
   */
  async function shouldAutoOpen(localPath: string, remotePath: string, byteSize: number): Promise<boolean> {
    let binary = false;
    if (byteSize <= AUTO_OPEN_PROMPT_THRESHOLD_BYTES) {
      try {
        const fh = await (await import('node:fs/promises')).default.open(localPath, 'r');
        try {
          const buffer = Buffer.alloc(8192);
          const { bytesRead } = await fh.read(buffer, 0, 8192, 0);
          binary = isProbablyBinary(buffer.subarray(0, bytesRead));
        } finally {
          await fh.close();
        }
      } catch {
        binary = false;
      }
    }
    if (byteSize <= AUTO_OPEN_PROMPT_THRESHOLD_BYTES && !binary) return true;
    const reason =
      byteSize > AUTO_OPEN_PROMPT_THRESHOLD_BYTES
        ? `${(byteSize / 1024 / 1024).toFixed(1)} MB exceeds the 5 MB auto-open limit`
        : 'looks like a binary file';
    const choice = await vscode.window.showWarningMessage(
      `Downloaded ${remotePath}, which ${reason}. Open it in the editor?`,
      'Open anyway',
      'Keep closed',
    );
    return choice === 'Open anyway';
  }

  /**
   * Shared tail for both folder commands: per-file failures were already
   * isolated by the queue (failed[] instead of a throw), so this reports
   * them where they stay visible (Output channel, shown) and offers a
   * retry limited to exactly the failed subset.
   */
  async function handleFolderFailures(
    what: string,
    failed: { remotePath: string; message: string }[],
    retryFailed: (paths: ReadonlySet<string>) => Promise<void>,
  ): Promise<void> {
    if (failed.length === 0) return;
    for (const entry of failed) output.appendLine(`${what} failed: ${entry.remotePath}: ${entry.message}`);
    output.show();
    const choice = await vscode.window.showWarningMessage(
      `${failed.length} file(s) failed during ${what}. Details are in the Gangway output channel.`,
      'Retry failed',
      'Dismiss',
    );
    if (choice === 'Retry failed') await retryFailed(new Set(failed.map((entry) => entry.remotePath)));
  }

  /**
   * Created unconditionally: every saved connection is always listed as a
   * root node (a brand-new user with zero connections just sees an empty
   * tree, no special-casing needed), and expanding one connects it.
   */
  const treeProvider = new GangwayTreeProvider(
    () => connectionManager.list(),
    () => connectionManager.getWorkspaceBinding(),
    async (connection) => {
      await getAdapter(connection);
      await connectionManager.setWorkspaceBinding(connection.id);
      purgeTmpFor(connection);
    },
    async (connection, dirPath) => {
      const adapter = await getAdapter(connection);
      return mapListingToEntries(dirPath, await adapter.list(dirPath), reportUnsafeListingName);
    },
    (connectionId, remotePath) => {
      const connection = connectionManager.list().find((c) => c.id === connectionId);
      return vscode.Uri.file(connection ? tmpFilePathFor(connection, remotePath) : remotePath);
    },
    (err) => {
      // A listing failure has no single connection to invalidate (the tree
      // lists many), but re-listing is a meaningful retry: refresh the whole
      // tree instead of leaving the node failed.
      void showCommandError(err, { retry: () => Promise.resolve(treeProvider.refresh()) });
    },
    // Local-Explorer/OS drops land here with the tree node they were dropped
    // on (or undefined for empty tree space). The closure runs long after
    // activate() finishes, so referencing handleLocalDrop (defined below)
    // is safe despite the textual order.
    (node, uriListValue) => handleLocalDrop(node, uriListValue),
  );
  const treeView = vscode.window.createTreeView('gangway.remoteExplorer', {
    treeDataProvider: treeProvider as never,
    dragAndDropController: treeProvider as never,
  });

  /**
   * TreeItem has no native double-click event. A single click used to carry
   * a `command` that downloaded and opened the file immediately, so every
   * click re-ran the whole download workflow. A first attempt at fixing that
   * drove the double-click timing off `treeView.onDidChangeSelection`
   * instead -- but VS Code only fires that event when the selection
   * actually *changes*, so clicking an already-selected file a second time
   * (exactly what a double click is) never fired a second event at all, and
   * double-click-to-open silently stopped working. `TreeItem.command` fires
   * on every click regardless of prior selection state (see
   * gangwayTreeProvider.ts), so the timing check now lives in this command
   * handler instead, the same pattern VS Code's own Explorer preview mode
   * uses.
   */
  const DOUBLE_CLICK_THRESHOLD_MS = 500;
  let lastClickedKey: string | undefined;
  let lastClickedAt = 0;
  const internalFileClickDisposable = vscode.commands.registerCommand(
    'gangway.internalFileClick',
    (node?: GangwayTreeNode) => {
      if (!node || isSelectorNode(node) || node.entry.isDirectory) {
        lastClickedKey = undefined;
        return;
      }
      const key = `${node.connectionId}:${node.entry.path}`;
      const now = Date.now();
      if (lastClickedKey === key && now - lastClickedAt < DOUBLE_CLICK_THRESHOLD_MS) {
        lastClickedKey = undefined;
        void runDownloadFileCommand(node);
        return;
      }
      lastClickedKey = key;
      lastClickedAt = now;
    },
  );

  /**
   * Badges a Gangway tmp file (in this tree, and in any editor tab showing
   * it) once its local content has diverged from what last matched the
   * server. VS Code caches decorations until told otherwise, so every path
   * that can change dirty state (a successful download or upload makes a
   * file clean again; a save can make it dirty) explicitly refreshes it.
   */
  const dirtyDecorations = new DirtyDecorationProvider();
  const dirtyDecorationRegistration = vscode.window.registerFileDecorationProvider(dirtyDecorations);
  const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
    dirtyDecorations.refresh(vscode.Uri.file(document.uri.fsPath));
  });

  /**
   * The one tmp-file status indicator for the session (TmpStatusBar owns a
   * single item: per-download creation leaked an item per file). Shown for
   * Gangway-managed tmp files, hidden everywhere else, disposed with the
   * extension host.
   */
  const tmpStatusBar = new TmpStatusBar();
  const editorSwitchListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    tmpStatusBar.handleActiveEditorChanged(editor?.document.uri.fsPath);
  });

  /**
   * Releases this window's edit-session claim (see openForEditing above)
   * the moment its tab closes, so a genuinely finished edit never keeps
   * blocking a different window from opening the same file. Fires for
   * every closed document, Gangway-managed or not; releaseEditSession is a
   * no-op (ENOENT, swallowed) for anything that was never claimed.
   */
  const sessionReleaseListener = vscode.workspace.onDidCloseTextDocument((document) => {
    void releaseEditSession(document.uri.fsPath).catch(() => {});
  });

  /**
   * One cancellable progress notification for both folder commands. The
   * `AbortSignal` is what actually reaches the transfer queue: VS Code's
   * cancellation token is translated once, here, so neither command has to.
   * `location: Notification` (rather than a view id) is what makes the Cancel
   * button exist at all.
   */
  function withCancellableProgress<T>(
    title: string,
    task: (signal: AbortSignal, reportProgress: (remotePath: string) => void) => Promise<T>,
  ): Thenable<T> {
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return task(controller.signal, (remotePath) => progress.report({ message: remotePath }));
      },
    );
  }

  /** Expired tmp entries are per connection, so this runs for whichever
   * connection is bound: at boot, and again as soon as one is first saved. */
  function purgeTmpFor(connection: ConnectionConfig): void {
    void purgeExpiredTmp(tmpRootFor(connection));
  }

  const initialConnection = getActiveConnection();
  if (initialConnection) purgeTmpFor(initialConnection);
  // Orphaned tmp roots (pre-slug-change trees, deleted connections) belong
  // to no saved connection: sweep them once per boot by the same age rules.
  // Fire-and-forget like the purge above, and non-throwing by construction.
  void sweepUnknownTmpRoots(new Set(connectionManager.list().map((c) => connectionSlug(c))));

  /**
   * The Manage Remotes page: a sidebar listing every saved connection
   * (left) plus an add/edit form (right). `initialConnection` only decides
   * which entry the form starts on -- the
   * sidebar always lists everything and the user can click any row, or "+
   * Add", to change what the form is editing without reopening the page.
   */
  function openManageRemotesPanel(initialConnection?: ConnectionConfig): void {
    const mediaDir = vscode.Uri.joinPath(context.extensionUri, 'dist', 'media', 'connectionForm');
    const rawPanel = vscode.window.createWebviewPanel(
      'gangway.connectionForm',
      'Gangway: Manage Remotes',
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [mediaDir] },
    );
    const panel = new ConnectionFormPanel(
      rawPanel,
      connectionManager,
      secrets,
      (connections) => {
        // Any add/edit/delete can change what the tree's selector row and
        // file listing should show (a renamed bound connection, one that
        // just lost its binding because it was deleted, ...).
        treeProvider.refresh();
        const bound = connections.find((c) => c.id === connectionManager.getWorkspaceBinding());
        if (bound) purgeTmpFor(bound);
      },
      async () => {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          title: 'Select SSH Private Key',
          openLabel: 'Select Key',
        });
        return picked?.[0]?.fsPath;
      },
      async (connection) => {
        const choice = await vscode.window.showWarningMessage(
          `Delete the saved connection "${connection.name}" (${connection.host})? This does not touch anything on the server.`,
          { modal: true },
          'Delete',
        );
        return choice === 'Delete';
      },
      (message) => {
        void vscode.window.showWarningMessage(`Gangway: ${message}`);
      },
    );
    rawPanel.webview.html = buildConnectionFormHtml({
      toolkitUri: rawPanel.webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'toolkit.min.js')).toString(),
      mainScriptUri: rawPanel.webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'main.js')).toString(),
      cspSource: rawPanel.webview.cspSource,
      nonce: panel.nonce,
      ...resolveConnectionFormFields(initialConnection),
      connectionsJson: toConnectionsJson(connectionManager.list()),
    });
  }

  async function runDownloadFileCommand(node?: RemoteTreeNode): Promise<void> {
    const connection = resolveConnection(node);
    if (!connection) return;

    let remotePath = node?.entry?.path;

    // Real keybinding invocation (Alt+Shift+W) supplies no arguments at
    // all -- a keybinding can only pass a static `args` value declared in
    // package.json, never "the tree item that's currently selected". The
    // actual context is "re-download whatever tmp file is open right now,
    // discarding local edits": derive the remote path from the active
    // editor's own sidecar, symmetric to how gangway.uploadFile derives
    // its arguments from the active editor.
    if (!remotePath) {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        await vscode.window.showWarningMessage(
          'No active editor to download. Select a file in the Gangway Remote Explorer, or open a Gangway-downloaded file first.',
        );
        return;
      }
      const localPath = activeEditor.document.uri.fsPath;
      const sidecar = await readSidecar(localPath);
      if (!sidecar) {
        await vscode.window.showWarningMessage(
          `${localPath} is not a Gangway-managed file (no sidecar metadata found).`,
        );
        return;
      }
      if (sidecar.connectionId !== connection.id) {
        // A tmp file left open from a previously-bound connection would
        // otherwise run against whatever connection is active now: pushing
        // a hotfix to the wrong server is the worst outcome this tool can
        // produce, so it stops here rather than issuing any network call.
        await vscode.window.showWarningMessage(
          `${localPath} belongs to a different connection than the one currently active for this workspace ` +
            `("${connection.name}"). Bind that connection to this workspace before continuing.`,
        );
        return;
      }
      remotePath = sidecar.remotePath;
    }

    try {
      const { localPath, meta } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Gangway: downloading ${remotePath}` },
        async () => {
          const adapter = await getAdapter(connection);
          return downloadFile(adapter, connection, remotePath);
        },
      );
      tmpStatusBar.showFor(connection.name, remotePath, localPath);
      dirtyDecorations.refresh(vscode.Uri.file(localPath));
      if (await shouldAutoOpen(localPath, remotePath, meta.size)) {
        await openForEditing(localPath);
      }
    } catch (err) {
      await showCommandError(err, { retry: () => runDownloadFileCommand(node), connection });
    }
  }

  /**
   * Accepts either a tree file node (context-menu invocation), an explicit
   * local+remote pair (tests, future callers), or nothing at all (the real
   * Alt+Shift+Q keybinding, which derives everything from the active editor
   * + sidecar). Every shape funnels into the same wrong-server guard: a
   * sidecar naming another connection stops the push before any network
   * call, no matter how the command was invoked.
   */
  async function runUploadFileCommand(nodeOrLocalPath?: RemoteTreeNode | string, remotePathArg?: string): Promise<void> {
    const node = typeof nodeOrLocalPath === 'object' ? nodeOrLocalPath : undefined;
    // A tree invocation names its own connection; only the keybinding falls
    // back to the workspace binding (see resolveConnection()).
    const connection = node ? resolveConnection(node) : requireActiveConnection();
    if (!connection) return;

    let localPath: string | undefined;
    let remotePath: string | undefined;
    if (node?.entry?.path) {
      remotePath = node.entry.path;
      localPath = tmpFilePathFor(connection, remotePath);
    } else {
      localPath = typeof nodeOrLocalPath === 'string' ? nodeOrLocalPath : undefined;
      remotePath = remotePathArg;
    }

    // Real keybinding invocation (Alt+Shift+Q) supplies no arguments at
    // all -- VS Code keybindings can only pass a static `args` value
    // declared in package.json, never "the currently active file". The
    // actual context is simply "whatever tmp file is open right now":
    // derive both the local path and its remote counterpart from the
    // active editor + that file's own sidecar metadata.
    if (!localPath) {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        await vscode.window.showWarningMessage('No active editor to upload. Open a Gangway-downloaded file first.');
        return;
      }
      localPath = activeEditor.document.uri.fsPath;
      const derivedSidecar = await readSidecar(localPath);
      if (!derivedSidecar) {
        await vscode.window.showWarningMessage(
          `${localPath} is not a Gangway-managed file (no sidecar metadata found).`,
        );
        return;
      }
      if (derivedSidecar.connectionId !== connection.id) {
        // A tmp file left open from a previously-bound connection would
        // otherwise run against whatever connection is active now: pushing
        // a hotfix to the wrong server is the worst outcome this tool can
        // produce, so it stops here rather than issuing any network call.
        await vscode.window.showWarningMessage(
          `${localPath} belongs to a different connection than the one currently active for this workspace ` +
            `("${connection.name}"). Bind that connection to this workspace before continuing.`,
        );
        return;
      }
      remotePath = derivedSidecar.remotePath;
      // Wrong-server was already checked above (mismatch returns); only the
      // frozen check can still fire here, before any network call.
      try {
        guardUploadTarget(connection, derivedSidecar);
      } catch (err) {
        if (err instanceof FrozenError) {
          await vscode.window.showInformationMessage(err.message);
          return;
        }
        throw err;
      }
    }

    if (!remotePath) {
      await vscode.window.showWarningMessage('Upload requires a remote path; none was provided or derived.');
      return;
    }

    try {
      const adapter = await getAdapter(connection);
      const sidecar = await readSidecar(localPath);
      // The same wrong-server guard for explicitly-supplied paths: only the
      // derived (keybinding) shape used to check this, so a programmatic
      // call with a stale tmp file could push to the wrong server.
      if (sidecar && sidecar.connectionId !== connection.id) {
        await vscode.window.showWarningMessage(
          `${localPath} belongs to a different connection than "${connection.name}". Bind that connection to this workspace before continuing.`,
        );
        return;
      }
      // Same ordering as the keybinding shape above: the wrong-server case
      // just warned and returned, so only the frozen check can fire here.
      try {
        guardUploadTarget(connection, sidecar);
      } catch (err) {
        if (err instanceof FrozenError) {
          await vscode.window.showInformationMessage(err.message);
          return;
        }
        throw err;
      }
      // A tree-node upload for a file that was never downloaded has no
      // local mirror yet. Say so directly: without this, the stat below
      // fails with ENOENT and the user is told the path "does not exist on
      // the server", which is the exact opposite of the truth.
      let byteSize: number;
      try {
        byteSize = await (await import('node:fs/promises')).default.stat(localPath).then((s) => s.size);
      } catch {
        await vscode.window.showWarningMessage(
          `${localPath} has no local copy yet. Download it first, then upload.`,
        );
        return;
      }
      const freshStat = await adapter.stat(remotePath);
      // The local file was proven to exist by the byteSize stat above (a
      // never-downloaded file already returned "no local copy yet" before
      // this point), yet its sidecar is missing or unreadable (a torn write,
      // disk full, or a foreign/corrupt file). There is no baseline left to
      // compare against, so this must be treated as an unverifiable
      // conflict -- fail closed into the same review flow a real conflict
      // gets -- rather than silently falling through to an unconditional
      // overwrite.
      if (!sidecar || checkConflict(sidecar, freshStat) === 'conflict') {
        const decision = await resolveFileConflict(adapter, connection.id, localPath, remotePath, conflictUi);
        if (decision === 'keepServer') {
          dirtyDecorations.refresh(vscode.Uri.file(localPath));
          await vscode.window.showInformationMessage(
            `Local edits discarded: ${localPath} now matches the server copy of ${remotePath}.`,
          );
          return;
        }
        if (decision !== 'overwrite') return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Gangway: uploading ${remotePath}` },
        () => uploadFile(adapter, connection.id, localPath as string, remotePath as string, byteSize, auditLog, (message) => output.appendLine(message), { connection }),
      );
      dirtyDecorations.refresh(vscode.Uri.file(localPath));
      treeProvider.refresh();
    } catch (err) {
      await showCommandError(err, { retry: () => runUploadFileCommand(nodeOrLocalPath, remotePathArg), connection });
    }
  }

  /**
   * `onlyPaths` carries the Retry-failed subset; the error-action Retry
   * re-runs the whole command instead (fresh plan, fresh conflict scan).
   */
  const runDownloadFolderCommand = async (node?: RemoteTreeNode, onlyPaths?: ReadonlySet<string>): Promise<void> => {
    if (!node?.entry?.path) {
      await vscode.window.showWarningMessage('Select a folder in the Gangway Remote Explorer to download it.');
      return;
    }
    const connection = resolveConnection(node);
    if (!connection) return;
    const remotePath = node.entry.path;
    const fs = (await import('node:fs/promises')).default;
    try {
      const adapter = await getAdapter(connection);
      const result = await withCancellableProgress(`Downloading ${remotePath}`, (signal, reportProgress) =>
        runFolderDownload(
          { path: remotePath, isDirectory: true, isSymbolicLink: false, size: 0 },
          async (dirPath) => mapListingToEntries(dirPath, await adapter.list(dirPath), reportUnsafeListingName),
          async (file) => {
            const { localPath } = await downloadFile(adapter, connection, file);
            dirtyDecorations.refresh(vscode.Uri.file(localPath));
            tmpStatusBar.showFor(connection.name, file, localPath);
          },
          reportProgress,
          {
            signal,
            onlyPaths,
            ensureDir: async (dir) => {
              await fs.mkdir(tmpFilePathFor(connection, dir), { recursive: true });
            },
          },
        ),
      );
      treeProvider.refresh();
      if (result.symlinked.length > 0) {
        // Spec §2.3: symlinks download as plain files *with a warning* --
        // the listing flag existed, but no warning was ever shown.
        const preview = result.symlinked.slice(0, 3).join(', ');
        await vscode.window.showWarningMessage(
          `Downloaded ${result.downloaded.length} file(s), but ${result.symlinked.length} arrived as plain files ` +
            `(remote symlinks are never recreated locally${result.symlinked.length > 0 ? `: ${preview}` : ''}${result.symlinked.length > 3 ? ', …' : ''}).`,
        );
      } else {
        await vscode.window.showInformationMessage(
          result.cancelled
            ? `Cancelled after downloading ${result.downloaded.length} file(s).`
            : `Downloaded ${result.downloaded.length} file(s).`,
        );
      }
      await handleFolderFailures('download', result.failed, (paths) => runDownloadFolderCommand(node, paths));
    } catch (err) {
      await showCommandError(err, { retry: () => runDownloadFolderCommand(node), connection });
    }
  };

  const runUploadFolderCommand = async (node?: RemoteTreeNode, onlyPaths?: ReadonlySet<string>): Promise<void> => {
    if (!node?.entry?.path) {
      await vscode.window.showWarningMessage('Select a folder in the Gangway Remote Explorer to upload it.');
      return;
    }
    const connection = resolveConnection(node);
    if (!connection) return;
    try {
      assertMutatingAllowed(connection);
    } catch (err) {
      if (err instanceof FrozenError) {
        await vscode.window.showInformationMessage(err.message);
        return;
      }
      throw err;
    }
    const remotePath = node.entry.path;
    const fs = (await import('node:fs/promises')).default;
    try {
      // A tree-view context-menu command only ever receives the one
      // clicked node -- there is no second free-form argument a real
      // invocation can supply. Derive the local tmp mirror the same way
      // single-file downloads do (tmpFilePathFor mirrors
      // connection.remotePath-relative paths under the per-connection tmp
      // root). tmpFilePathFor throws on an escaping path (see tmpPath.ts),
      // and that throw must land in this catch like every other failure
      // below, not become an unhandled rejection outside it.
      const localRoot = tmpFilePathFor(connection, remotePath);
      // Remote paths are posix; the local mirror is platform-native.
      // String concatenation here used to break on Windows separators and
      // bypass the tmpPath containment check -- path.posix.relative keeps
      // the remote semantics, path.join builds the local path.
      // Re-applies tmpFilePathFor's own containment check (tmpPath.ts) to
      // every per-file mapping, not just the folder root computed above:
      // without it, an escaping `file` path would silently resolve outside
      // localRoot instead of failing loudly the way every single-file path
      // through tmpFilePathFor does. Not reachable today (remoteListing.ts's
      // mapListingToEntries already rejects any unsafe listing-entry name
      // before a `file` path is built), but this stays the belt to that
      // suspenders rather than a second, weaker path relying on the caller
      // never changing.
      const toLocal = (file: string): string => {
        const resolved = path.join(localRoot, path.posix.relative(remotePath, file));
        if (resolved !== localRoot && !resolved.startsWith(localRoot + path.sep)) {
          throw new Error(`Refusing to map remote path "${file}": it resolves outside this connection's tmp root.`);
        }
        return resolved;
      };
      const adapter = await getAdapter(connection);
      const result = await withCancellableProgress(`Uploading ${remotePath}`, (signal, reportProgress) =>
        runFolderUpload(
          { path: remotePath, isDirectory: true, isSymbolicLink: false, size: 0 },
          async (dirPath) => mapListingToEntries(dirPath, await adapter.list(dirPath), reportUnsafeListingName),
          async (file) => {
            const localPath = toLocal(file);
            let byteSize: number;
            try {
              byteSize = (await fs.stat(localPath)).size;
            } catch {
              throw new Error(`No local copy of ${file} -- download the folder before uploading it.`);
            }
            await uploadFile(adapter, connection.id, localPath, file, byteSize, auditLog, (message) =>
              output.appendLine(message),
              { connection },
            );
            dirtyDecorations.refresh(vscode.Uri.file(localPath));
          },
          async (file) => {
            const localPath = toLocal(file);
            const sidecar = await readSidecar(localPath);
            if (!sidecar) {
              // No baseline recorded. A file never downloaded has no local
              // mirror at all and fails later at the per-file "no local
              // copy" check regardless of this verdict, so it is not a
              // conflict. A file that WAS downloaded but lost its sidecar
              // (torn write, disk full) has no way to prove it hasn't
              // changed on the server since -- fail closed into the same
              // review flow a real conflict gets, rather than silently
              // skipping the guard.
              try {
                await fs.stat(localPath);
              } catch {
                return false;
              }
              return true;
            }
            const freshStat = await adapter.stat(file);
            return checkConflict(sidecar, freshStat) === 'conflict';
          },
          async (conflictedPaths) => {
            const choice = await vscode.window.showWarningMessage(
              `${conflictedPaths.length} file(s) changed on the server since download.`,
              'Review one by one',
              'Skip conflicted',
            );
            return choice === 'Review one by one' ? 'reviewOneByOne' : 'skipConflicted';
          },
          // The per-file review. Without this argument runFolderUpload has
          // nothing to call, so "Review one by one" silently behaved exactly
          // like "Skip conflicted": the user was offered a choice that did
          // nothing. Each conflicted file now gets the same diff and
          // three-way decision as a single-file push.
          async (file) => resolveFileConflict(adapter, connection.id, toLocal(file), file, conflictUi),
          {
            signal,
            reportProgress,
            onlyPaths,
            ensureDir: async (dir) => {
              await adapter.mkdir(dir, true);
            },
          },
        ),
      );
      treeProvider.refresh();
      await vscode.window.showInformationMessage(
        `${result.cancelled ? 'Cancelled. ' : ''}Uploaded ${result.uploaded.length} file(s). ` +
          `${result.skippedConflicted.length} skipped (conflicted), ${result.skippedSymlinks.length} skipped (symlinks), ${result.failed.length} failed.`,
      );
      await handleFolderFailures('upload', result.failed, (paths) => runUploadFolderCommand(node, paths));
    } catch (err) {
      await showCommandError(err, { retry: () => runUploadFolderCommand(node), connection });
    }
  };

  /**
   * Read-only compare (spec §2.2): diff the local tmp copy against the
   * server's current bytes with no push decision attached. Unlike the
   * conflict flow this never offers Overwrite -- it is for looking, and a
   * file that was never downloaded has nothing to look at yet.
   */
  const runCompareFileCommand = async (node?: RemoteTreeNode): Promise<void> => {
    const connection = resolveConnection(node);
    if (!connection) return;
    if (node?.entry?.isDirectory) {
      await vscode.window.showWarningMessage('Compare works on files, not folders.');
      return;
    }
    let remotePath = node?.entry?.path;
    if (!remotePath) {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        await vscode.window.showWarningMessage('No active editor to compare. Open a Gangway-downloaded file first.');
        return;
      }
      const sidecar = await readSidecar(activeEditor.document.uri.fsPath);
      if (!sidecar) {
        await vscode.window.showWarningMessage('This file is not a Gangway-managed file (no sidecar metadata found).');
        return;
      }
      if (sidecar.connectionId !== connection.id) {
        await vscode.window.showWarningMessage('This file belongs to a different connection than the active one.');
        return;
      }
      remotePath = sidecar.remotePath;
    }
    const fs = (await import('node:fs/promises')).default;
    try {
      const localPath = tmpFilePathFor(connection, remotePath);
      try {
        await fs.stat(localPath);
      } catch {
        await vscode.window.showWarningMessage(`${remotePath} has no local copy yet. Download it first, then compare.`);
        return;
      }
      const adapter = await getAdapter(connection);
      const serverCopyPath = `${localPath}.gangway-compare-fresh`;
      try {
        await adapter.fastGet(remotePath, serverCopyPath);
        await vscode.commands.executeCommand(
          'vscode.diff',
          vscode.Uri.file(localPath),
          vscode.Uri.file(serverCopyPath),
          `${path.posix.basename(remotePath)}: local (Gangway) ↔ server (current)`,
        );
      } finally {
        await fs.rm(serverCopyPath, { force: true }).catch(() => {});
      }
    } catch (err) {
      await showCommandError(err, { retry: () => runCompareFileCommand(node), connection });
    }
  };

  /**
   * File-command guard shared by every Task 5/6 mutating tree command:
   * resolve the node's own connection, then stop frozen connections with an
   * info message before any prompt or network call.
   */
  async function requireMutableConnection(node?: RemoteTreeNode): Promise<ConnectionConfig | undefined> {
    const connection = resolveConnection(node);
    if (!connection) return undefined;
    try {
      assertMutatingAllowed(connection);
    } catch (err) {
      if (err instanceof FrozenError) {
        await vscode.window.showInformationMessage(err.message);
        return undefined;
      }
      throw err;
    }
    return connection;
  }

  async function runNewRemoteCommand(kind: 'file' | 'dir', node?: RemoteTreeNode): Promise<void> {
    const connection = await requireMutableConnection(node);
    if (!connection) return;
    let dirPath = node?.entry?.path;
    if (node?.entry && !node.entry.isDirectory) dirPath = path.posix.dirname(node.entry.path);
    if (!dirPath) {
      await vscode.window.showWarningMessage('Select a folder in the Gangway Remote Explorer first.');
      return;
    }
    const name = await vscode.window.showInputBox({ prompt: `Name of the new ${kind} in ${dirPath}` });
    if (!name) return;
    try {
      const adapter = await getAdapter(connection);
      const { path: created } = await createRemote(adapter, connection, dirPath, name, kind, auditLog, {
        onAuditError: (message) => output.appendLine(message),
      });
      treeProvider.refresh();
      if (kind === 'file') {
        const choice = await vscode.window.showInformationMessage(`Created ${created}.`, 'Download for editing');
        if (choice === 'Download for editing') {
          await runDownloadFileCommand({
            connectionId: connection.id,
            entry: { path: created, isDirectory: false, isSymbolicLink: false, size: 0 },
          });
        }
      } else {
        await vscode.window.showInformationMessage(`Created folder ${created}.`);
      }
    } catch (err) {
      await showCommandError(err, { retry: () => runNewRemoteCommand(kind, node), connection });
    }
  }

  async function runRenameRemoteCommand(node?: RemoteTreeNode): Promise<void> {
    if (!node?.entry?.path) {
      await vscode.window.showWarningMessage('Select a file or folder in the Gangway Remote Explorer to rename it.');
      return;
    }
    const connection = await requireMutableConnection(node);
    if (!connection) return;
    const oldPath = node.entry.path;
    const newName = await vscode.window.showInputBox({
      prompt: `Rename ${oldPath} to`,
      value: path.posix.basename(oldPath),
    });
    if (!newName) return;
    try {
      const adapter = await getAdapter(connection);
      const { newPath } = await renameRemote(adapter, connection, oldPath, newName, auditLog, {
        onAuditError: (message) => output.appendLine(message),
      });
      treeProvider.refresh();
      await vscode.window.showInformationMessage(`Renamed to ${newPath}.`);
    } catch (err) {
      await showCommandError(err, { retry: () => runRenameRemoteCommand(node), connection });
    }
  }

  async function countRemoteFiles(adapter: SftpClientAdapter, dirPath: string): Promise<number> {
    const entries = mapListingToEntries(dirPath, await adapter.list(dirPath), reportUnsafeListingName);
    let count = 0;
    for (const entry of entries) {
      if (entry.isDirectory) count += await countRemoteFiles(adapter, entry.path);
      else count += 1;
    }
    return count;
  }

  async function runDeleteRemoteCommand(node?: RemoteTreeNode): Promise<void> {
    if (!node?.entry?.path) {
      await vscode.window.showWarningMessage('Select a file or folder in the Gangway Remote Explorer to delete it.');
      return;
    }
    const connection = await requireMutableConnection(node);
    if (!connection) return;
    const target = node.entry.path;
    try {
      const adapter = await getAdapter(connection);
      if (!node.entry.isDirectory) {
        const choice = await vscode.window.showWarningMessage(
          `Move ${target} to the Gangway trash on the server?`,
          'Move to Trash',
          'Cancel',
        );
        if (choice !== 'Move to Trash') return;
        await moveToTrash(adapter, connection, target, auditLog, {
          onAuditError: (message) => output.appendLine(message),
        });
      } else {
        const fileCount = await countRemoteFiles(adapter, target);
        const base = path.posix.basename(target);
        const typed = await vscode.window.showInputBox({
          prompt: `Type "${base}" to move this folder (${fileCount} file(s)) to the Gangway trash`,
        });
        if (!typedConfirmMatches(base, typed)) {
          await vscode.window.showInformationMessage('Delete cancelled: the typed name did not match.');
          return;
        }
        await moveToTrash(adapter, connection, target, auditLog, {
          count: fileCount,
          onAuditError: (message) => output.appendLine(message),
        });
      }
      treeProvider.refresh();
      await vscode.window.showInformationMessage(`Moved ${target} to trash.`);
    } catch (err) {
      await showCommandError(err, { retry: () => runDeleteRemoteCommand(node), connection });
    }
  }

  async function runDuplicateRemoteCommand(node?: RemoteTreeNode): Promise<void> {
    if (!node?.entry?.path || node.entry.isDirectory) {
      await vscode.window.showWarningMessage('Select a file in the Gangway Remote Explorer to duplicate it.');
      return;
    }
    const connection = await requireMutableConnection(node);
    if (!connection) return;
    try {
      const adapter = await getAdapter(connection);
      const { path: dupPath } = await duplicateRemote(adapter, connection, node.entry.path, auditLog, {
        onAuditError: (message) => output.appendLine(message),
      });
      treeProvider.refresh();
      await vscode.window.showInformationMessage(`Duplicated to ${dupPath}.`);
    } catch (err) {
      await showCommandError(err, { retry: () => runDuplicateRemoteCommand(node), connection });
    }
  }

  const CHMOD_PRESETS = ['644 (files)', '755 (folders)', '600', '640', 'Custom…'];

  async function runChmodRemoteCommand(node?: RemoteTreeNode): Promise<void> {
    if (!node?.entry?.path) {
      await vscode.window.showWarningMessage('Select a file or folder in the Gangway Remote Explorer first.');
      return;
    }
    const connection = await requireMutableConnection(node);
    if (!connection) return;
    const picked = await vscode.window.showQuickPick(CHMOD_PRESETS, { placeHolder: 'Choose a mode' });
    if (!picked) return;
    let mode: string | undefined;
    if (picked === 'Custom…') {
      mode = await vscode.window.showInputBox({ prompt: 'Octal mode (e.g. 644)', value: '644' });
      if (!mode) return;
    } else {
      const match = /^(\d{3,4})\b/.exec(picked);
      mode = match ? match[1] : undefined;
    }
    if (!mode) return;
    try {
      const adapter = await getAdapter(connection);
      await chmodRemote(adapter, connection, node.entry.path, mode, auditLog, {
        onAuditError: (message) => output.appendLine(message),
      });
      treeProvider.refresh();
      await vscode.window.showInformationMessage(`Changed mode of ${node.entry.path} to ${mode}.`);
    } catch (err) {
      await showCommandError(err, { retry: () => runChmodRemoteCommand(node), connection });
    }
  };

  /** The tree clipboard: cut/copy names connections, paste resolves them. Local state only. */
  let clipboard: ClipboardState = clearClipboard();

  async function runCutCopyCommand(cut: boolean, node?: RemoteTreeNode | RemoteTreeNode[]): Promise<void> {
    const nodes = node === undefined ? [] : Array.isArray(node) ? node : [node];
    if (nodes.length === 0) {
      await vscode.window.showWarningMessage('Select one or more files or folders in the Gangway Remote Explorer first.');
      return;
    }
    // Cutting/copying only arms the local clipboard — nothing on the server
    // moves — so frozen connections are allowed here; the paste is blocked.
    const first = nodes[0];
    const connection = resolveConnection(first);
    if (!connection) return;
    for (const entry of nodes) {
      if (entry.connectionId !== connection.id) {
        await vscode.window.showWarningMessage('Cut/copy across connections is not supported: select items from one connection.');
        return;
      }
    }
    const paths = nodes.map((entry) => (entry.entry as { path: string }).path);
    clipboard = cut ? cutToClipboard(clipboard, connection.id, paths) : copyToClipboard(clipboard, connection.id, paths);
    await vscode.window.showInformationMessage(`${cut ? 'Cut' : 'Copied'} ${paths.length} item(s).`);
  }

  async function runPasteEntriesCommand(node?: RemoteTreeNode): Promise<void> {
    const connection = await requireMutableConnection(node);
    if (!connection) return;
    if (clipboard.paths.length === 0) {
      await vscode.window.showInformationMessage('Clipboard is empty. Cut or copy something in the Gangway Remote Explorer first.');
      return;
    }
    const destDir =
      node?.entry !== undefined
        ? node.entry.isDirectory
          ? node.entry.path
          : path.posix.dirname(node.entry.path)
        : connection.remotePath;
    try {
      const adapter = await getAdapter(connection);
      const result = await withCancellableProgress('Pasting…', (signal, reportProgress) =>
        pasteEntries(
          adapter,
          connection,
          clipboard,
          destDir,
          {
            confirmOverwrite: ({ remotePath, stagingPath }) =>
              resolveFileConflict(adapter, connection.id, stagingPath as string, remotePath, conflictUi),
            auditLog,
          },
          { signal, onAuditError: (message) => output.appendLine(message) },
        ).then((r) => {
          reportProgress(destDir);
          return r;
        }),
      );
      if (clipboard.cut && result.pasted.length > 0 && result.skipped.length === 0) clipboard = clearClipboard();
      treeProvider.refresh();
      if (result.skipped.length > 0) {
        for (const skip of result.skipped) output.appendLine(`Paste skipped: ${skip.path} (${skip.reason})`);
        output.show();
        await vscode.window.showWarningMessage(
          `Pasted ${result.pasted.length}, skipped ${result.skipped.length}. Details are in the Gangway output channel.`,
        );
      } else {
        await vscode.window.showInformationMessage(`Pasted ${result.pasted.length} item(s).`);
      }
    } catch (err) {
      await showCommandError(err, { retry: () => runPasteEntriesCommand(node), connection });
    }
  }

  async function runRestoreFromTrashCommand(): Promise<void> {
    const connection = await requireMutableConnection();
    if (!connection) return;
    try {
      const adapter = await getAdapter(connection);
      const picks = await withCancellableProgress('Listing trash…', () => inventoryTrash(adapter, connection));
      if (picks.length === 0) {
        await vscode.window.showInformationMessage('Trash is empty.');
        return;
      }
      type TrashRow = vscode.QuickPickItem & { pick: (typeof picks)[number] };
      const rows: TrashRow[] = picks.map((pick) => ({ label: pick.label, detail: pick.detail, pick }));
      const selected = await vscode.window.showQuickPick(rows, {
        canPickMany: true,
        placeHolder: 'Select trash entries to restore',
      });
      if (!selected || selected.length === 0) return;
      let override: string | undefined;
      if (selected.length === 1) {
        const destChoice = await vscode.window.showQuickPick(['Restore to original locations', 'Choose alternate folder…'], {
          placeHolder: 'Where should the files go?',
        });
        if (!destChoice) return;
        if (destChoice !== 'Restore to original locations') {
          override = await vscode.window.showInputBox({
            prompt: 'Alternate folder (remote path)',
            value: path.posix.dirname(selected[0].pick.items[0]?.originalPath ?? connection.remotePath),
          });
          if (!override) return;
        }
      }
      const result = await withCancellableProgress('Restoring…', (signal) =>
        restoreEntries(
          adapter,
          connection,
          selected.map((row) => row.pick),
          override,
          {
            confirmOverwrite: ({ remotePath, stagingPath }) =>
              resolveFileConflict(adapter, connection.id, stagingPath as string, remotePath, conflictUi),
            auditLog,
          },
          { signal, onAuditError: (message) => output.appendLine(message) },
        ),
      );
      treeProvider.refresh();
      if (result.skipped.length > 0) {
        for (const skip of result.skipped) output.appendLine(`Restore skipped: ${skip.path} (${skip.reason})`);
        output.show();
      }
      await vscode.window.showInformationMessage(
        `Restored ${result.restored.length}, skipped ${result.skipped.length}.`,
      );
    } catch (err) {
      await showCommandError(err, { retry: () => runRestoreFromTrashCommand(), connection });
    }
  }

  async function runEmptyTrashCommand(): Promise<void> {
    const connection = await requireMutableConnection();
    if (!connection) return;
    try {
      const adapter = await getAdapter(connection);
      const picks = await withCancellableProgress('Listing trash…', () => inventoryTrash(adapter, connection));
      if (picks.length === 0) {
        await vscode.window.showInformationMessage('Trash is empty.');
        return;
      }
      const files = picks.reduce((total, pick) => total + pick.count, 0);
      const typed = await vscode.window.showInputBox({
        prompt: `Type EMPTY TRASH to permanently delete ${picks.length} trash entr${picks.length === 1 ? 'y' : 'ies'} (${files} file(s)). There is no undo.`,
      });
      if (!typedConfirmMatches('EMPTY TRASH', typed)) {
        await vscode.window.showInformationMessage('Empty Trash cancelled.');
        return;
      }
      const result = await withCancellableProgress('Emptying trash…', (signal) =>
        emptyTrash(adapter, connection, picks, auditLog, {
          signal,
          onAuditError: (message) => output.appendLine(message),
        }),
      );
      treeProvider.refresh();
      await vscode.window.showInformationMessage(
        `Emptied trash: ${result.files} file(s) in ${result.entries} entries deleted permanently.`,
      );
    } catch (err) {
      await showCommandError(err, { retry: () => runEmptyTrashCommand(), connection });
    }
  }

  /**
   * Local-Explorer/OS drop onto a remote node. Every dropped path is
   * inspected first (missing paths and folders fail fast); large or binary
   * files get one combined prompt; the upload loop reuses backup-first
   * uploadFile with progress + cancel.
   */
  async function handleLocalDrop(targetNode: RemoteTreeNode | undefined, uriListValue: string): Promise<void> {
    const connection = await requireMutableConnection(targetNode);
    if (!connection) return;
    const fsPaths = parseUriList(uriListValue);
    if (fsPaths.length === 0) return;
    let collected;
    try {
      collected = await collectDropUploads(fsPaths);
    } catch (err) {
      await showCommandError(err as Error, { connection });
      return;
    }
    const flagged = collected.filter((c) => c.needsPrompt);
    if (flagged.length > 0) {
      const choice = await vscode.window.showWarningMessage(
        `${flagged.length} of ${collected.length} dropped file(s) are large or look binary. Upload them anyway?`,
        'Upload all',
        'Skip flagged',
      );
      if (choice !== 'Upload all' && choice !== 'Skip flagged') return;
      if (choice === 'Skip flagged') collected = collected.filter((c) => !c.needsPrompt);
    }
    if (collected.length === 0) return;
    const targetDir =
      targetNode?.entry && targetNode.entry.isDirectory
        ? targetNode.entry.path
        : targetNode?.entry
          ? path.posix.dirname(targetNode.entry.path)
          : connection.remotePath;
    try {
      const adapter = await getAdapter(connection);
      await withCancellableProgress(`Uploading ${collected.length} dropped file(s)`, (signal, reportProgress) =>
        (async () => {
          for (const item of collected) {
            if (signal.aborted) throw new TransferCancelledError();
            const remotePath = `${targetDir}/${path.posix.basename(item.localPath)}`;
            reportProgress(remotePath);
            await uploadFile(adapter, connection.id, item.localPath, remotePath, item.byteSize, auditLog, (message) =>
              output.appendLine(message),
              { connection },
            );
          }
        })(),
      );
      treeProvider.refresh();
      await vscode.window.showInformationMessage(`Uploaded ${collected.length} file(s).`);
    } catch (err) {
      await showCommandError(err, { retry: () => handleLocalDrop(targetNode, uriListValue), connection });
    }
  }

  /**
   * Govard remote import (see docs/specs/2026-09-18-gangway-govard-import-design.md).
   *
   * Workspaces carrying a `.govard.yml` already know their servers, so offer
   * them as Gangway connections instead of making the user retype host/user/
   * path. One-time import (copies, never links): later govard edits do not
   * re-sync, existing connections are never touched, and secrets never flow
   * from the YAML (which carries none).
   */
  const GOVARD_DISMISS_KEY = 'gangway.govardImportDismissed';
  interface GovardScan {
    projectName: string;
    mapped: MappedRemote[];
  }

  type GovardPickItem = vscode.QuickPickItem & { connection: Omit<ConnectionConfig, 'id'> };

  async function importGovardRemotes(
    manual: boolean,
    folders: readonly { uri: { fsPath: string }; name: string }[] = vscode.workspace.workspaceFolders ?? [],
  ): Promise<void> {
    // folders defaults to a live read, except the activate-time auto-run
    // passes a snapshot taken synchronously during activate(): the scan body
    // awaits (dynamic import, file reads), and folders set after activate
    // must not leak into a scan that started before them.
    const fs = (await import('node:fs/promises')).default;
    const scans: GovardScan[] = [];
    for (const folder of folders) {
      let text: string;
      try {
        text = await fs.readFile(path.join(folder.uri.fsPath, '.govard.yml'), 'utf8');
      } catch {
        continue;
      }
      let config: GovardConfig;
      try {
        config = parseGovardYaml(text);
      } catch {
        // Broken govard files are the project owner's problem: auto-detect
        // stays silent, the manual command reports.
        if (manual) {
          await vscode.window.showErrorMessage(
            `Could not parse ${path.join(folder.uri.fsPath, '.govard.yml')}: not valid govard YAML.`,
          );
        }
        continue;
      }
      const projectName = config.projectName || path.basename(folder.uri.fsPath);
      scans.push({
        projectName,
        mapped: Object.entries(config.remotes).map(([name, remote]) => mapGovardRemote(projectName, name, remote)),
      });
    }
    const mapped = scans.flatMap((scan) => scan.mapped);
    const { fresh, alreadyPresent, skipped } = filterNewRemotes(mapped, connectionManager.list());
    if (fresh.length === 0) {
      if (manual) {
        const skippedNote =
          skipped.length > 0 ? ` Skipped: ${skipped.map((s) => `${s.remoteName} (${s.reason})`).join(', ')}.` : '';
        await vscode.window.showInformationMessage(
          alreadyPresent.length > 0
            ? `All govard remotes are already present (${alreadyPresent.join(', ')}).${skippedNote}`
            : `No importable govard remotes found.${skippedNote}`,
        );
      }
      return;
    }
    if (!manual && context.workspaceState.get<boolean>(GOVARD_DISMISS_KEY)) return;
    const choices: GovardPickItem[] = fresh.map((connection) => ({
      label: connection.name,
      description: `${connection.username}@${connection.host}:${connection.port}`,
      detail: connection.remotePath,
      picked: true,
      connection,
    }));
    let selected: Omit<ConnectionConfig, 'id'>[];
    if (!manual) {
      const action = await vscode.window.showInformationMessage(
        `Found ${fresh.length} govard remote(s) not in Gangway yet (${fresh.map((c) => c.name).join(', ')}). Import them?`,
        `Import all (${fresh.length})`,
        'Choose remotes…',
        "Don't ask again",
      );
      if (action === "Don't ask again") {
        await context.workspaceState.update(GOVARD_DISMISS_KEY, true);
        return;
      }
      if (action === 'Choose remotes…') {
        const picked = await vscode.window.showQuickPick(choices, {
          canPickMany: true,
          placeHolder: 'Select govard remotes to import',
        });
        if (!picked) return;
        selected = picked.map((item) => item.connection);
      } else if (action?.startsWith('Import all')) {
        selected = fresh;
      } else {
        return;
      }
    } else {
      const picked = await vscode.window.showQuickPick(choices, {
        canPickMany: true,
        placeHolder: 'Select govard remotes to import',
      });
      if (!picked) return;
      selected = picked.map((item) => item.connection);
    }
    try {
      for (const connection of selected) {
        await connectionManager.add(connection);
      }
    } catch (err) {
      if (manual) {
        await vscode.window.showErrorMessage(
          `Could not save the imported connections: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    treeProvider.refresh();
    const importedNote = `Imported ${selected.length} (${selected.map((c) => c.name).join(', ')}).`;
    const presentNote = alreadyPresent.length > 0 ? ` Already present: ${alreadyPresent.join(', ')}.` : '';
    const skippedNote =
      skipped.length > 0 ? ` Skipped: ${skipped.map((s) => `${s.remoteName} (${s.reason})`).join(', ')}.` : '';
    await vscode.window.showInformationMessage(`${importedNote}${presentNote}${skippedNote}`);
  }

  const govardFoldersListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void importGovardRemotes(false).catch(() => {});
  });

  context.subscriptions.push(
    output,
    treeView,
    internalFileClickDisposable,
    dirtyDecorationRegistration,
    saveListener,
    tmpStatusBar,
    editorSwitchListener,
    sessionReleaseListener,
    // Pooled sockets and idle timers are extension-host resources: dropping
    // them here keeps a window reload from orphaning live connections.
    { dispose: () => void pool.dispose() },
    vscode.commands.registerCommand('gangway.downloadFile', runDownloadFileCommand),
    vscode.commands.registerCommand('gangway.uploadFile', (nodeOrLocalPath?: RemoteTreeNode | string, remotePathArg?: string) => runUploadFileCommand(nodeOrLocalPath, remotePathArg)),
    vscode.commands.registerCommand('gangway.manageRemotes', () => openManageRemotesPanel(getActiveConnection())),
    vscode.commands.registerCommand('gangway.pickConnection', async () => {
      // VS Code has no built-in <select> inside a TreeView, and a
      // QuickPick is the idiomatic way to let the user pick one of
      // several named things.
      type PickItem = vscode.QuickPickItem & { connectionId?: string; action?: 'add' | 'manage' };
      const items: PickItem[] = [
        ...connectionManager
          .list()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(
            (c): PickItem => ({
              label: c.name,
              description: `${c.username}@${c.host}:${c.port}`,
              detail: c.remotePath,
              connectionId: c.id,
            }),
          ),
        { label: '$(add) Add New Remote...', action: 'add' },
        { label: '$(gear) Manage Remotes...', action: 'manage' },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a connection to bind to this workspace',
      });
      if (!picked) return;
      if (picked.action === 'add') {
        openManageRemotesPanel();
        return;
      }
      if (picked.action === 'manage') {
        openManageRemotesPanel(getActiveConnection());
        return;
      }
      if (!picked.connectionId) return;
      await connectionManager.setWorkspaceBinding(picked.connectionId);
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('gangway.cleanupCache', async () => {
      // Explicit user gesture, so it intentionally bypasses the default
      // 7-day retention window (`retentionDays = 0` purges everything whose
      // recorded age is not in the future, which in practice is every tmp
      // file for this connection). That includes files with no sidecar yet
      // -- a download genuinely still in flight, or one that crashed
      // mid-stream -- since purgeExpiredTmp() cannot tell those apart from an
      // abandoned one. This command is "empty the cache for this
      // connection", not "sweep only what's expired"; run it while a
      // transfer is in progress at your own risk.
      const connection = requireActiveConnection();
      if (connection) await purgeExpiredTmp(tmpRootFor(connection), 0);
    }),
    vscode.commands.registerCommand('gangway.downloadFolder', runDownloadFolderCommand),
    vscode.commands.registerCommand('gangway.uploadFolder', runUploadFolderCommand),
    vscode.commands.registerCommand('gangway.compareFile', runCompareFileCommand),
    vscode.commands.registerCommand('gangway.newFile', (node?: RemoteTreeNode) => runNewRemoteCommand('file', node)),
    vscode.commands.registerCommand('gangway.newFolder', (node?: RemoteTreeNode) => runNewRemoteCommand('dir', node)),
    vscode.commands.registerCommand('gangway.renameRemote', runRenameRemoteCommand),
    vscode.commands.registerCommand('gangway.deleteRemote', runDeleteRemoteCommand),
    vscode.commands.registerCommand('gangway.duplicateRemote', runDuplicateRemoteCommand),
    vscode.commands.registerCommand('gangway.chmodRemote', runChmodRemoteCommand),
    vscode.commands.registerCommand('gangway.cutEntries', (node?: RemoteTreeNode | RemoteTreeNode[]) => runCutCopyCommand(true, node)),
    vscode.commands.registerCommand('gangway.copyEntries', (node?: RemoteTreeNode | RemoteTreeNode[]) => runCutCopyCommand(false, node)),
    vscode.commands.registerCommand('gangway.pasteEntries', runPasteEntriesCommand),
    vscode.commands.registerCommand('gangway.restoreFromTrash', runRestoreFromTrashCommand),
    vscode.commands.registerCommand('gangway.emptyTrash', runEmptyTrashCommand),
    vscode.commands.registerCommand('gangway.refreshExplorer', () => treeProvider.refresh()),
    vscode.commands.registerCommand('gangway.importGovardRemotes', () => importGovardRemotes(true)),
    govardFoldersListener,
  );

  // Prompt-once auto-detect: a workspace that already knows its servers via
  // govard should not make the user retype them. Silent by construction when
  // there is nothing new (or no govard file at all). The folder list is
  // snapshotted synchronously here: the scan body awaits (dynamic import,
  // file reads), and folders appearing after activate must not leak into a
  // scan that started before them -- later changes arrive through the
  // folder-change listener above, which reads live.
  void importGovardRemotes(false, [...(vscode.workspace.workspaceFolders ?? [])]).catch(() => {});

  // Exported so tests (Task 19's E2E in particular) can set up a real
  // connection through the same modules the connection form itself uses,
  // without needing to drive the Webview UI from an automated test.
  return { connectionManager, secrets };
}

export function deactivate(): void {
  // Pooled sockets and idle timers are dropped through context.subscriptions
  // (see activate()); nothing else outlives a command today, so deactivation
  // needs no extra work.
}
