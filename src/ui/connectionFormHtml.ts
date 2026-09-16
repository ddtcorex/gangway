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
<body>
<form id="connectionForm">
  <vscode-text-field id="name" placeholder="Connection Name"></vscode-text-field>
  <vscode-text-field id="host" placeholder="Host"></vscode-text-field>
  <vscode-text-field id="port" placeholder="Port" value="22"></vscode-text-field>
  <vscode-text-field id="username" placeholder="Username"></vscode-text-field>
  <vscode-dropdown id="authMethod">
    <vscode-option value="password">Password</vscode-option>
    <vscode-option value="key">SSH Key</vscode-option>
    <vscode-option value="agent">Agent</vscode-option>
  </vscode-dropdown>
  <vscode-text-field id="remotePath" placeholder="Remote Path"></vscode-text-field>
  <vscode-button id="save">Save</vscode-button>
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
