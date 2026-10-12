# Changelog

All notable changes to the Gangway extension are documented in this file.

Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html), and
breaking changes are marked `BREAKING:`.

## [0.5.0] - 2026-10-12

- Fixed: opening a file that is itself a symlink failed with "Not a regular
  file". The SFTP library refuses anything whose own type is not a regular
  file, so the file is now fetched from its real path. Compare, conflict
  review and mapped pull read through a link the same way.
- BREAKING: dropping files from the local Explorer or the OS onto the remote
  tree no longer uploads them. Drag and drop is now a remote-only gesture;
  upload with the upload commands instead.
- Drag and drop inside the remote tree moves the dragged rows into the folder
  they are dropped on, with the same checks as cut and paste (freeze, the
  connection root, link rules, audit). It asks for confirmation unless
  `gangway.confirmDragAndDrop` is off, asks once when two or more items
  already exist at the destination (review each, skip them, or cancel; there
  is no overwrite-all), and refuses to move a folder into itself.
- The remote tree allows selecting several rows. Cut and copy act on the
  whole selection; every other command still acts on the row you clicked.
- Fixed: moving a file with cut and paste while it was open for editing left
  its local copy pointing at the old path, so a later push recreated the file
  there. The local copy now follows the move, like rename.
- Remote symlinks are supported in the tree: a directory link expands, a file
  link opens and edits like a file, and the tooltip shows the real target.
  Broken links and loops are dimmed and explain themselves on click (on
  OpenSSH a pair of links pointing at each other reports as "no such file",
  so it is shown as a broken link rather than a loop).
- On a restricted server that refuses `realpath` while `stat` works, a path
  is judged by its text, so a directory link leading outside the connection
  root cannot be detected there. The freeze check runs first and still
  blocks every write the freeze check normally covers on a frozen
  connection.
- Edits through a link are pushed to the real target with the usual temp and
  rename overwrite, so the link is never replaced by a regular file. A push
  is stopped if the link now points somewhere else than when it was opened,
  and an upload whose destination is itself a link is refused.
- Every mutating operation is gated on the resolved real path, and the
  connection root is resolved too. A target outside the root needs a
  confirmation naming the real path (remembered per file), and a frozen
  connection blocks it. Bulk uploads into a directory link outside the root
  are refused.
- Deleting a link removes only the link, never the target tree.
- The edit-session lock is keyed on the real path, so two links to one file,
  or a link and its target, warn each other.

## [0.4.2] - 2026-09-23

No runtime changes. First release published to the VS Code Marketplace:

- Releases now publish to the VS Code Marketplace with a Microsoft Entra ID
  identity federated to a GitHub environment, with no stored secret, alongside
  Open VSX.
- README install steps point Microsoft VS Code users at the Marketplace.
- README intro and the manifest description now cover mapped push and pull
  and the previewed folder sync, not only single-file hotfixes.
- `SECURITY.md` points at private vulnerability reporting and is no longer
  shipped in the VSIX.

## [0.4.1] - 2026-09-22

No runtime changes. This release refreshes the listing and the repository
metadata:

- README rewritten for the listing page: install steps for Open VSX and for
  the VSIX, a keybindings table, where local temp copies live and when they
  are purged, the per-connection configuration fields, and the dev commands.
- `SECURITY.md`, bug and feature issue templates, and a PR template added.
- Extension keywords widened for search.

## [0.4.0] - 2026-09-21

- `Ctrl+Alt+Shift+X` (`Cmd+Alt+Shift+X` on macOS) uploads the mapped
  workspace file open in the active editor, through the same mapping
  resolution, unmapped warning, and overwrite confirm as the
  `Upload to Mapped Remote` menu.

## [0.3.0] - 2026-09-21

- BREAKING: removed server-side trash and backup (no remote footprint) —
  deletes are permanent with no undo and uploads overwrite directly.

## [0.2.0] - 2026-09-21

- Remote file/folder ops from the tree context menu: new file/folder,
  rename, duplicate, `chmod`, cut/copy/paste, and drag & drop upload
  from the local Explorer/OS.
- Trash instead of delete: timestamped trash next to the remote root
  (`.gangway-trash-*`), restore-from-trash, explicit empty-trash
  (`EMPTY TRASH`), 30-day auto-sweep.
- Backup before overwrite: uploads stash the previous server copy under
  `.gangway-backup-*`.
- Freeze toggle per connection: mutating ops are refused while frozen;
  Govard `protected` remotes import frozen.
- Sync with preview: folder sync and workspace up/down with a diff
  preview and `excludePatterns`.
- Path mappings per connection (workspace folder ↔ remote path) backing
  workspace sync.
- Test-connection button on the add/edit form (15s bound draft dial).
- Context-menu refresh: 4 groups (clipboard/organize/transfer/danger),
  Paste on files, Restore from Trash in the folder menu, new Copy Remote
  Path command, `Sync Folder…` title.
- Mapped sync: `Upload to Mapped Remote` / `Download to Workspace` from the
  Local Explorer and `Download to Workspace Folder` from the Remote
  Explorer — one confirm, direct overwrite, no backup (the hotfix flow is
  unchanged).
- Workspace compare: `Compare Workspace with Server` from the Local
  Explorer — read-only `vscode.diff` of the workspace file against the
  server's fresh bytes (fetched under a cancellable progress notification,
  staged owner-only and atomically under tmp, kept for revisit), resolved
  through the active connection's mappings with the same unmapped warning
  as the mapped sync commands.

## [0.1.0] - 2026-09-18

Initial feature set:

- Single-file SFTP hotfix editing: browse, double-click to open, edit,
  `Alt+Shift+Q` to push.
- Folder download/upload from the remote tree's context menu.
- Compare-with-server diff view.
- Stat-based conflict detection on upload (no bulk overwrite).
- Cross-window edit-session awareness (warns before opening a file
  already open for editing in another Gangway session).
- Govard `.govard.yml` remote import.
- Workspace-scoped and global connection visibility.
