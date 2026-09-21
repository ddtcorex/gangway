# Gangway

Single-file SFTP hotfix editing for VS Code: browse a remote server, edit
one file locally, push it back explicitly. No sync daemon, no folder
mirroring, no auto-upload — you decide exactly when a change goes live.

## Why

Sometimes you need to fix one file on a server right now: a config
value, a broken template, a stray typo in production. Gangway gives you
that one-file deployment workflow inside VS Code instead of `vim` over
raw `ssh`, or a full sync tool built for a workflow you don't need.

## Quickstart

1. Open the **Gangway** icon in the Activity Bar.
2. Click **Manage Remotes** and add a connection (host, username, auth
   method, remote path). Use **Test** to verify the draft before saving.
   Connections can be scoped to the current workspace only, or available
   globally across every workspace.
3. Browse the remote tree. **Double-click** a file to download and open
   it locally.
4. Edit normally, like any local file.
5. Press **Alt+Shift+Q** (**Option+Shift+Q** on macOS) to upload your
   changes back to the server.
6. Optional: add **path mappings** (workspace folder ↔ remote path) on the
   connection form to enable workspace-wide sync.

## Features

- **Manual push only.** Nothing uploads until you press the upload
  keybinding or command — never an autosave-triggered surprise.
- **Remote file & folder ops.** Create, rename, duplicate, and `chmod`
  files and folders from the remote tree's context menu.
- **Delete is permanent.** Remote deletes have no undo and no trash:
  the confirm says so, folders additionally require typing the name.
- **Clipboard + drag & drop.** Cut/copy/paste entries inside the remote
  tree, or drop files from the local Explorer/OS onto a remote folder to
  upload them. `Copy Remote Path` grabs a server path for the terminal.
- **Freeze production.** Toggling freeze on a connection refuses every
  mutating op until it is unlocked. Govard `protected` remotes import
  frozen.
- **Sync with preview.** Sync a folder — or the whole workspace via path
  mappings — up or down after a diff preview, with `excludePatterns`
  support.
- **Path mappings.** Map workspace folders to remote paths per
  connection; workspace sync follows them.
- **Test connection.** The connection form dials a draft (15s bound)
  before saving, so typos fail fast instead of at first use.
- **Folder transfers.** Download or upload an entire remote folder from
  its context menu.
- **Compare with server.** Diff your local copy against a fresh pull from
  the server before deciding whether to push or discard.
- **Compare workspace with server.** Right-click a workspace file for a
  read-only diff against the mapped server path — for looking only, with
  no upload/download offered afterwards.
- **Mapped sync.** Right-click a workspace file/folder to push it to (or
  pull it from) the mapped remote path — one confirm, direct overwrite.
  Right-click a remote file/folder for the same trip in reverse
  into the mapped workspace folder. Zero-config: the first workspace folder
  maps to the connection path. A pulled file keeps its existing local mode
  when it already exists (a fresh destination gets the default).
- **Conflict detection.** Uploading is refused, not silently overwritten,
  if the server copy has changed since you downloaded it.
- **Edit-session awareness.** If the same file is already open for
  editing in another Gangway session (another VS Code window), you're
  warned before opening a second one, instead of silently risking
  conflicting edits.
- **Govard import.** Projects using [Govard](https://github.com/ddtcorex/govard)
  can import its `.govard.yml` remotes as Gangway connections in one
  click.
- **Workspace or global connections.** Save a connection for just the
  current project, or make it available everywhere.

## Requirements

- An SSH/SFTP-accessible server and credentials (password, private key,
  or SSH agent).

## Known limitations

- Manual workflow by design — no auto-upload, no folder watching, no
  background sync. Every transfer is an explicit action; this is not a
  full sync tool and does not watch for remote changes.
- No support for OS keychain-backed key passphrases beyond what
  `ssh2-sftp-client` itself provides.

## License

[MIT](./LICENSE)
