# Publishing

Gangway ships one VSIX to two registries:

| Registry | Audience | Auth |
|---|---|---|
| [Open VSX](https://open-vsx.org/extension/ddtcorex/gangway) | VSCodium, Gitpod, Theia, Eclipse Che | `OVSX_PAT` repository secret |
| [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ddtcorex.gangway) | Microsoft VS Code | GitHub Actions OIDC, no secret |

`release.yml` publishes to Open VSX, then publishes the same `gangway.vsix`
to the Marketplace, then creates the GitHub Release. Nothing repackages
between the two, so both registries get identical bytes.

## What the repository already satisfies

- Publisher `ddtcorex` exists on the Marketplace and matches the `publisher`
  field in `package.json`. The ID cannot be changed after creation.
- The extension name `ddtcorex.gangway` is still unused
  (`TotalCount: 0` from the gallery query below).
- `README.md`, `LICENSE`, and `CHANGELOG.md` sit at the repository root, and
  `repository` is an HTTPS URL, so `vsce` rewrites relative links against
  GitHub `main`.
- `media/icon.png` is a 128x128 PNG (the minimum is 128x128) and
  `media/icon@2x.png` is 256x256.
- `.vscodeignore` keeps `src/`, `test/`, `docs/`, `out/`, `AGENTS.md`,
  `SECURITY.md`, and the CI files out of the package.
- The README badges are remote SVGs from GitHub Actions and shields.io.
  `vsce` rejects local SVG assets, not remote badge providers, and packaging
  the current README succeeds.

## Trusted publishing with OIDC (the supported path)

`vsce publish --oidc` asks GitHub Actions for an OIDC token with the
`marketplace.visualstudio.com` audience and exchanges it at
`POST /_apis/gallery/token` for a short-lived credential. No PAT is stored,
and nothing expires on a calendar. Only GitHub Actions is supported as a
token provider.

This works with `@vscode/vsce` 4.0.0. The flag is registered with
`hideHelp`, so it does not appear in `vsce publish --help`; that is not the
same as unsupported.

### One-time setup

1. Sign in to <https://marketplace.visualstudio.com/manage> with the account
   that owns the `ddtcorex` publisher.
2. Open the publisher, find its trusted publishing configuration, and add a
   policy for this repository and workflow:
   - repository: `ddtcorex/gangway`
   - workflow: `.github/workflows/release.yml`
3. If the publisher settings expose no such option, use the Personal Access
   Token path below and open an issue with the Marketplace team.

### What the workflow does on a tag

`release.yml` already carries the two pieces this needs:

```yaml
permissions:
  contents: write
  id-token: write      # the OIDC token request, required by --oidc
```

```yaml
      - name: Publish to VS Code Marketplace
        run: pnpm dlx --allow-build=@vscode/vsce-sign @vscode/vsce publish --packagePath gangway.vsix --oidc --skip-duplicate
```

The Marketplace step sits immediately after the Open VSX publish, before the
GitHub Release. A policy mismatch fails that step and the run stops there, so
a release is not announced while the Marketplace is still missing. Both
publish steps pass `--skip-duplicate`, so re-running the same tag once the
policy is fixed is idempotent.

### Before the next tag

The run goes red at the Marketplace step until the trusted publishing policy
exists, and because that step comes before the GitHub Release, the next tag
stops there. Configure the policy first, or comment the step out for a single
release.

### After the first successful Marketplace publish

The README and the listing both predate the Marketplace listing, so they still
tell VS Code users to sideload the VSIX. Once the item page returns 200, drop
that wording from [Install](../README.md#install).

## Publishing a version that is already tagged

Use this when a tag predates the Marketplace step, or to recover a failed
step without cutting a new version.

```sh
cd /home/kai/Work/htdocs/maestro-harness/gangway
gh release download v0.4.1 --pattern gangway.vsix --clobber   # the exact tagged artifact
pnpm dlx --allow-build=@vscode/vsce-sign @vscode/vsce publish --packagePath gangway.vsix --oidc --skip-duplicate
```

`--oidc` needs a GitHub Actions environment, so run it from a workflow
dispatch or re-run the tag workflow instead of a laptop. On a laptop, use the
PAT path below.

## Personal Access Token (fallback)

The PAT path works today but is on a deadline: Azure DevOps retires global
PATs on 2026-12-01. It also needs an Azure DevOps organization, and creating
a new organization now requires an active Azure subscription.

1. Create a PAT in Azure DevOps with organization **All accessible
   organizations** and scope **Marketplace > Manage**.
2. Store it as the `VSCE_PAT` repository secret, or log in locally with
   `pnpm dlx @vscode/vsce login ddtcorex`. On Linux the credential store needs
   `secret-tool`, otherwise set `VSCE_STORE=file`.
3. Publish with `--pat` (or the `VSCE_PAT` environment variable) instead of
   `--oidc`, and add a `VSCE_PAT` secret to the workflow step.

A third option, `vsce publish --azure-credential`, uses Microsoft Entra ID
with a managed identity and an Azure DevOps service connection. It is the
better fit for Azure Pipelines than for this repository, and it still needs
an Azure subscription.

## Version rules

- The Marketplace rejects a version that already exists, and you cannot reuse
  a deleted version number.
- You cannot delete the latest published version.
- `package.json` version must equal the tag minus its `v`, enforced by the
  version gate in `release.yml`.
- Bump before the tag. The Marketplace and Open VSX track versions
  independently, so a version present on one registry can still be published
  to the other.

## Verify after publishing

```sh
pnpm dlx @vscode/vsce show ddtcorex.gangway

curl -s -X POST \
  -H "Accept: application/json;api-version=7.2-preview.1" \
  -H "Content-Type: application/json" \
  --data '{"filters":[{"criteria":[{"filterType":7,"value":"ddtcorex.gangway"}]}],"flags":914}' \
  https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery
```

Every other registry in this stack lags after a successful publish, so treat
a missing version as "not yet" for a few minutes before treating it as a
failure. The listing page is
<https://marketplace.visualstudio.com/items?itemName=ddtcorex.gangway>.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `GitHub Actions did not provide an OIDC token request URL and token` | The job lacks `permissions: id-token: write`. |
| `No supported OIDC provider was detected. OIDC publishing currently supports GitHub Actions only.` | `--oidc` was run outside GitHub Actions. |
| `Marketplace OIDC token exchange returned an invalid response without a credential` | The trusted publishing policy does not match this repository and workflow, or `publisher` in `package.json` is not the publisher the policy belongs to. |
| `ERROR The extension 'ddtcorex.gangway' already exists` | Same version published twice. `--skip-duplicate` is already passed by the workflow. |
| `ERR_PNPM_IGNORED_BUILD_SCRIPTS` or a missing `@vscode/vsce-sign` binary | pnpm 11 blocks dependency build scripts. Pass `--allow-build=@vscode/vsce-sign`. |
| Publish rejected for an SVG | A local SVG was added to `README.md`, `CHANGELOG.md`, or the icon. Remote badges are fine. |
| Extension missing right after a green workflow | Registry and listing lag. Re-check with the verification commands above. |

## Related

- [`docs/testing.md`](./testing.md) for the gates that must be green before a
  tag is pushed.
- [`AGENTS.md`](../AGENTS.md) for the architecture map and coding standard.
