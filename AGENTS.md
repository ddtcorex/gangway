# AGENTS.md — Gangway

> `CLAUDE.md` at the repo root is a symlink to `AGENTS.md`. Only edit
> `AGENTS.md` — never edit `CLAUDE.md` directly or replace the symlink.

## Purpose

VS Code extension (`gangway`, publisher `ddtcorex`) for
**single-file SFTP hotfix editing**: browse the server, download one file to
`os.tmpdir()`, edit locally, push explicitly with `Alt+Shift+Q`. Manual push
only — never auto-upload. Design spec lives at the workspace meta root:
`maestro-harness/docs/specs/2026-09-16-gangway-design.md` (specs stay there
during development, never in this repo).

Public repo `ddtcorex/gangway`, but **not** part of the `dsh-maestro-*`
family: no npm publish, no Cordis rows, no `lib/` contract. The shipped
artifact is `dist/extension.js` (esbuild) via `vsce`.

## Layout

- `src/extension.ts` — `activate()`/`deactivate()`: command registration and
  wiring only. Keep orchestration in the modules below, not in handlers.
- `src/types.ts` — shared types (`ConnectionConfig` carries **no secrets**,
  `SidecarMeta`). `src/ssh2-sftp-client.d.ts` — local structural types for
  `ssh2-sftp-client` (do not import from the lib's internals).
- `src/transfer/` — `connectionPool.ts` (one pooled client per connection,
  60s idle evict, 3x backoff), `sftpClientAdapter.ts` (raw-listing mapping),
  `downloadFile.ts` (stage + atomic rename + sidecar write),
  `uploadFile.ts` (temp + rename + baseline refresh).
- `src/` transfer plumbing — `remoteListing.ts`, `folderQueue.ts` (recursive
  walk, abortable), `tmpPath.ts` (slug + containment), `tmpStore.ts`
  (sidecar), `tmpRetention.ts` (7-day auto-purge), `connectionManager.ts`
  (connections split across globalState/workspaceState by scope --
  'global' vs 'workspace', see `types.ts`'s `ConnectionScope` -- plus the
  workspace binding key), `govardImport.ts` (`.govard.yml` remote import,
  defaults to workspace scope), `editSession.ts` (cross-window edit-lock:
  warns before opening a file another live Gangway session already has
  open), `secretStore.ts` (SecretStorage only), `authResolver.ts` (exact
  selected method, no fallback), `hostKeyStore.ts` (TOFU), `conflictGuard.ts`
  (stat-compare, no bulk overwrite by design), `dirtyState.ts`,
  `errorMapper.ts` (human messages + actions), `auditLog.ts` (append-only
  upload log), `withTimeout.ts` (bounds on secret-store calls).
- `src/ui/` — `gangwayTreeProvider.ts` (lazy explorer, double-click to
  open), `connectionFormPanel.ts` + `connectionFormHtml.ts` +
  `media/connectionForm/` (Webview UI Toolkit form), `conflictResolution.ts`
  (fresh-copy diff flow), `folderTransferCommands.ts`,
  `dirtyDecoration.ts`, `statusBar.ts`, `cancellable.ts` (races a task
  against a VS Code cancellation token).
- `test/` — vitest suites mirroring `src/` (+ `mocks/vscode.ts`, aliased as
  `vscode` in `vitest.config.ts`); `test/e2e/` runs only inside a real
  extension host (excluded from vitest); `test/fixtures/` holds the docker
  sftp fixture (gitignored seed data, reset per run).
- `scripts/verify-webview.mjs` — real-browser CSP/nonce/Save-flow check for
  the form, gated in CI's `e2e` job (see `docs/testing.md`).
- `esbuild.js` → `dist/extension.js` (shipped). `tsc` → `out/` (e2e only).

## Commands

```sh
pnpm install          # frozen lockfile in CI
pnpm build            # esbuild -> dist/extension.js (ship this)
pnpm verify           # tsc --noEmit (must be clean before push)
pnpm test             # vitest run (unit; e2e excluded by config)
pnpm run build:e2e && pnpm run test:e2e   # needs docker sftp + display (xvfb in CI)
```

## Coding standard

- **English only** — identifiers, comments, user-facing copy, commits, PRs.
  (No exceptions; chat with the human may stay in Vietnamese.)
- **TypeScript `strict`, no eslint/prettier** — matches the harness Node
  family, which standardizes on `tsc --noEmit` + vitest instead of linters.
  Keep it that way; do not introduce a lint stack unilaterally.
- **Conventional Commits**, imperative mood (`feat(tree): …`). One logical
  change per commit; never commit while `verify`/`test` are red.
- **Branch discipline** — `feat/<topic>` / `fix/<topic>` + PR into `master`.
  Never commit directly to `master` (history before 2026-09-18 did; that
  ends here). Squash on merge. CI must be green before merge.
- **Secrets** — `SecretStorage` only; config objects must stay
  secret-free; never log secrets; `deleteConnection` and auth-method switch
  must delete orphaned secrets. Every error path carrying server text goes
  through `errorMapper` + a redactor.
- **Error actions must work** — a `showErrorMessage` button that discards the
  choice is a bug, not a TODO. Same for progress/cancel: if a command can
  block > ~5s, it gets `withProgress` + cancellation.
- **Webview** — Toolkit components only (no hand-rolled CSS theme), CSP +
  nonce on every load, validate incoming messages, never prefill secrets.
- **Tests live with the code** — `test/<area>/<file>.test.ts` mirrors
  `src/`; a fix without a regression test is incomplete (see `docs/testing.md`).
- **Superpowers workflow** for non-trivial changes: `brainstorming` →
  `writing-plans` → `executing-plans` (strict TDD: RED → GREEN per task,
  one commit per task).

## QA & CI

- QA standard: `docs/testing.md` (unit / docker-integration / e2e policy, E2E
  timeout rule, secret-leak tests).
- CI: `.github/workflows/ci.yml` (reusable `ddtcorex/dsh-maestro-ci`
  `node-plugin.yml` pin + dedicated e2e job). Green CI is a merge
  requirement, not a suggestion.
