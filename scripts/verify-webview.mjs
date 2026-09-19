#!/usr/bin/env node
/**
 * Real-browser verification for the connection-form webview.
 *
 * Why a browser and not just a unit test: the C1 bug (Save button dead on
 * arrival) came from `document.currentScript` being null inside a
 * `<script type="module">`. No jsdom-class fake reproduces that -- jsdom does
 * not execute module scripts at all -- so only a real engine can prove the
 * form works. This script:
 *
 *   1. compiles the REAL src/ui/connectionFormHtml.ts and renders the REAL
 *      template (not a copy) with the same nonce/CSP substitution production
 *      uses;
 *   2. serves it plus the REAL built dist/media/connectionForm/{toolkit,main}.js
 *      over http (module scripts need a real origin; file:// fails CORS);
 *   3. drives headless Chrome over the DevTools protocol: stubs
 *      `acquireVsCodeApi` the way VS Code injects it, fills the fields,
 *      clicks Save with real mouse events, and prints what was posted.
 *
 * Usage: node esbuild.js && node scripts/verify-webview.mjs
 * Exits non-zero (and prints the page's console errors) if the form is dead.
 */
import { spawn } from 'node:child_process';
import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME_CANDIDATES = [
  '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

/** Bundles the real TypeScript template module so this script renders exactly
 * what ships, instead of re-implementing the substitution or reading the
 * reference index.html copy. Returns both functions: buildConnectionFormHtml
 * needs every ConnectionFormHtmlInput field, and resolveConnectionFormFields
 * is the one place (besides extension.ts itself) that computes the
 * add-vs-edit-mode ones correctly -- hand-rolling a partial object here
 * previously left `connectionsJson` (and everything else) undefined, which
 * `{{TOKEN}}.replace()` coerces to the literal string "undefined", corrupting
 * the embedded JSON script tag and crashing main.js before it can attach the
 * Save listener at all. */
async function loadTemplateRenderer(workDir) {
  const outfile = path.join(workDir, 'connectionFormHtml.cjs');
  await esbuild.build({
    entryPoints: [path.join(repoRoot, 'src/ui/connectionFormHtml.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent',
  });
  const module = await import(`file://${outfile}`);
  return module.default ?? module;
}

function serveDirectory(dir) {
  const server = http.createServer(async (req, res) => {
    const requested = path.join(dir, path.normalize(req.url.split('?')[0]).replace(/^(\.\.[/\\])+/, ''));
    try {
      const body = await fs.readFile(requested);
      res.writeHead(200, { 'content-type': requested.endsWith('.js') ? 'text/javascript' : 'text/html' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();
  events = [];

  static async attach(wsUrl) {
    const cdp = new Cdp();
    cdp.#socket = new WebSocket(wsUrl);
    cdp.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const resolve = cdp.#pending.get(message.id);
        cdp.#pending.delete(message.id);
        resolve?.(message);
      } else {
        cdp.events.push(message);
      }
    });
    await new Promise((resolve, reject) => {
      cdp.#socket.addEventListener('open', resolve, { once: true });
      cdp.#socket.addEventListener('error', reject, { once: true });
    });
    return cdp;
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.result?.exceptionDetails) {
      throw new Error(`page threw: ${JSON.stringify(response.result.exceptionDetails)}`);
    }
    return response.result?.result?.value;
  }

  close() {
    this.#socket.close();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const chrome = await firstExisting(CHROME_CANDIDATES);
  if (!chrome) throw new Error(`no Chrome/Chromium binary found (looked in: ${CHROME_CANDIDATES.join(', ')})`);

  const mediaDir = path.join(repoRoot, 'dist/media/connectionForm');
  for (const asset of ['toolkit.min.js', 'main.js']) {
    await fs.access(path.join(mediaDir, asset)).catch(() => {
      throw new Error(`missing ${path.join(mediaDir, asset)} -- run "node esbuild.js" first`);
    });
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gangway-webview-verify-'));
  const { buildConnectionFormHtml, resolveConnectionFormFields, toConnectionsJson } = await loadTemplateRenderer(workDir);

  const serveDir = path.join(workDir, 'www');
  await fs.mkdir(serveDir, { recursive: true });
  await fs.copyFile(path.join(mediaDir, 'toolkit.min.js'), path.join(serveDir, 'toolkit.min.js'));
  await fs.copyFile(path.join(mediaDir, 'main.js'), path.join(serveDir, 'main.js'));
  await fs.writeFile(
    path.join(serveDir, 'index.html'),
    // Same call shape extension.ts itself uses (openManageRemotesPanel): every
    // add-vs-edit-mode field comes from resolveConnectionFormFields(), never
    // hand-rolled here, so this can never again drift out of sync with what
    // buildConnectionFormHtml actually requires.
    buildConnectionFormHtml({
      toolkitUri: './toolkit.min.js',
      mainScriptUri: './main.js',
      cspSource: "'self'",
      nonce: 'verify-nonce-123',
      ...resolveConnectionFormFields(undefined),
      connectionsJson: toConnectionsJson([]),
    }),
    'utf8',
  );

  const server = await serveDirectory(serveDir);
  const pageUrl = `http://127.0.0.1:${server.address().port}/index.html`;

  const profileDir = path.join(workDir, 'chrome-profile');
  const browser = spawn(chrome, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ]);

  let cdp;
  try {
    let devtoolsPort;
    for (let attempt = 0; attempt < 100 && !devtoolsPort; attempt++) {
      await sleep(100);
      devtoolsPort = await fs
        .readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8')
        .then((raw) => raw.split('\n')[0].trim())
        .catch(() => undefined);
    }
    if (!devtoolsPort) throw new Error('Chrome never reported a DevTools port');

    const targets = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`).then((r) => r.json());
    const page = targets.find((t) => t.type === 'page');
    cdp = await Cdp.attach(page.webSocketDebuggerUrl);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    // Without an explicit device metrics override, headless Chrome's default
    // viewport does not line up with the coordinates getBoundingClientRect()
    // reports, so the real mouse click below (Input.dispatchMouseEvent) lands
    // on the wrong pixel and never reaches the button at all -- discovered by
    // comparing a plain element.click() (which worked) against the
    // coordinate-based click (which silently posted nothing).
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1200,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // Exactly what the VS Code webview host injects before any page script runs.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__posted = [];
        window.acquireVsCodeApi = () => ({
          postMessage: (message) => window.__posted.push(message),
          getState: () => undefined,
          setState: () => undefined,
        });
      `,
    });

    await cdp.send('Page.navigate', { url: pageUrl });
    await sleep(1500);

    const scriptAlive = await cdp.evaluate('typeof window.__posted');
    if (scriptAlive !== 'object') throw new Error('the injected acquireVsCodeApi stub never ran');

    // Fill the form the way a user would: set each field's value through the
    // real custom elements the toolkit defined.
    await cdp.evaluate(`
      (() => {
        const set = (id, value) => { document.getElementById(id).value = value; };
        set('name', 'staging');
        set('host', 'example.com');
        set('port', '2222');
        set('username', 'deploy');
        set('remotePath', '/var/www');
        set('password', 'hunter2');
        return true;
      })()
    `);

    const authFieldsVisible = async () =>
      cdp.evaluate(`
        Array.from(document.querySelectorAll('[data-auth-field]')).map((el) => ({
          field: el.dataset.authField,
          hidden: el.hidden,
        }))
      `);

    const beforeSwitch = await authFieldsVisible();

    // Real mouse click helper (not element.click()): elements below the
    // headless viewport fold receive nothing from synthetic mouse events
    // (elementFromPoint returns null there), so scroll into view first.
    const clickById = async (id) => {
      await cdp.evaluate(`document.getElementById('${id}').scrollIntoView({ block: 'center' });`);
      await sleep(200);
      const rect = await cdp.evaluate(`
        (() => { const r = document.getElementById('${id}').getBoundingClientRect();
                 return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()
      `);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', {
          type,
          x: rect.x,
          y: rect.y,
          button: 'left',
          clickCount: type === 'mouseMoved' ? 0 : 1,
        });
      }
      await sleep(300);
    };
    const clickSave = () => clickById('save');

    await clickSave();

    // Switch to SSH-key auth exactly as the dropdown does, then fill and save
    // again: proves the key fields exist, become visible, and reach the host.
    await cdp.evaluate(`
      (() => {
        const dropdown = document.getElementById('authMethod');
        dropdown.value = 'key';
        dropdown.dispatchEvent(new Event('change'));
        document.getElementById('keyPath').value = '/home/deploy/.ssh/id_ed25519';
        document.getElementById('keyPassphrase').value = 'phrase';
        return true;
      })()
    `);
    const afterSwitch = await authFieldsVisible();
    await clickSave();

    // Mapping overlap notes must render in a REAL DOM: the unit mock's
    // FakeElement.children is a real Array (with .find), while the browser's
    // HTMLCollection has no array methods — so only this gate can catch a
    // mismatch like row.children.find(...) throwing on every keystroke.
    // Fills two nested rows exactly as a user would, then reads row 0's note.
    await cdp.evaluate(`
      (() => {
        const rows = () => document.querySelectorAll('#mappingsRows .mapping-row');
        const setRow = (i, local, remote) => {
          const fields = rows()[i].querySelectorAll('vscode-text-field');
          fields[0].value = local;
          fields[0].dispatchEvent(new Event('input', { bubbles: true }));
          fields[1].value = remote;
          fields[1].dispatchEvent(new Event('input', { bubbles: true }));
        };
        document.getElementById('remotePath').value = '/srv/app';
        document.getElementById('remotePath').dispatchEvent(new Event('input', { bubbles: true }));
        setRow(0, '/w', '/srv/app');
        return true;
      })()
    `);
    await clickById('mappingAdd');
    await cdp.evaluate(`
      (() => {
        const rows = () => document.querySelectorAll('#mappingsRows .mapping-row');
        const fields = rows()[1].querySelectorAll('vscode-text-field');
        fields[0].value = '/w/sub';
        fields[0].dispatchEvent(new Event('input', { bubbles: true }));
        fields[1].value = '/srv/app/other';
        fields[1].dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    const overlapNote = await cdp.evaluate(`
      document.querySelectorAll('#mappingsRows .mapping-row')[0]
        .querySelector('.mapping-note').textContent
    `);
    console.log('--- mapping overlap note (row 0) ---');
    console.log(JSON.stringify(overlapNote));
    if (!/row 2/i.test(overlapNote ?? '')) {
      throw new Error(`expected an overlap note naming row 2, got ${JSON.stringify(overlapNote)}`);
    }

    // Optional visual evidence: GANGWAY_WEBVIEW_SCREENSHOT=/path/to.png makes
    // the run save what the form actually looks like, so a CSP-blocked
    // stylesheet or a collapsed layout is caught by eye, not only by asserts.
    if (process.env.GANGWAY_WEBVIEW_SCREENSHOT) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await fs.writeFile(process.env.GANGWAY_WEBVIEW_SCREENSHOT, Buffer.from(shot.result.data, 'base64'));
      console.log(`--- screenshot written to ${process.env.GANGWAY_WEBVIEW_SCREENSHOT} ---`);
    }

    const posted = await cdp.evaluate('window.__posted');
    const consoleErrors = cdp.events
      .filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
      .map((e) => e.params.entry.text);

    console.log('--- page console errors ---');
    console.log(consoleErrors.length ? consoleErrors.join('\n') : '(none)');
    console.log('--- auth-method field visibility (password selected) ---');
    console.log(JSON.stringify(beforeSwitch));
    console.log('--- auth-method field visibility (SSH key selected) ---');
    console.log(JSON.stringify(afterSwitch));
    console.log('--- messages posted to the extension host on each Save click ---');
    console.log(JSON.stringify(posted, null, 2));

    if (!Array.isArray(posted) || posted.length !== 2) {
      throw new Error(`expected exactly two posted messages, got ${JSON.stringify(posted)}`);
    }
    for (const message of posted) {
      if (message.nonce !== 'verify-nonce-123' || message.type !== 'saveConnection') {
        throw new Error(`posted message has the wrong envelope: ${JSON.stringify(message)}`);
      }
    }
    if (posted[0].payload.password !== 'hunter2' || 'keyPath' in posted[0].payload) {
      throw new Error(`password-auth payload is wrong: ${JSON.stringify(posted[0].payload)}`);
    }
    if (posted[1].payload.keyPath !== '/home/deploy/.ssh/id_ed25519' || posted[1].payload.keyPassphrase !== 'phrase') {
      throw new Error(`key-auth payload is wrong: ${JSON.stringify(posted[1].payload)}`);
    }
    if ('password' in posted[1].payload) {
      throw new Error('key-auth payload must not carry the password field');
    }
    console.log('\nOK: Save posts nonce-matched saveConnection messages for both password and key auth.');
  } finally {
    cdp?.close();
    browser.kill('SIGKILL');
    server.close();
    // Chrome flushes its profile asynchronously after SIGKILL; a rm that races
    // it fails with ENOTEMPTY. This is throwaway scratch state either way, so
    // a failed cleanup must never fail the verification itself.
    await sleep(300);
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
