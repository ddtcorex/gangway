# Gangway

[![CI](https://github.com/ddtcorex/gangway/actions/workflows/ci.yml/badge.svg)](https://github.com/ddtcorex/gangway/actions/workflows/ci.yml)
[![Open VSX](https://img.shields.io/open-vsx/v/ddtcorex/gangway)](https://open-vsx.org/extension/ddtcorex/gangway)
[![Open VSX downloads](https://img.shields.io/open-vsx/dt/ddtcorex/gangway)](https://open-vsx.org/extension/ddtcorex/gangway)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Single-file SFTP hotfix editing for VS Code: browse a remote server, edit one
file locally, and push it back explicitly. No sync daemon, no folder
mirroring, no auto-upload. You decide exactly when a change goes live.

## Why

Sometimes you need to fix one file on a server right now: a config value, a
broken template, a stray typo in production. Gangway gives you that one-file
deployment workflow inside VS Code instead of `vim` over raw `ssh`, or a full
sync tool built for a workflow you do not need.

## Install

Gangway is published on [Open VSX](https://open-vsx.org/extension/ddtcorex/gangway),
the registry used by VSCodium, Gitpod, Theia and Eclipse Che:

- **VSCodium and other Open VSX clients:** install `Gangway` from the
  Extensions view, or run `codium --install-extension ddtcorex.gangway`.
- **Microsoft VS Code:** Gangway is not on the VS Code Marketplace yet, so
  install the VSIX from the
  [latest GitHub release](https://github.com/ddtcorex/gangway/releases/latest):

  ```sh
  code --install-extension gangway.vsix
  ```

  Add `--force` to reinstall or to downgrade over an installed version. The
  same VSIX is downloadable from
  [Open VSX](https://open-vsx.org/extension/ddtcorex/gangway).

## Requirements

- VS Code 1.90 or newer.
- An SSH/SFTP-accessible server plus credentials (password, private key, or
  SSH agent).

## Quickstart

1. Open the **Gangway** icon in the Activity Bar (view: **Remote Hosts**).
2. Click **Manage Remotes** and add a connection (host, username, auth
   method, remote path). Use **Test** to verify the draft before saving.
   Connections can be scoped to the current workspace only, or be available
   globally across every workspace.
3. Browse the remote tree. **Double-click** a file to download and open it
   locally.
4. Edit normally, like any local file.
5. Press **Alt+Shift+Q** (**Option+Shift+Q** on macOS) to upload your changes
   back to the server.
6. Optional: add **path mappings** (workspace folder to remote path) on the
   connection form to enable workspace-wide sync.

## Keybindings

| Keybinding | Command | What it does |
|---|---|---|
| `Alt+Shift+Q` (`Option+Shift+Q` on macOS) | `Gangway: Upload Local Changes to Server` | Uploads the Gangway file open in the active editor. |
| `Alt+Shift+W` (`Option+Shift+W` on macOS) | `Gangway: Download from Server to Edit` | Re-downloads the Gangway file open in the active editor, discarding local edits. It asks for no confirmation, so check what you have open before pressing it. |
| `Ctrl+Alt+Shift+X` (`Cmd+Alt+Shift+X` on macOS) | `Gangway: Upload to Mapped Remote` | Uploads the mapped workspace file open in the active editor. |

All three fire only with an active editor holding a local file
(`editorTextFocus && resourceScheme == file`). Everything else is on the
remote tree's context menu or in the Command Palette under `Gangway:`.

## Features

- **Manual push only.** Nothing uploads until you press the upload keybinding
  or run the command, so there is never an autosave-triggered surprise.
- **Remote file and folder ops.** Create, rename, duplicate, and `chmod`
  files and folders from the remote tree's context menu.
- **Delete is permanent.** Remote deletes have no undo and no trash: the
  confirm says so, and folders additionally require typing the name. Uploads
  overwrite directly, with no server-side backup copy.
- **Clipboard and drag and drop.** Cut, copy, and paste entries inside the
  remote tree, or drop files from the local Explorer or the OS onto a remote
  folder to upload them. `Copy Remote Path` grabs a server path for the
  terminal.
- **Freeze production.** Toggling freeze on a connection refuses every
  mutating op until it is unlocked. Govard `protected` remotes import frozen.
- **Sync with preview.** Sync a folder, or the whole workspace via path
  mappings, up or down after a diff preview, with `excludePatterns` support.
- **Path mappings.** Map workspace folders to remote paths per connection;
  workspace sync follows them.
- **Test connection.** The connection form dials a draft (15s bound) before
  saving, so typos fail fast instead of at first use.
- **Folder transfers.** Download or upload an entire remote folder from its
  context menu.
- **Compare with server.** Diff your local copy against a fresh pull from the
  server before deciding whether to push or discard.
- **Compare workspace with server.** Right-click a workspace file for a
  read-only diff against the mapped server path. It is for looking only, and
  offers no upload or download afterwards.
- **Mapped sync.** Right-click a workspace file or folder to push it to (or
  pull it from) the mapped remote path: one confirm, direct overwrite. The
  same trip in reverse is on a remote file or folder, into the mapped
  workspace folder. `Ctrl+Alt+Shift+X` does the push for the mapped file open
  in the editor. Zero-config: the first workspace folder maps to the
  connection path. A pulled file keeps its existing local mode when it already
  exists, and a fresh destination gets the default.
- **Conflict detection.** Uploading is refused, not silently overwritten, if
  the server copy has changed since you downloaded it.
- **Edit-session awareness.** If the same file is already open for editing in
  another Gangway session (another VS Code window), you are warned before
  opening a second one, instead of silently risking conflicting edits.
- **Govard import.** Projects using [Govard](https://github.com/ddtcorex/govard)
  can import its `.govard.yml` remotes as Gangway connections in one click.
- **Workspace or global connections.** Save a connection for just the current
  project, or make it available everywhere.

## Where local copies live

- A downloaded file is written under the OS temp directory, at
  `<os.tmpdir()>/vs-sftp/<connection-slug>/...`, mirroring its path below the
  connection's remote root. The slug hashes host, username, port, and remote
  path, so two connections to the same server but different roots never share
  files.
- A `.meta.json` sidecar next to each file records the connection and remote
  path it came from. The wrong-server guard uses it: an upload from a file
  that belongs to another connection stops before any network call.
- On activation Gangway purges temp copies older than 7 days. **Gangway:
  Cleanup Cache** removes every temp copy for the current connection right
  away.
- Nothing is left behind on the server: no trash directory, no backup copy,
  no hotfix residue.

## Configuration

Gangway contributes no VS Code settings. Everything is per connection, edited
in **Manage Remotes**:

| Field | Effect |
|---|---|
| Name, host, port, username, auth method | The connection target. Credentials go to VS Code `SecretStorage`, never to a settings file. |
| Remote path | The root Gangway may read and write. Every operation is contained to it. |
| Scope | Keep the connection for the current workspace only, or make it global. |
| Path mappings | Workspace folder to remote path pairs, used by workspace sync and by every "Mapped Remote" command. |
| `excludePatterns` | Glob patterns skipped by sync. The default covers `.git/**`, `node_modules/**`, `var/**`, `pub/media/**`. |
| Frozen | Refuses every mutating operation until unlocked. Govard `protected` remotes import frozen. |

## Development

```sh
pnpm install          # frozen lockfile in CI
pnpm build            # esbuild -> dist/extension.js (the shipped artifact)
pnpm verify           # tsc --noEmit
pnpm test             # vitest unit suite
pnpm run build:e2e && pnpm run test:e2e   # real extension host, needs the docker sftp fixture + a display
```

- [docs/testing.md](./docs/testing.md) is the QA standard: test layers, the
  docker-integration and e2e gates, and the incidents behind each rule.
- [CHANGELOG.md](./CHANGELOG.md) records every release.
- [AGENTS.md](./AGENTS.md) is the architecture map and coding standard.
- Branches are `feat/<topic>` or `fix/<topic>` plus a PR into `master`; CI must
  be green before merge.

## Known limitations

- Manual workflow by design: no auto-upload, no folder watching, no background
  sync. Every transfer is an explicit action, and remote changes are never
  watched.
- No support for OS keychain-backed key passphrases beyond what
  `ssh2-sftp-client` itself provides.
- Distributed on Open VSX only for now. Publishing to the VS Code Marketplace
  needs an Azure DevOps publisher account with a card on file; the release
  workflow is ready to add it as a second target.

## License

[MIT](./LICENSE)
