# Changelog

All notable changes to the Gangway extension are documented in this file.

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
