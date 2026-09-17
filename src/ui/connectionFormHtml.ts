import type { AuthMethod } from '../types';

export interface ConnectionFormPrefill {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  remotePath: string;
  authMethod: AuthMethod;
  keyPath?: string;
}

export interface ConnectionFormHtmlInput {
  toolkitUri: string;
  mainScriptUri: string;
  cspSource: string;
  nonce: string;
  heading: string;
  connectionId: string;
  name: string;
  host: string;
  port: string;
  username: string;
  remotePath: string;
  keyPath: string;
  passwordSelected: string;
  keySelected: string;
  agentSelected: string;
  passwordHint: string;
  passphraseHint: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Turns an optional existing connection into the flat set of display strings
 * buildConnectionFormHtml() substitutes verbatim (heading text, an mode's
 * selected auth option, pre-filled field values). Kept separate from
 * buildConnectionFormHtml on purpose: that function stays a pure 1:1
 * mustache-style substitution with no conditionals of its own, which is what
 * lets the inlined TEMPLATE and the reference index.html copy be compared
 * byte-for-byte in test/ui/connectionFormHtml.test.ts.
 */
export function resolveConnectionFormFields(
  existingConnection?: ConnectionFormPrefill,
): Pick<
  ConnectionFormHtmlInput,
  | 'heading'
  | 'connectionId'
  | 'name'
  | 'host'
  | 'port'
  | 'username'
  | 'remotePath'
  | 'keyPath'
  | 'passwordSelected'
  | 'keySelected'
  | 'agentSelected'
  | 'passwordHint'
  | 'passphraseHint'
> {
  const c = existingConnection;
  const authMethod = c?.authMethod ?? 'password';
  const selected = (expected: AuthMethod) => (authMethod === expected ? ' selected' : '');
  const blankHint = c ? ' (leave blank to keep the current one)' : '';
  return {
    heading: c ? `Edit Connection: ${escapeHtml(c.name)}` : 'New Connection',
    connectionId: c ? escapeHtml(c.id) : '',
    name: c ? escapeHtml(c.name) : '',
    host: c ? escapeHtml(c.host) : '',
    port: c ? String(c.port) : '22',
    username: c ? escapeHtml(c.username) : '',
    remotePath: c ? escapeHtml(c.remotePath) : '',
    keyPath: c?.keyPath ? escapeHtml(c.keyPath) : '',
    passwordSelected: selected('password'),
    keySelected: selected('key'),
    agentSelected: selected('agent'),
    passwordHint: blankHint,
    passphraseHint: blankHint,
  };
}

const TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-{{NONCE}}'; style-src {{CSP_SOURCE}} 'nonce-{{NONCE}}';" />
<style nonce="{{NONCE}}">
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    padding: 0 20px 20px;
    max-width: 480px;
  }
  h2 {
    font-size: 1.1em;
    font-weight: 600;
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    padding-bottom: 8px;
    margin-top: 20px;
  }
  .field {
    display: flex;
    flex-direction: column;
    margin-bottom: 12px;
  }
  /* main.js toggles the native \`hidden\` attribute to show only the auth
     fields for the selected method; without this rule .field's own
     \`display: flex\` (same specificity as the UA stylesheet's [hidden] rule,
     but declared later) wins the cascade and the attribute has no visual
     effect at all. */
  .field[hidden] {
    display: none;
  }
  .field label.field-label {
    font-size: 0.9em;
    opacity: 0.85;
    margin-bottom: 4px;
  }
  .field vscode-text-field,
  .field vscode-dropdown {
    width: 100%;
  }
  .field-row {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  .field-row .field {
    flex: 1;
    margin-bottom: 12px;
  }
  .two-up {
    display: flex;
    gap: 12px;
  }
  .two-up .field {
    flex: 1;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 24px;
  }
</style>
</head>
<!-- data-nonce is how main.js reads the nonce. It must NOT go back to
     document.currentScript: main.js is loaded as a module script, where
     document.currentScript is always null (HTML spec), which made reading
     .nonce off it throw and killed the entire script.
     data-connection-id is empty for a new connection and set to the
     existing connection's id when editing: main.js includes it in the save
     payload so the host knows to update() rather than add(). -->
<body data-nonce="{{NONCE}}" data-connection-id="{{CONNECTION_ID}}">
<h2>{{HEADING}}</h2>
<form id="connectionForm">
  <div class="field">
    <label class="field-label" for="name">Connection Name</label>
    <vscode-text-field id="name" placeholder="staging" value="{{NAME}}"></vscode-text-field>
  </div>
  <div class="two-up">
    <div class="field">
      <label class="field-label" for="host">Host</label>
      <vscode-text-field id="host" placeholder="example.com" value="{{HOST}}"></vscode-text-field>
    </div>
    <div class="field" style="max-width: 100px;">
      <label class="field-label" for="port">Port</label>
      <vscode-text-field id="port" value="{{PORT}}"></vscode-text-field>
    </div>
  </div>
  <div class="field">
    <label class="field-label" for="username">Username</label>
    <vscode-text-field id="username" placeholder="deploy" value="{{USERNAME}}"></vscode-text-field>
  </div>

  <h2>Authentication</h2>
  <div class="field">
    <label class="field-label" for="authMethod">Auth Method</label>
    <vscode-dropdown id="authMethod">
      <vscode-option value="password"{{PASSWORD_SELECTED}}>Password</vscode-option>
      <vscode-option value="key"{{KEY_SELECTED}}>SSH Key</vscode-option>
      <vscode-option value="agent"{{AGENT_SELECTED}}>Agent</vscode-option>
    </vscode-dropdown>
  </div>
  <!-- Credential inputs. main.js toggles each wrapper's \`hidden\` property from
       the Auth Method dropdown and only ever posts the fields belonging to the
       selected method. The key PATH is a plain text input on purpose: it is a
       filesystem path, not a secret, and only the path is ever persisted.
       A password/passphrase field is always left blank on load, even when
       editing a connection that already has one stored: a stored secret
       never travels back out of SecretStorage into the webview. Leaving it
       blank on save keeps the existing secret untouched. -->
  <div class="field" data-auth-field="password">
    <label class="field-label" for="password">Password{{PASSWORD_BLANK_HINT}}</label>
    <vscode-text-field id="password" type="password"></vscode-text-field>
  </div>
  <div class="field" data-auth-field="key" hidden>
    <label class="field-label" for="keyPath">SSH Key Path</label>
    <div class="field-row">
      <vscode-text-field id="keyPath" placeholder="/home/you/.ssh/id_ed25519" value="{{KEY_PATH}}"></vscode-text-field>
      <vscode-button id="browseKeyPath" appearance="secondary">Browse...</vscode-button>
    </div>
  </div>
  <div class="field" data-auth-field="key" hidden>
    <label class="field-label" for="keyPassphrase">Key Passphrase (optional){{PASSPHRASE_BLANK_HINT}}</label>
    <vscode-text-field id="keyPassphrase" type="password"></vscode-text-field>
  </div>

  <h2>Remote</h2>
  <div class="field">
    <label class="field-label" for="remotePath">Remote Path</label>
    <vscode-text-field id="remotePath" placeholder="/var/www" value="{{REMOTE_PATH}}"></vscode-text-field>
  </div>

  <div class="actions">
    <vscode-button id="save">Save</vscode-button>
  </div>
</form>
<script type="module" nonce="{{NONCE}}" src="{{TOOLKIT_URI}}"></script>
<script type="module" nonce="{{NONCE}}" src="{{MAIN_URI}}"></script>
</body>
</html>`;

/**
 * Fills the template with webview-resolved local URIs only. There is no CDN
 * fallback: the toolkit script must already exist at dist/media/connectionForm
 * (copied by esbuild.js), matching the VS Code guidance to never load webview
 * scripts from the network. Every field here is a literal 1:1 substitution
 * (see resolveConnectionFormFields for the add-vs-edit-mode logic feeding it).
 */
export function buildConnectionFormHtml(input: ConnectionFormHtmlInput): string {
  return TEMPLATE.replace(/{{NONCE}}/g, input.nonce)
    .replace(/{{CSP_SOURCE}}/g, input.cspSource)
    .replace(/{{TOOLKIT_URI}}/g, input.toolkitUri)
    .replace(/{{MAIN_URI}}/g, input.mainScriptUri)
    .replace(/{{HEADING}}/g, input.heading)
    .replace(/{{CONNECTION_ID}}/g, input.connectionId)
    .replace(/{{NAME}}/g, input.name)
    .replace(/{{HOST}}/g, input.host)
    .replace(/{{PORT}}/g, input.port)
    .replace(/{{USERNAME}}/g, input.username)
    .replace(/{{REMOTE_PATH}}/g, input.remotePath)
    .replace(/{{KEY_PATH}}/g, input.keyPath)
    .replace(/{{PASSWORD_SELECTED}}/g, input.passwordSelected)
    .replace(/{{KEY_SELECTED}}/g, input.keySelected)
    .replace(/{{AGENT_SELECTED}}/g, input.agentSelected)
    .replace(/{{PASSWORD_BLANK_HINT}}/g, input.passwordHint)
    .replace(/{{PASSPHRASE_BLANK_HINT}}/g, input.passphraseHint);
}
