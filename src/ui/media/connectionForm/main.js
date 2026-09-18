// Webview-side script for the Gangway "Manage Remotes" page: an add/edit
// form on the left plus a sidebar list of every saved connection on the
// right (PhpStorm's Deployment dialog is the closest native reference).
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

// Every saved connection's non-secret fields (never a password/passphrase --
// those live only in SecretStorage and never travel to the webview), used to
// render the sidebar and to populate the form when a row is clicked, both
// entirely client-side.
let connections = JSON.parse(document.getElementById('connections-data').textContent || '[]');

// Empty string (not undefined) when creating a new connection: the host
// renders it with `{{CONNECTION_ID}}` -> '' for that case (see
// resolveConnectionFormFields). Mutable: selecting a sidebar row, clicking
// "+ Add", or a successful first save (which turns "add" into "edit" for any
// later Save in this same panel session) all change which connection, if
// any, the form is currently editing.
let connectionId = document.body.dataset.connectionId || undefined;

function fieldValue(id) {
  const element = document.getElementById(id);
  return element && element.value ? element.value : '';
}

function setFieldValue(id, value) {
  document.getElementById(id).value = value || '';
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

/** Loads one saved connection's non-secret fields into the form (a
 * password/passphrase is never pre-filled: it never left SecretStorage). */
function loadConnectionIntoForm(connection) {
  connectionId = connection.id;
  document.body.dataset.connectionId = connection.id;
  document.getElementById('formHeading').textContent = `Edit Connection: ${connection.name}`;
  setFieldValue('name', connection.name);
  setFieldValue('host', connection.host);
  setFieldValue('port', String(connection.port));
  setFieldValue('username', connection.username);
  setFieldValue('remotePath', connection.remotePath);
  setFieldValue('password', '');
  setFieldValue('keyPath', connection.keyPath || '');
  setFieldValue('keyPassphrase', '');
  document.getElementById('authMethod').value = connection.authMethod;
  applyAuthVisibility();
  renderRemotesList();
}

/** Resets the form to a blank "New Connection" state. */
function clearForm() {
  connectionId = undefined;
  document.body.dataset.connectionId = '';
  document.getElementById('formHeading').textContent = 'New Connection';
  setFieldValue('name', '');
  setFieldValue('host', '');
  setFieldValue('port', '22');
  setFieldValue('username', '');
  setFieldValue('remotePath', '');
  setFieldValue('password', '');
  setFieldValue('keyPath', '');
  setFieldValue('keyPassphrase', '');
  document.getElementById('authMethod').value = 'password';
  applyAuthVisibility();
  renderRemotesList();
}

/** Renders the sidebar list purely from client-side state -- no host round
 * trip for viewing, only for mutating (save/delete). */
function renderRemotesList() {
  const list = document.getElementById('remotesList');
  list.textContent = '';

  if (connections.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-remotes';
    empty.textContent = 'No saved connections yet.';
    list.appendChild(empty);
    return;
  }

  for (const connection of [...connections].sort((a, b) => a.name.localeCompare(b.name))) {
    const row = document.createElement('div');
    row.className = 'remote-row' + (connection.id === connectionId ? ' active' : '');
    row.dataset.id = connection.id;

    const info = document.createElement('div');
    info.className = 'remote-info';
    const name = document.createElement('div');
    name.className = 'remote-name';
    name.textContent = connection.name;
    const address = document.createElement('div');
    address.className = 'remote-address';
    address.textContent = `${connection.username}@${connection.host}:${connection.port}`;
    info.appendChild(name);
    info.appendChild(address);

    const deleteButton = document.createElement('button');
    deleteButton.className = 'delete-remote';
    deleteButton.textContent = '✕';
    deleteButton.title = `Delete ${connection.name}`;
    deleteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      vscodeApi.postMessage({ nonce, type: 'deleteConnection', payload: { id: connection.id } });
    });

    row.appendChild(info);
    row.appendChild(deleteButton);
    row.addEventListener('click', () => loadConnectionIntoForm(connection));
    list.appendChild(row);
  }
}

document.getElementById('authMethod').addEventListener('change', applyAuthVisibility);

document.getElementById('save').addEventListener('click', (event) => {
  event.preventDefault();
  vscodeApi.postMessage({ nonce, type: 'saveConnection', payload: buildPayload() });
});

document.getElementById('addRemote').addEventListener('click', (event) => {
  event.preventDefault();
  clearForm();
});

document.getElementById('browseKeyPath').addEventListener('click', (event) => {
  event.preventDefault();
  vscodeApi.postMessage({ nonce, type: 'browseKeyPath' });
});

// The host replies asynchronously to browseKeyPath once the native file
// picker resolves, and to saveConnection/deleteConnection once the mutation
// lands (see ConnectionFormPanel.handleMessage). browseKeyPath never posts
// back at all if the user cancelled the dialog, so that field is simply left
// as it was.
window.addEventListener('message', (event) => {
  const data = event.data;
  // The host echoes the same per-panel nonce on every reply (see
  // ConnectionFormPanel): a message without it is not from this panel's
  // host side and must not drive the form. There is no origin to check
  // against (VS Code's onDidReceiveMessage/postMessage channel exposes
  // none), so the nonce is the entire gate in this direction too.
  if (!data || data.nonce !== nonce) return;

  if (data.type === 'keyPathSelected') {
    setFieldValue('keyPath', data.path);
    return;
  }

  if (data.type === 'connectionsUpdated') {
    connections = data.connections;
    if (data.savedId) {
      const saved = connections.find((c) => c.id === data.savedId);
      if (saved) loadConnectionIntoForm(saved);
    } else if (data.deletedId && data.deletedId === connectionId) {
      clearForm();
    } else {
      renderRemotesList();
    }
  }
});

applyAuthVisibility();
renderRemotesList();
