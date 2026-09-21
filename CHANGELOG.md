# Changelog

All notable changes to the Gangway extension are documented in this file.

## [Unreleased]

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
