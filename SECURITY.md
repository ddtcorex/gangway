# Security Policy

Gangway holds SFTP credentials and writes to live servers, so the security
surface that matters here is small but sharp.

## What counts as a vulnerability

- Credential handling: a password or key passphrase written outside VS Code
  `SecretStorage`, left behind after a connection delete or an auth-method
  switch, or leaked into a log, an error message, or a serialized config.
- Wrong-target writes: any way an upload lands on a server, path, or
  connection other than the one the user selected.
- Path containment: a remote listing or mapping that makes Gangway read or
  write outside the connection's configured remote root.
- Webview: a way to defeat the CSP or nonce of the connection form, or to
  execute injected content in its context.
- Supply chain: a dependency or build step that would ship unintended code in
  `dist/extension.js`.

## Reporting a vulnerability

Please do not open a public issue containing exploit details.

- Preferred: GitHub private vulnerability reporting. Open the repository's
  **Security** tab and click **Report a vulnerability**. If that button is not
  visible, it has not been enabled for this repository yet, so use the
  fallback below and it will be turned on.
- Fallback: open a public issue titled `Security contact request` with no
  technical detail beyond "I have a vulnerability report", and a private
  advisory will be opened for the details.

Include the Gangway version, your VS Code client and version, and the
smallest reproduction you can manage. Redact real hostnames, credentials, and
customer paths.

There is no bug bounty and no paid program. Reports are handled on a best
effort basis, with a fix released through the normal Open VSX flow and the
reporter credited in the release notes unless they prefer otherwise.

## Supported versions

Only the latest published version is supported. Because the extension is
distributed through Open VSX and GitHub releases, fixes ship as a new version
rather than as a patch to an old one.

## Design notes that are not vulnerabilities

- Manual push only: nothing uploads without an explicit command or keybinding.
- Remote deletes are permanent and uploads overwrite directly. There is no
  server-side trash or backup by design, and the confirmations say so.
- Downloaded copies are staged in the OS temp directory and purged after 7
  days (see the README). A local attacker with access to that directory is out
  of scope.
