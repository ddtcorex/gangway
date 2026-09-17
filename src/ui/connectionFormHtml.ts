export interface ConnectionFormHtmlInput {
  toolkitUri: string;
  mainScriptUri: string;
  cspSource: string;
  nonce: string;
}

const TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-{{NONCE}}'; style-src {{CSP_SOURCE}};" />
</head>
<!-- data-nonce is how main.js reads the nonce. It must NOT go back to
     document.currentScript: main.js is loaded as a module script, where
     document.currentScript is always null (HTML spec), which made reading
     .nonce off it throw and killed the entire script. -->
<body data-nonce="{{NONCE}}">
<form id="connectionForm">
  <div><vscode-text-field id="name" placeholder="staging">Connection Name</vscode-text-field></div>
  <div><vscode-text-field id="host" placeholder="example.com">Host</vscode-text-field></div>
  <div><vscode-text-field id="port" value="22">Port</vscode-text-field></div>
  <div><vscode-text-field id="username" placeholder="deploy">Username</vscode-text-field></div>
  <div>
    <label for="authMethod">Auth Method</label>
    <vscode-dropdown id="authMethod">
      <vscode-option value="password">Password</vscode-option>
      <vscode-option value="key">SSH Key</vscode-option>
      <vscode-option value="agent">Agent</vscode-option>
    </vscode-dropdown>
  </div>
  <!-- Credential inputs. main.js toggles each wrapper's \`hidden\` property from
       the Auth Method dropdown and only ever posts the fields belonging to the
       selected method. The key PATH is a plain text input on purpose: it is a
       filesystem path, not a secret, and only the path is ever persisted. -->
  <div data-auth-field="password">
    <vscode-text-field id="password" type="password">Password</vscode-text-field>
  </div>
  <div data-auth-field="key" hidden>
    <vscode-text-field id="keyPath" placeholder="/home/you/.ssh/id_ed25519">SSH Key Path</vscode-text-field>
  </div>
  <div data-auth-field="key" hidden>
    <vscode-text-field id="keyPassphrase" type="password">Key Passphrase (optional)</vscode-text-field>
  </div>
  <div><vscode-text-field id="remotePath" placeholder="/var/www">Remote Path</vscode-text-field></div>
  <div><vscode-button id="save">Save</vscode-button></div>
</form>
<script type="module" nonce="{{NONCE}}" src="{{TOOLKIT_URI}}"></script>
<script type="module" nonce="{{NONCE}}" src="{{MAIN_URI}}"></script>
</body>
</html>`;

/**
 * Fills the template with webview-resolved local URIs only. There is no CDN
 * fallback: the toolkit script must already exist at dist/media/connectionForm
 * (copied by esbuild.js), matching the VS Code guidance to never load webview
 * scripts from the network.
 */
export function buildConnectionFormHtml(input: ConnectionFormHtmlInput): string {
  return TEMPLATE.replace(/{{NONCE}}/g, input.nonce)
    .replace(/{{CSP_SOURCE}}/g, input.cspSource)
    .replace(/{{TOOLKIT_URI}}/g, input.toolkitUri)
    .replace(/{{MAIN_URI}}/g, input.mainScriptUri);
}
