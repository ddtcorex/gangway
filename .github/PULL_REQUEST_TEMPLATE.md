## What changed

<!-- One paragraph. Link the issue this closes. -->

Closes #

## Test plan

- [ ] `pnpm verify`
- [ ] `pnpm test`
- [ ] `pnpm build` (or `pnpm run build:e2e` when e2e behavior changed)
- [ ] Transfer, queue, guard, or webview change: docker-integration evidence
      (`GANGWAY_SFTP=1 pnpm test` with the fixture up) or a real e2e run
- [ ] User-visible copy or docs changed: claims checked against the code

## Evidence

<!-- Paste the commands you ran and their result. "Should work" is not
     evidence; see docs/testing.md for what this repository accepts. -->

## Risk

<!-- What could break, what was not verified, and any follow-up this leaves. -->
