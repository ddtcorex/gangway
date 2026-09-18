# Gangway QA Standard

Applies to every change in this repo. CI enforces the gates; this document
defines what "tested" means here.

## 1. Test layers

| Layer | Runner | Scope | Gate |
|---|---|---|---|
| Unit | `vitest run` (`pnpm test`) | `test/**/*.test.ts` mirroring `src/`; `vscode` resolves to `test/mocks/vscode.ts` (see `vitest.config.ts`) | CI `verify` job, must be green |
| Docker-integration | `vitest run` + `test/fixtures/docker-compose.sftp.yml` (`atmoz/sftp`, port 2222) | Real `ssh2-sftp-client` semantics the mocks cannot express (rename-exists, partial `fastGet`, `stat` sizes) | Required locally for transfer changes; e2e job in CI |
| E2E | `pnpm run build:e2e && pnpm run test:e2e` (`@vscode/test-electron`, needs display — `xvfb-run` in CI) | Full hotfix flow: form → connect → download → edit → `Alt+Shift+Q` → verify bytes; conflict path with out-of-band server edit | CI `e2e` job, must be green |

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

## 3. Coverage expectations

- New modules: unit tests in the same commit, mirroring path.
- Bug fixes: a regression test that fails on the old code first (RED),
  then passes (GREEN). A fix without one is incomplete and will be sent
  back in review.
- Transfer/queue/guard changes: docker-integration or e2e evidence, not
  mocks alone — mocks encode the author's assumptions about SFTP, which is
  exactly what these tests must check.
- Webview changes: `scripts/verify-webview.mjs` (CSP/nonce) must pass;
  jsdom tests cover logic, not module/CSP behavior.

## 4. Pre-push checklist (also the merge requirement)

```sh
pnpm verify   # tsc --noEmit, clean
pnpm test     # 195+ unit tests, green (count grows; never shrinks silently)
pnpm build    # dist/extension.js rebuilds without errors
```

Transfer/queue/guard/webview changes additionally need the docker + e2e
pass. Push the branch, open a PR, wait for green CI + human approval —
never merge red, never merge unreviewed.
