# Publishing

Gangway ships one VSIX to two registries:

| Registry | Audience | Auth |
|---|---|---|
| [Open VSX](https://open-vsx.org/extension/ddtcorex/gangway) | VSCodium, Gitpod, Theia, Eclipse Che | `OVSX_PAT` repository secret |
| [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ddtcorex.gangway) | Microsoft VS Code | Microsoft Entra ID through `azure/login@v3`, no stored secret |

`release.yml` publishes to Open VSX, then to the Marketplace, then creates the
GitHub Release. Nothing repackages in between, so both registries get identical
bytes.

The Marketplace steps are gated on the repository variable
`MARKETPLACE_PUBLISH`. While that variable is unset, a tag still publishes to
Open VSX and creates the GitHub Release, and the Marketplace steps are skipped.
Set it to `true` once the checklist below is done.

## What the repository already satisfies

- Publisher `ddtcorex` exists on the Marketplace and matches the `publisher`
  field in `package.json`. The ID cannot be changed after creation.
- The extension name `ddtcorex.gangway` is still unused.
- `README.md`, `LICENSE`, and `CHANGELOG.md` sit at the repository root, and
  `repository` is an HTTPS URL, so `vsce` rewrites relative links against
  GitHub `main`.
- `media/icon.png` is a 128x128 PNG (the minimum) and `media/icon@2x.png` is
  256x256.
- `.vscodeignore` keeps `src/`, `test/`, `docs/`, `out/`, `AGENTS.md`,
  `SECURITY.md`, and the CI files out of the package.
- The README badges are remote SVGs from GitHub Actions and shields.io.
  `vsce` rejects local SVG assets, not remote badge providers, and packaging
  the current README succeeds.

## Marketplace authentication with Microsoft Entra ID

### Why not the Marketplace trusted publishing flow

`vsce publish --oidc` exists in `@vscode/vsce` 4.0.0, but the Marketplace has
no configuration surface for the trust policy it needs, so there is nothing to
trust the token yet. It is also hidden from `vsce publish --help` and was
merged as an unannounced option. If Microsoft exposes the policy page later,
tracked in
[microsoft/vscode-vsce#1275](https://github.com/microsoft/vscode-vsce/issues/1275),
the `azure/login` step below could be replaced with `--oidc`. Until then this
repository does not use it.

### Checklist

Every step is one time.

**0. Check what you already have**

- An Entra ID tenant you control. The app registration below lives in that
  tenant and cannot be moved. Creating a *new* workforce tenant requires being
  a paid customer, so if you have no tenant at all you must sign up for an
  Azure account first (identity verification asks for a card, the free tier
  itself does not charge). An existing tenant is enough, and app registrations
  are free.
- Permission to create app registrations: being the owner of the app, or
  holding Application Administrator, Cloud Application Administrator, or
  Global Administrator.

**1. Create the app registration**

Entra admin center (<https://entra.microsoft.com>) → **App registrations** →
**New registration**. Name it `gangway-marketplace-publisher`, keep it
single-tenant, leave the redirect URI empty. Record the
**Application (client) ID** and the **Directory (tenant) ID**.

**2. Add a federated credential**

In that app: **Certificates & secrets** → **Federated credentials** →
**Add credential** → scenario **GitHub actions deploying Azure resources**.
Fill in:

| Field | Value |
|---|---|
| Organization | `ddtcorex` |
| Repository | `gangway` |
| Entity type | **Environment** |
| Environment name | `marketplace` |
| Name | `github-gangway-marketplace` |

Leave the optional GitHub owner ID and repository ID fields **empty**. If they
are filled, the subject becomes
`repo:ddtcorex@<org-id>/gangway@<repo-id>:environment:marketplace`, a form the
GitHub token never contains, and every token exchange fails.

The three fields that matter must end up as:

```text
issuer    https://token.actions.githubusercontent.com
subject   repo:ddtcorex/gangway:environment:marketplace
audience  api://AzureADTokenExchange
```

CLI equivalent, if you prefer it over the portal:

```sh
cat > credential.json <<'JSON'
{
  "name": "github-gangway-marketplace",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:ddtcorex/gangway:environment:marketplace",
  "description": "Gangway release workflow Marketplace publish",
  "audiences": ["api://AzureADTokenExchange"]
}
JSON
az ad app federated-credential create --id <app-object-id> --parameters credential.json
```

**3. Create the GitHub environment and variables**

- Repository **Settings → Environments → New environment**, name it
  `marketplace`. Add required reviewers if you want the publish to wait for a
  human.
- Repository **Settings → Secrets and variables → Actions → Variables**, add
  `AZURE_CLIENT_ID` (the Application client ID) and `AZURE_TENANT_ID` (the
  Directory tenant ID). These are identifiers, not secrets, so variables are
  the right place.
- Leave `MARKETPLACE_PUBLISH` unset until step 6.

**4. Resolve the publisher member profile id**

Run **Actions → Marketplace identity → Run workflow**. That workflow signs in
with the federated credential and prints the profile id in the job summary. A
green run also proves the federated credential matches; a red one fails with
`AADSTS700213` and reports the subject it saw.

**5. Add the identity to the publisher**

Open <https://marketplace.visualstudio.com/manage>, select the `ddtcorex`
publisher, open **Members**, and add the profile id from step 4 with the
**Contributor** role. The member is that profile id, not the client id.

**6. Turn the gate on**

Set the repository variable `MARKETPLACE_PUBLISH` to `true`.

**7. Tag a release**

`release.yml` now publishes to both registries.

### What the workflow runs

```yaml
      - name: Sign in for Marketplace publishing
        if: vars.MARKETPLACE_PUBLISH == 'true'
        uses: azure/login@v3
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          allow-no-subscriptions: true

      - name: Publish to VS Code Marketplace
        if: vars.MARKETPLACE_PUBLISH == 'true'
        run: pnpm dlx --allow-build=@vscode/vsce-sign @vscode/vsce publish --packagePath gangway.vsix --azure-credential --skip-duplicate
```

`azure/login@v3` signs the Azure CLI in with the federated credential, and
`allow-no-subscriptions: true` is required because this tenant has no Azure
subscription. `vsce --azure-credential` then reuses that CLI session: the
credential chain in `src/auth.ts` is `EnvironmentCredential`, then
`AzureCliCredential`, then `ManagedIdentityCredential`. There is no client
secret to store, and the environment binding is what the Marketplace trusts.

Notes:

- The subject is matched **case sensitively** and wildcards are not supported.
  An app can hold at most 20 federated credentials.
- The `marketplace` environment can require reviewers, which turns the publish
  into a human-gated step.
- Nothing needs rotating. Renaming the repository or the environment means
  editing the federated credential.

## Open VSX

Unchanged. `OVSX_PAT` is a repository secret holding the Open VSX access token
for the `ddtcorex` namespace.

## Personal Access Token (fallback for the Marketplace)

Still works until **2026-12-01**, after which Azure DevOps decommissions all
global PATs. It also needs an Azure DevOps organization, and creating a new
organization now requires an active Azure subscription.

1. Azure DevOps → **User settings → Personal access tokens → New Token**.
2. Organization **All accessible organizations** (this is what makes it a
   global PAT), scope **Show all scopes → Marketplace → Manage**.
3. Store it as the repository secret `VSCE_PAT`, or log in locally with
   `pnpm dlx @vscode/vsce login ddtcorex`. On Linux the credential store needs
   `secret-tool`, otherwise set `VSCE_STORE=file`.
4. Publish with `-p "$VSCE_PAT"` instead of `--azure-credential`.

## Publishing a version that is already tagged

Use this when a tag predates the Marketplace steps, or to recover a failed one
without cutting a new version. On a laptop, `--azure-credential` uses whoever
`az login` signed in as, so that account must itself be a member of the
publisher with publish rights.

```sh
cd /home/kai/Work/htdocs/maestro-harness/gangway
gh release download v0.4.1 --pattern gangway.vsix --clobber
az login
pnpm dlx --allow-build=@vscode/vsce-sign @vscode/vsce publish --packagePath gangway.vsix --azure-credential --skip-duplicate
```

In CI, re-dispatch the release workflow after fixing the cause. Both publish
steps pass `--skip-duplicate`, so re-running a tag is idempotent.

## Version rules

- The Marketplace rejects a version that already exists, and a deleted version
  number cannot be reused.
- The latest published version cannot be deleted.
- `package.json` version must equal the tag minus its `v`, enforced by the
  version gate in `release.yml`.
- Bump before the tag. Open VSX and the Marketplace track versions
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

Every registry in this stack lags after a successful publish, so treat a
missing version as "not yet" for a few minutes before treating it as a failure.
The listing page is
<https://marketplace.visualstudio.com/items?itemName=ddtcorex.gangway>.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `AADSTS700213` or `AADSTS7002138`: no matching federated identity record | The credential subject does not match the token. Compare with the `subject claim` printed in the run log under "Federated token details". Usual causes: wrong case, a Branch or Tag entity instead of Environment, or the optional owner/repository ID fields were filled when the credential was created. |
| `Can not acquire a Microsoft Entra ID access token` | `azure/login@v3` did not run before the publish step, or `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` are unset. |
| Marketplace rejects the publish with 401 or a permission error | The identity behind the token is not a member of the publisher, or not as Contributor. Re-run **Marketplace identity** and compare its profile id with the member entry. |
| Marketplace step is skipped | `MARKETPLACE_PUBLISH` is not `true`. |
| The job sits waiting | The `marketplace` environment has pending required reviewers. |
| `ERROR The extension 'ddtcorex.gangway' already exists` | Same version published twice. The workflow already passes `--skip-duplicate`. |
| `ERR_PNPM_IGNORED_BUILD_SCRIPTS` or a missing `@vscode/vsce-sign` binary | pnpm 11 blocks dependency build scripts. Pass `--allow-build=@vscode/vsce-sign`. |
| Publish rejected for an SVG | A local SVG was added to `README.md`, `CHANGELOG.md`, or the icon. Remote badges are fine. |

## Related

- [`docs/testing.md`](./testing.md) for the gates that must be green before a
  tag is pushed.
- [`AGENTS.md`](../AGENTS.md) for the architecture map and coding standard.
