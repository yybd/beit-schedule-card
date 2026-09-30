// The README screenshots, from the offline preview (synthetic data). Run with dev/serve.py up:
//
//   node dev/screenshots.mjs
//
// Drives headless Chrome over the DevTools protocol and waits until each page is really drawn
// (plain --screenshot often captures an empty page). CHROME overrides the browser path.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9339;
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, '--hide-scrollbars', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'beit-shots-'))}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pages;
for (let i = 0; i < 50; i++) { try { pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (pages.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const BASE = 'http://localhost:8766/dev/card-preview.html?clean=1&';
const CARDS = "!!document.getElementById('schedules').shadowRoot?.querySelector('.bars') && !!document.getElementById('shabbat').shadowRoot?.querySelector('.mode')";
const DIALOG = "!!document.getElementById('schedules').shadowRoot?.querySelector('dialog[open] .days')";
const shots = [
  ['card.png', 880, 1210, 'lang=en', CARDS],
  ['editor.png', 760, 1000, 'lang=en&open=schedule.living_room_ac_shabbat', DIALOG + " && !!document.getElementById('schedules').shadowRoot.querySelector('dialog .linked .opt')"],
  ['new-schedule.png', 760, 1000, 'lang=en&open=new&device=climate.living_room_ac', DIALOG + " && !!document.getElementById('schedules').shadowRoot.querySelector('dialog [data-field=useTemp]')"],
  ['dark-english.png', 880, 1000, 'lang=en&theme=dark&schedules=%7B%22height%22%3A900%7D&shabbat=%7B%22height%22%3A900%7D', CARDS],
  ['mobile.png', 390, 844, 'lang=en&open=schedule.bedroom_ac_shabbat', DIALOG],
];
for (const [file, w, h, query, ready] of shots) {
  await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 600 });
  await cmd('Page.navigate', { url: BASE + query });
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    await sleep(250);
    const r = await cmd('Runtime.evaluate', { expression: ready, returnByValue: true });
    ok = r.result?.result?.value === true;
  }
  await sleep(600);
  const shot = await cmd('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`docs/${file}`, Buffer.from(shot.result.data, 'base64'));
  console.log(file, ok ? 'ready' : 'NOT READY');
}
ws.close(); chrome.kill();
