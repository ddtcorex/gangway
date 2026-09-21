# Gangway QA Standard

Applies to every change in this repo. CI enforces the gates; this document
defines what "tested" means here.

## 1. Test layers

| Layer | Runner | Scope | Gate |
|---|---|---|---|
| Unit | `vitest run` (`pnpm test`) | `test/**/*.test.ts` mirroring `src/`; `vscode` resolves to `test/mocks/vscode.ts` (see `vitest.config.ts`) | CI `verify` job, must be green |
| Docker-integration | `vitest run` + `test/fixtures/docker-compose.sftp.yml` (`atmoz/sftp`, port 2223), enabled by `GANGWAY_SFTP` (`test/*.integration.test.ts`: remoteOps hard delete/direct overwrite, mapping sync, sync walk) | Real `ssh2-sftp-client` semantics the mocks cannot express (rename-exists, partial `fastGet`, `stat` sizes, numeric SFTP error codes) | Required locally for transfer changes; **not enforced in CI** — the `e2e` job starts the fixture but never exports `GANGWAY_SFTP`, so these files skip there. Run them by hand with the fixture up |
| E2E | `pnpm run build:e2e && pnpm run test:e2e` (`@vscode/test-electron`, needs display — `xvfb-run` in CI); the runner takes a suite list (`--grep <text>` selects one) | Both suites: the full hotfix flow (form → connect → download → edit → `Alt+Shift+Q` → verify bytes; conflict path with out-of-band server edit) and mapping-sync (all six mapped commands against the real server, includes honored, witness connection for server bytes) | CI `e2e` job, must be green |
| Webview (real browser) | `node scripts/verify-webview.mjs` (headless Chrome over CDP, needs `Emulation.setDeviceMetricsOverride` before any real-click test or `Input.dispatchMouseEvent` silently lands on the wrong pixel) | The Save button actually posts, for both password and key auth, driven with real mouse events against the shipped `dist/media` bundle — jsdom cannot execute a `<script type="module">` at all | CI `e2e` job (separate step), must be green |

`test/e2e/**` and `out/**` are excluded from the unit runner by config —
never fight that with CLI flags; extend the exclude list if a new
host-only dir appears.

## 2. Hard rules (learned from real incidents)

1. **E2E always has two timeouts.** The runner watchdog
   (`GANGWAY_E2E_TIMEOUT_MS`, default 15 min) fails loudly instead of
   hanging — added after a 2026-09-17 run wedged 11 hours on an unstubbed
   Electron modal. The CI job adds its own `timeout-minutes` backstop: the
   watchdog cannot reap the spawned VS Code process. Never raise either
   without fixing the underlying hang.
2. **Fixture seed data is gitignored and reset per run** (`resetFixture` in
   `test/runE2e.ts`). Tests mutate the fixture in place; a committed or
   stale fixture drifts after the first run and poisons every later one.
   Bind-mount gotcha: once the sftp container is up,
   `test/fixtures/sftp-data/` belongs to the container's user and a
   host-side write fails with EACCES — locally run
   `sudo chown -R $(id -u):$(id -g) test/fixtures/sftp-data`
   after `docker compose up` (CI does this automatically). Deeper: the
   container user must share YOUR uid or one side always loses write
   access (host seed EACCES vs container upload Permission denied) — the
   compose file parameterizes this via `E2E_SFTP_UID/GID` (default 1000);
   if your uid differs, start the fixture with
   `E2E_SFTP_UID=$(id -u) E2E_SFTP_GID=$(id -g) docker compose up`.
3. **Every user-visible error action is tested.** A `showErrorMessage`
   button whose choice is discarded shipped once (§5 review) — assert the
   branch taken per choice (retry command / output reveal / pool evict),
   not just that the message renders.
4. **Secrets get negative tests.** For every secret touchpoint assert:
   `secrets.delete` is called on connection delete and on auth-method
   switch; serialized configs contain no secret field; secret-bearing
   errors passed through `errorMapper` + the Output sink never contain the
   secret. The unit `SecretStorage` fake is instant — it cannot catch
   hangs, so timeout paths (`withTimeout`) are tested with deferred
   thenables, not the fake.
5. **Timeout/eviction paths use fake timers + fault injection**, never real
   sleeps: idle-evict, reconnect backoff, stale-client-after-failure,
   concurrent `getClient` dedup, corrupt-sidecar reads. If a flag exists
   (`promptBeforeAutoOpen`), a test must be able to fail on its absence —
   computed-but-unconsumed flags are dead code with passing tests.
6. **No test may depend on execution order or wall-clock dates**, except the
   retention tests which inject "now".
7. **A CDP coordinate-based click needs `Emulation.setDeviceMetricsOverride`
   set before `Page.navigate`, every time.** Without it, headless Chrome's
   default viewport does not line up with the coordinates
   `getBoundingClientRect()` reports, so `Input.dispatchMouseEvent` silently
   lands on the wrong pixel and the click never reaches anything -- no error,
   no console warning, just zero effect. `verify-webview.mjs` had this
   exact bug (found 2026-09-18: a plain `element.click()` worked, the real
   mouse click posted nothing) alongside a second, unrelated one --
   `buildConnectionFormHtml()` was called with only 4 of its ~17 required
   fields, and `{{TOKEN}}.replace()` coerces the missing ones to the literal
   string `"undefined"`, which corrupted the embedded `connections-data`
   JSON script tag and crashed `main.js` at `JSON.parse()` before the Save
   listener was ever attached. Both bugs predated this repo's CI entirely
   (the script was never wired into anything, so nobody ran it) -- it is now
   gated in CI's `e2e` job specifically so that stops happening again.
8. **A real SFTP server speaks numeric codes, never `ENOENT`.**
   `ssh2-sftp-client` surfaces failures like `'2'` (= NO_SUCH_FILE) with
   no `code`/`errno` fields, so any not-found check that only matches
   `ENOENT` passes against mocks and dies on the first live run (found
   2026-09-19: trash/inventory/sweep + the sync walk all broke in CI's
   e2e while every unit test stayed green). Centralize the spelling in
   one helper (`isNotFoundError`: `ENOENT` | `'2'` | `/no such file/`)
   and prove it with a docker-integration or e2e run -- mocks encode the
   author's assumption, which is exactly what is being tested.
9. **jsdom mocks can mask real-DOM behavior.** `test/mocks/vscode.ts` is
   not the only fake: any hand-rolled DOM stand-in (e.g. `children` as a
   plain Array) hides APIs the production DOM lacks
   (`HTMLCollection` has no `.find` -- found 2026-09-19, green in jsdom,
   thrown in the real form). Webview logic that touches the live DOM
   must pass `scripts/verify-webview.mjs`, not just jsdom.

## 3. Coverage expectations

- New modules: unit tests in the same commit, mirroring path.
- Bug fixes: a regression test that fails on the old code first (RED),
  then passes (GREEN). A fix without one is incomplete and will be sent
  back in review.
- Transfer/queue/guard changes: docker-integration or e2e evidence, not
  mocks alone — mocks encode the author's assumptions about SFTP, which is
  exactly what these tests must check.
- Webview changes: `scripts/verify-webview.mjs` (CSP/nonce/real-click Save
  flow) must pass -- gated in CI's `e2e` job, not just a local habit;
  jsdom tests cover logic, not module/CSP/real-click behavior.

## 4. Pre-push checklist (also the merge requirement)

```sh
pnpm verify   # tsc --noEmit, clean
pnpm test     # every unit test green (count grows; never shrinks silently --
              # don't hardcode the number here, it rots on the next PR)
pnpm build    # dist/extension.js rebuilds without errors
```

Transfer/queue/guard/webview changes additionally need the docker + e2e
pass. Push the branch, open a PR, wait for green CI + human approval —
never merge red, never merge unreviewed.
