const vscodeApi = acquireVsCodeApi();
const nonce = document.currentScript.nonce;

document.getElementById('save').addEventListener('click', (event) => {
  event.preventDefault();
  vscodeApi.postMessage({
    nonce,
    type: 'saveConnection',
    payload: {
      name: document.getElementById('name').value,
      host: document.getElementById('host').value,
      port: Number(document.getElementById('port').value),
      username: document.getElementById('username').value,
      remotePath: document.getElementById('remotePath').value,
      authMethod: document.getElementById('authMethod').value,
    },
  });
});
