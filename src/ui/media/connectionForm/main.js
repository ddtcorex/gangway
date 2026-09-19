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

/** vscode-checkbox mirrors the native <input type="checkbox"> `.checked`
 * boolean property, unlike vscode-text-field's `.value`. */
function checkboxChecked(id) {
  return Boolean(document.getElementById(id).checked);
}

function setCheckboxChecked(id, checked) {
  document.getElementById(id).checked = Boolean(checked);
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
function credentialFields() {
  const authMethod = fieldValue('authMethod');
  const fields = {};
  if (authMethod === 'password') {
    const password = fieldValue('password');
    if (password) fields.password = password;
  }
  if (authMethod === 'key') {
    fields.keyPath = fieldValue('keyPath');
    const keyPassphrase = fieldValue('keyPassphrase');
    // Optional: an unencrypted key has no passphrase, and storing an empty
    // string would make authResolver hand ssh2 a bogus `passphrase` option.
    if (keyPassphrase) fields.keyPassphrase = keyPassphrase;
  }
  return { authMethod, fields };
}

function buildPayload() {
  const { authMethod, fields } = credentialFields();
  return {
    ...(connectionId ? { id: connectionId } : {}),
    name: fieldValue('name'),
    host: fieldValue('host'),
    port: Number(fieldValue('port')),
    username: fieldValue('username'),
    remotePath: fieldValue('remotePath'),
    authMethod,
    scope: checkboxChecked('workspaceScope') ? 'workspace' : 'global',
    ...fields,
    mappings: readMappingRows().filter((m) => m.localPath && m.remotePath),
  };
}

/**
 * The unsaved draft for a Test Connection dial: same connection fields and
 * credentials as a save, but never an id and never mappings — the host dials
 * it once and drops it.
 */
function buildDraft() {
  const { authMethod, fields } = credentialFields();
  return {
    host: fieldValue('host'),
    port: Number(fieldValue('port')),
    username: fieldValue('username'),
    authMethod,
    ...fields,
  };
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
  setCheckboxChecked('workspaceScope', connection.scope === 'workspace');
  applyAuthVisibility();
  clearTestResult();
  renderMappingRows(connection.mappings || []);
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
  // Workspace-scope (checked) is the default for a brand-new connection: one
  // added while working in this project is most often specific to it, same
  // reasoning as the govard-import default.
  setCheckboxChecked('workspaceScope', true);
  applyAuthVisibility();
  clearTestResult();
  renderMappingRows([]);
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
    // Global is the familiar default and stays unlabeled to avoid visual
    // noise; only the less-common workspace scope gets a badge.
    if (connection.scope === 'workspace') {
      const badge = document.createElement('span');
      badge.className = 'scope-badge';
      badge.textContent = 'Workspace';
      name.appendChild(badge);
    }
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
document.getElementById('remotePath').addEventListener('input', refreshMappingNotes);

/**
 * Path mappings table (remote ↔ local pairs). Rows are plain element trees
 * — [local field, remote field, browse button, remove button] — read back
 * positionally, so no per-row ids are needed and rows survive re-renders.
 */
function createMappingRow(mapping) {
  const row = document.createElement('div');
  row.className = 'mapping-row';
  const local = document.createElement('vscode-text-field');
  local.placeholder = '/home/you/proj';
  local.value = mapping.localPath || '';
  local.addEventListener('input', refreshMappingNotes);
  const remote = document.createElement('vscode-text-field');
  remote.placeholder = '/srv/app';
  remote.value = mapping.remotePath || '';
  remote.addEventListener('input', refreshMappingNotes);
  const browse = document.createElement('vscode-button');
  browse.textContent = 'Browse…';
  browse.appearance = 'secondary';
  browse.title = 'Pick a local folder';
  browse.addEventListener('click', (event) => {
    event.preventDefault();
    vscodeApi.postMessage({ nonce, type: 'browseMappingFolder', row: mappingRowIndex(row) });
  });
  const remove = document.createElement('vscode-button');
  remove.textContent = '✕';
  remove.title = 'Remove mapping';
  remove.appearance = 'secondary';
  remove.addEventListener('click', (event) => {
    event.preventDefault();
    const container = document.getElementById('mappingsRows');
    const kept = [...container.children].filter((child) => child !== row);
    container.textContent = '';
    for (const child of kept) container.appendChild(child);
    if (kept.length === 0) container.appendChild(createMappingRow({ localPath: '', remotePath: '' }));
    refreshMappingNotes();
  });
  row.appendChild(local);
  row.appendChild(remote);
  row.appendChild(browse);
  row.appendChild(remove);
  const note = document.createElement('div');
  note.className = 'mapping-note';
  note.textContent = '';
  row.appendChild(note);
  return row;
}

function mappingRowIndex(row) {
  return [...document.getElementById('mappingsRows').children].indexOf(row);
}

function readMappingRows() {
  return [...document.getElementById('mappingsRows').children].map((row) => ({
    localPath: row.children[0] ? row.children[0].value || '' : '',
    remotePath: row.children[1] ? row.children[1].value || '' : '',
  }));
}

function renderMappingRows(mappings) {
  const container = document.getElementById('mappingsRows');
  container.textContent = '';
  const rows = mappings.length > 0 ? mappings : [{ localPath: '', remotePath: '' }];
  for (const mapping of rows) container.appendChild(createMappingRow(mapping));
  refreshMappingNotes();
}

/**
 * Per-row notes, recomputed on every edit: overlap (the same longest-prefix
 * rule as pathMapping.ts overlapNotes, duplicated here because the webview
 * cannot import host modules) and remote-outside-connection-root. The
 * connection root comes from the Remote Path field itself, so the hint
 * follows what the user is typing.
 */
function refreshMappingNotes() {
  const norm = (p) => (p || '').replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const within = (candidate, prefix) => candidate === prefix || candidate.startsWith(prefix + '/');
  const container = document.getElementById('mappingsRows');
  const rows = [...container.children].map((row) => ({
    local: norm(row.children[0] ? row.children[0].value : ''),
    remote: norm(row.children[1] ? row.children[1].value : ''),
  }));
  const root = norm(fieldValue('remotePath'));
  [...container.children].forEach((row, index) => {
    const notes = [];
    rows.forEach((other, otherIndex) => {
      if (otherIndex === index) return;
      if (
        (other.local !== rows[index].local && within(other.local, rows[index].local)) ||
        (other.remote !== rows[index].remote && within(other.remote, rows[index].remote))
      ) {
        notes.push(`Overlapped by row ${otherIndex + 1} — the longer prefix wins`);
      }
    });
    if (rows[index].remote && root && !within(rows[index].remote, root)) {
      const rawRemote = (row.children[1] && row.children[1].value) || '';
      // Blank rows are handled by the save-time half-filled check, not here.
      if (rawRemote) notes.push('Remote path is outside the connection remote path — sync will refuse it.');
    }
    const noteEl = row.children.find((child) => child.className === 'mapping-note');
    if (noteEl) noteEl.textContent = notes.join(' ');
  });
}

function clearTestResult() {
  const resultEl = document.getElementById('testResult');
  resultEl.textContent = '';
  resultEl.dataset.ok = '';
}

document.getElementById('save').addEventListener('click', (event) => {
  event.preventDefault();
  const rows = readMappingRows();
  const half = rows.findIndex((m) => (m.localPath && !m.remotePath) || (!m.localPath && m.remotePath));
  const errorEl = document.getElementById('mappingsError');
  if (half !== -1) {
    errorEl.textContent = `Mapping row ${half + 1} is half-filled: fill both paths or remove the row.`;
    return;
  }
  errorEl.textContent = '';
  vscodeApi.postMessage({ nonce, type: 'saveConnection', payload: buildPayload() });
});

document.getElementById('testConnection').addEventListener('click', (event) => {
  event.preventDefault();
  const resultEl = document.getElementById('testResult');
  resultEl.textContent = 'Testing…';
  resultEl.dataset.ok = '';
  vscodeApi.postMessage({ nonce, type: 'testConnection', payload: { draft: buildDraft() } });
});

document.getElementById('mappingAdd').addEventListener('click', (event) => {
  event.preventDefault();
  document.getElementById('mappingsRows').appendChild(createMappingRow({ localPath: '', remotePath: '' }));
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
// as it was. testConnection always posts back a testConnectionResult;
// browseMappingFolder posts mappingFolderSelected unless cancelled.
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

  if (data.type === 'testConnectionResult') {
    const resultEl = document.getElementById('testResult');
    resultEl.textContent = data.message || (data.ok ? 'Connection OK' : 'Connection failed');
    resultEl.dataset.ok = data.ok ? 'true' : 'false';
    return;
  }

  if (data.type === 'mappingFolderSelected') {
    const rows = document.getElementById('mappingsRows').children;
    const row = rows[data.row];
    if (row) row.children[0].value = data.path;
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
// The host pre-renders field values for the edited connection (if any) into
// the template; mappings arrive the same way through the sidebar data.
(function initMappings() {
  const current = connections.find((c) => c.id === connectionId);
  renderMappingRows((current && current.mappings) || []);
})();
