// Headless Chrome over the DevTools protocol, and the preview server, for dev/ui-test.mjs and dev/screenshots.mjs.
// No dependencies: node's own fetch, WebSocket and child_process.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** dev/serve.py on `port`, unless something already answers there. Returns a stop function. */
export async function startServer(port = 8766) {
  const up = async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/dev/card-preview.html`)).ok;
    } catch {
      return false;
    }
  };
  if (await up()) return () => {};
  const proc = spawn('python3', [join(ROOT, 'dev', 'serve.py')], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await up()); i++) await sleep(100);
  if (!(await up())) throw new Error(`dev/serve.py did not come up on port ${port}`);
  return () => proc.kill();
}

/** A headless Chrome with one page. `page.cmd(method, params)` speaks the DevTools protocol. */
export async function launchChrome({ port = 9339 } = {}) {
  const bin = process.env.CHROME || (existsSync(MAC_CHROME) ? MAC_CHROME : 'google-chrome');
  const profile = mkdtempSync(join(tmpdir(), 'beit-chrome-'));
  const args = ['--headless=new', `--remote-debugging-port=${port}`, '--hide-scrollbars', '--disable-gpu', `--user-data-dir=${profile}`];
  // GitHub's runners do not allow Chrome's sandbox, and their /dev/shm is small.
  if (process.env.CI) args.push('--no-sandbox', '--disable-dev-shm-usage');
  const proc = spawn(bin, [...args, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  let exited = null;
  proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  proc.on('error', (err) => (exited = String(err)));
  proc.on('exit', (code) => (exited ??= `exit code ${code}`));
  let pages = [];
  for (let i = 0; i < 300 && !exited && !pages.some((p) => p.type === 'page'); i++) {
    try {
      pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  const target = pages.find((p) => p.type === 'page');
  if (!target) {
    proc.kill();
    throw new Error(`Chrome did not start (${bin}${exited ? `, ${exited}` : ', no answer in 30 s'})\n${stderr.trim().split('\n').slice(-15).join('\n')}`);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('cannot reach Chrome'));
  });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(`${msg.params.entry.text} ${msg.params.entry.url || ''}`.trim());
    }
  };
  const cmd = (method, params = {}) => new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await cmd('Runtime.enable');
  await cmd('Log.enable');
  const page = {
    cmd,
    /** Errors the page raised (uncaught exceptions, failed loads) since the last open(). */
    errors,
    async open(url, { width = 1000, height = 900, ready = 'true' } = {}) {
      errors.length = 0;
      await cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 600 });
      await cmd('Page.navigate', { url });
      for (let i = 0; i < 80; i++) {
        await sleep(125);
        if ((await page.eval(ready)) === true) return true;
      }
      return false;
    },
    /** Evaluates an expression (awaiting a promise) and returns its value; throws what the page threw. */
    async eval(expression) {
      const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) {
        throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
      }
      return r.result?.result?.value;
    },
    async screenshot() {
      const shot = await cmd('Page.captureScreenshot', { format: 'png' });
      return Buffer.from(shot.result.data, 'base64');
    },
    close() {
      ws.close();
      proc.kill();
      setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
    },
  };
  return page;
}
