// The README screenshots, from the offline preview (the synthetic house, in English). Starts dev/serve.py itself
// when nothing is listening.
//
//   node dev/screenshots.mjs        (CHROME=/path/to/chrome to choose the browser)
//
// Each shot waits until the page is really drawn: plain `chrome --screenshot` often captures an empty page.

import { writeFileSync } from 'node:fs';
import { launchChrome, startServer, sleep } from './cdp.mjs';

const PORT = Number(process.env.PORT || 8766);
const BASE = `http://127.0.0.1:${PORT}/dev/card-preview.html?clean=1&`;
const CARDS = "!!document.getElementById('schedules')?.shadowRoot?.querySelector('.bars') && !!document.getElementById('shabbat')?.shadowRoot?.querySelector('.mode')";
const DIALOG = "!!document.getElementById('schedules')?.shadowRoot?.querySelector('dialog[open] .days')";
const SHOTS = [
  ['card.png', 880, 1210, 'lang=en', CARDS],
  ['editor.png', 760, 1000, 'lang=en&open=schedule.living_room_ac_shabbat', `${DIALOG} && !!document.getElementById('schedules').shadowRoot.querySelector('dialog .device')`],
  ['new-schedule.png', 760, 1000, 'lang=en&open=new&device=climate.living_room_ac', `${DIALOG} && !!document.getElementById('schedules').shadowRoot.querySelector('dialog [data-field=useTemp]')`],
  ['dark-english.png', 880, 1000, 'lang=en&theme=dark&schedules=%7B%22height%22%3A900%7D&shabbat=%7B%22height%22%3A900%7D', CARDS],
  ['mobile.png', 390, 844, 'lang=en&open=schedule.bedroom_ac_shabbat', DIALOG],
];

const stopServer = await startServer(PORT);
const page = await launchChrome();
try {
  for (const [file, width, height, query, ready] of SHOTS) {
    const ok = await page.open(BASE + query, { width, height, ready });
    await sleep(600);
    writeFileSync(new URL(`../docs/${file}`, import.meta.url), await page.screenshot());
    console.log(file, ok ? 'ready' : `NOT READY ${page.errors.join(' | ')}`);
  }
} finally {
  page.close();
  stopServer();
}
