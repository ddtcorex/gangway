# Gangway Implementation Review — 2026-09-18

- Spec: `maestro-harness/docs/specs/2026-09-16-gangway-design.md` (commit `7cdcd9f`)
- Code: `ddtcorex/gangway` master @ `e34c483` (64 commits)
- Method: three parallel focused reviews (transfer core vs §2.3, guard+UI vs
  §§2.2/2.4/3, security+errors vs §§4/5) + full unit suite locally.
- Baseline: `tsc --noEmit` clean, **195/195 vitest suites pass** (27 files).

## Verdict

Solid, spec-faithful V1 core. The safety-critical paths — Conflict Guard with
mandatory diff, SecretStorage-only secrets, host-key TOFU, no auto-upload,
atomic upload via temp+rename — all PASS with tests. The gaps cluster in
**folder transfer** (§2.3: no remote mkdir, no per-file retry, dead size flag)
and **error-action wiring** (§5: buttons rendered but dead). No secret leaks
found. Nothing here questions the architecture; everything below is fixable
without redesign.

## Must-fix before V1 (ordered by severity)

1. **[HIGH] Status-bar item leak** — `src/extension.ts:343` creates a new
   `StatusBarItem` on every download, never disposed or pushed to
   `context.subscriptions`. Fix: keep one item, update text on
   `onDidChangeActiveTextEditor`, dispose via subscriptions.
2. **[MED] Folder upload has no failure isolation** — first per-file error
   aborts the whole queue to a generic message (`src/ui/folderTransferCommands.ts:42-105`,
   `src/extension.ts:499-502,566-569`). Spec §2.3 requires per-file
   done/failed report in Output + Retry-failed. Fix: per-file try/catch,
   `failed[]` list, reconnect, retry offer. Same area: files with no sidecar
   or no local mirror upload blindly or crash with ENOENT
   (`src/extension.ts:523-541`) — skip-with-report instead.
3. **[MED] Dead error-action buttons** — all four `showErrorMessage` call
   sites (`src/extension.ts:178,348,419,501`) discard the user's choice, so
   Retry / Open Output / Disconnect do nothing. Spec §5. Fix: branch on the
   choice (retry command, `output.show()`, pool evict).
4. **[MED] Stale pooled client reuse** — cache hit never health-checks
   (`src/transfer/connectionPool.ts:133-137`); after a drop every later
   command reuses the dead client, with no evict-on-error path. Fix: evict +
   retry once on failure. Related: concurrent first-calls orphan a client
   (cache the in-flight promise), failed connects never `end()` the client,
   `dispose()` aborts on the first rejecting `end()` (use `allSettled`).
5. **[MED] Missing remote mkdir on folder upload** — no remote-mkdir call
   exists; new local dirs are never created remotely. Also: empty remote dirs
   are lost on folder download (walk collects files only).
6. **[MED] Orphaned keychain secrets on delete** — `deleteConnection` never
   calls `secrets.delete` (`src/ui/connectionFormPanel.ts:159-173`); removed
   passwords/passphrases stay in the OS keychain. Same on auth-method switch.
7. **[MED] Missing Compare/Refresh commands** — spec §2.2 requires per-node
   Download / Upload-overwrite / Compare / Refresh; only download-file,
   download-folder, upload-folder exist. `refresh()` exists on the provider
   but nothing calls it post-transfer.

## Should-fix (correctness / spec fidelity)

- **No keep-alive option** is set on connect (`src/authResolver.ts:43-50`,
  pool merge); an idle client can die server-side before the 60s idle evict.
  Pool is keyed per `connection.id`, spec says per server — keep the code
  (matches multi-connection use), amend the spec wording.
- **`>5MB`/binary prompt flag is dead** — `promptBeforeAutoOpen` is computed
  but never consumed, and real size never reaches it (`mapListingToEntries`
  hardcodes `size: 0`, `src/transfer/sftpClientAdapter.ts:20-23` has no size
  field). Either wire it (needs size from `stat`) or drop the flag.
- **No symlink-download warning** in the folder handler (flag exists,
  handler ignores it); single file always auto-opens with no binary check.
- **keepServer path leaves the "M" badge stale** — no
  `dirtyDecorations.refresh()` after discarding local edits
  (`src/extension.ts:403-407`).
- **Explicit-args upload path** skips the sidecar-connectionId wrong-server
  check that the no-args path performs (`src/extension.ts:351-390`).
- **Local-path concat via string slice** (`src/extension.ts:529,537,556`)
  breaks on Windows separators and bypasses the `tmpPath` containment check —
  use `path.join` + `tmpFilePathFor`.
- **Cleanup purges only the bound connection's root**, spec reads like a
  global purge — clarify wording either side.
- **120s readyTimeout x 3 attempts ~= 6 min block** on black-holed hosts with
  no progress/cancel (`src/transfer/connectionPool.ts:41-51`) — documented as
  deliberate in code; surface it in UX or shorten.
- **Over-broad `4xx` regex + raw server-text echo** in
  `src/errorMapper.ts:44-45` — anchor to SFTP status phrasing, add a
  credential-token redactor.
- **Host-key store keyed on raw `host:port`** (no case/trailing-dot/IPv6
  normalization) — same host re-prompts under a different spelling.
- **Corrupt sidecar JSON throws** — only ENOENT is handled on read; a partial
  write (write itself is non-atomic) crashes the caller. Atomic-write +
  corrupt-tolerant read.

## Accepted spec deviations (amend spec, not code)

- Explorer lives in the **left activity bar** (`viewsContainers.activitybar`),
  not the right sidebar. VS Code exposes no right-side container id; the
  activity-bar container is the correct native choice.
- Pool keyed per connection, not per server (fits the connection library).
- No auth-method fallback — code correctly implements the reviewed spec
  (§4: exact selected method only).
- No bulk "Overwrite all" in folder upload — correctly removed in spec review.
- Webview "origin check" is unimplementable (`onDidReceiveMessage` exposes no
  origin); nonce + CSP is the applicable gate. Incoming host->webview
  messages should still be validated.

## Test gaps to close (feeds `docs/qa.md`)

- Status-bar lifecycle (update/dispose/editor-switch) — untested (leak
  escaped because of this).
- Folder upload with missing local mirror / missing sidecar.
- keepServer refreshing the dirty decoration.
- `secrets.delete` on connection delete / auth-switch; a test asserting
  serialized configs exclude secrets; a test feeding secret-bearing errors
  through the error mapper + Output sink.
- Idle-evict/dispose, concurrent `getClient`, stale-client-after-failure,
  corrupt-sidecar reads (all need fake timers / fault injection).
- `promptBeforeAutoOpen`/size mapping (flag currently untestable-by-design).
- `verify-webview.mjs` is manual-only — wire into CI or the e2e job.
- E2E (docker sftp + `@vscode/test-electron`, guarded by the 15-min
  watchdog after the 2026-09-17 11-hour hang) is not yet running in CI.

## Process notes

- All 64 commits landed directly on `master` with no branch/PR review. From
  here: `feat/<topic>` branches + PR + green CI before merge (see AGENTS.md).
- No `AGENTS.md`, README, CHANGELOG, or CI existed at review time — added on
  `feat/harness-standards` with this report.
