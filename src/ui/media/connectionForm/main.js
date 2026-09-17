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

function fieldValue(id) {
  const element = document.getElementById(id);
  return element && element.value ? element.value : '';
}

document.getElementById('save').addEventListener('click', (event) => {
  event.preventDefault();
  vscodeApi.postMessage({
    nonce,
    type: 'saveConnection',
    payload: {
      name: fieldValue('name'),
      host: fieldValue('host'),
      port: Number(fieldValue('port')),
      username: fieldValue('username'),
      remotePath: fieldValue('remotePath'),
      authMethod: fieldValue('authMethod'),
    },
  });
});
