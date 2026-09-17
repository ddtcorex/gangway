// Webview-side script for the Gangway connection form.
//
// The nonce is read from `<body data-nonce="...">` (substituted by
// buildConnectionFormHtml), NEVER from `document.currentScript`: this file is
// loaded as `<script type="module">`, and per the HTML spec
// `document.currentScript` is always null inside a module script. Reading
// `.nonce` off it threw a TypeError on the very first statement, so the whole
// script died before the Save listener was ever attached and the form's only
// button did nothing at all. `document.body.dataset.nonce` is readable the
// same way regardless of classic-vs-module script semantics.
const vscodeApi = acquireVsCodeApi();
const nonce = document.body.dataset.nonce;
// Empty string (not undefined) when creating a new connection: the host
// renders it with `{{CONNECTION_ID}}` -> '' for that case (see
// resolveConnectionFormFields), so an empty dataset value is the "add" mode,
// not a bug.
const connectionId = document.body.dataset.connectionId || undefined;

function fieldValue(id) {
  const element = document.getElementById(id);
  return element && element.value ? element.value : '';
}

/**
 * Shows only the credential inputs that belong to the selected auth method.
 * Toggling the `hidden` property on the plain wrapper `<div>`s (never an
 * inline `style` attribute) keeps this working under the form's strict CSP,
 * which allows no inline styles.
 */
function applyAuthVisibility() {
  const authMethod = fieldValue('authMethod');
  for (const field of document.querySelectorAll('[data-auth-field]')) {
    field.hidden = field.dataset.authField !== authMethod;
  }
}

/**
 * Only ever sends the credentials that belong to the selected auth method, so
 * a value left behind in a hidden input can never be stored as a secret for a
 * connection that does not use it.
 */
function buildPayload() {
  const authMethod = fieldValue('authMethod');
  const payload = {
    ...(connectionId ? { id: connectionId } : {}),
    name: fieldValue('name'),
    host: fieldValue('host'),
    port: Number(fieldValue('port')),
    username: fieldValue('username'),
    remotePath: fieldValue('remotePath'),
    authMethod,
  };

  if (authMethod === 'password') {
    const password = fieldValue('password');
    if (password) payload.password = password;
  }

  if (authMethod === 'key') {
    payload.keyPath = fieldValue('keyPath');
    const keyPassphrase = fieldValue('keyPassphrase');
    // Optional: an unencrypted key has no passphrase, and storing an empty
    // string would make authResolver hand ssh2 a bogus `passphrase` option.
    if (keyPassphrase) payload.keyPassphrase = keyPassphrase;
  }

  return payload;
}

document.getElementById('authMethod').addEventListener('change', applyAuthVisibility);

document.getElementById('save').addEventListener('click', (event) => {
  event.preventDefault();
  vscodeApi.postMessage({ nonce, type: 'saveConnection', payload: buildPayload() });
});

document.getElementById('browseKeyPath').addEventListener('click', (event) => {
  event.preventDefault();
  vscodeApi.postMessage({ nonce, type: 'browseKeyPath' });
});

// The host replies asynchronously once the native file picker resolves
// (see ConnectionFormPanel.handleMessage's 'browseKeyPath' branch); it never
// posts back at all if the user cancels the dialog, so the field is simply
// left as it was.
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'keyPathSelected') {
    document.getElementById('keyPath').value = event.data.path;
  }
});

applyAuthVisibility();
