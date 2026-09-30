// Browser tests: the cards in headless Chrome, on the offline preview (fake hass, synthetic house), clicked through
// the way a user would. Starts dev/serve.py itself when nothing is listening.
//
//   node dev/ui-test.mjs            (CHROME=/path/to/chrome to choose the browser)
//
// Exits non-zero when a check fails. Runs in CI next to the unit tests.

import { launchChrome, startServer } from './cdp.mjs';

const PORT = Number(process.env.PORT || 8766);
const BASE = `http://127.0.0.1:${PORT}/dev/card-preview.html?`;
const READY = "!!window.fake && !!document.getElementById('schedules')?.shadowRoot?.querySelector('.bars') && !!document.getElementById('shabbat')?.shadowRoot?.querySelector('.mode')";

// Helpers available inside every check.
const PRELUDE = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = () => document.getElementById('schedules').shadowRoot;
  const B = () => document.getElementById('shabbat').shadowRoot;
  const D = () => S().querySelector('dialog');
  const must = (cond, msg) => { if (!cond) throw new Error(msg); };
  const click = (el, what) => { must(el, 'missing: ' + what); el.click(); };
  const type = (el, v, what) => { must(el, 'missing: ' + what); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const toggle = (el, v, what) => { must(el, 'missing: ' + what); el.checked = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
  const posts = () => fake.calls.filter((c) => c.method === 'POST');
  const openEditor = async (id) => { click(S().querySelector('.row[data-id="' + id + '"]'), id); await sleep(400); must(D(), 'no dialog'); };
  const addRange = async (day, from, to) => {
    click(D().querySelector('[data-act=add][data-day="' + day + '"]'), 'add ' + day);
    D().querySelector('#from').value = from;
    D().querySelector('#to').value = to;
    click(D().querySelector('[data-act=rangeOk]'), 'ok');
  };
  // Day names never run into the ranges beside them.
  const noOverlap = () => {
    const rtl = D().getAttribute('dir') === 'rtl';
    for (const line of D().querySelectorAll('.day-line')) {
      const name = line.querySelector('.dname').getBoundingClientRect();
      const ranges = line.querySelector('.ranges').getBoundingClientRect();
      must(rtl ? name.left >= ranges.right - 1 : name.right <= ranges.left + 1, 'day name overlaps: ' + line.querySelector('.dname').textContent);
    }
  };
`;

const CHECKS = [
  ['both cards render the house', '', `
    must(S().querySelectorAll('.row').length === 7, 'rows: ' + S().querySelectorAll('.row').length);
    must(S().querySelectorAll('.row .bars').length === 7, 'every schedule has its week, YAML too');
    must(S().querySelectorAll('.row[data-id]').length === 6, 'the YAML schedule is not editable');
    must(S().querySelector('.lock'), 'YAML lock');
    must(B().querySelectorAll('.mode').length === 2, 'two modes');
    must(B().querySelectorAll('[data-automode]').length === 2, 'automatic Shabbat and chag');
    must(B().querySelector('.cal-date').textContent.includes('טבת'), 'calendar');
  `],
  ['a non-admin sees everything, edits nothing', 'admin=0', `
    must(!S().querySelector('[data-act=new]'), 'no New schedule');
    must(S().querySelectorAll('.row[data-id]').length === 0, 'no editable rows');
    must(S().querySelectorAll('.row .bars').length === 7, 'weeks via get_schedule');
    must([...B().querySelectorAll('[data-automode]')].every((i) => i.disabled), 'automatic switches disabled');
    must(!B().querySelector('[data-act=members]'), 'no Choose automations');
  `],
  ['create a schedule: device, action, hours, mode', '', `
    click(S().querySelector('[data-act=new]'), 'new');
    await sleep(200);
    click(D().querySelector('[data-act=pick]'), 'pick');
    await sleep(500);
    click(D().querySelector('[data-act=domain][data-v=climate]'), 'type chip');
    must([...D().querySelectorAll('.pick')].every((b) => b.dataset.id.startsWith('climate.')), 'chip filters');
    click(D().querySelector('[data-id="climate.kids_ac"]'), 'device');
    click(D().querySelector('[data-act=hvac][data-v=heat]'), 'heat');
    toggle(D().querySelector('[data-field=useTemp]'), true, 'temp');
    click(D().querySelector('[data-act=mode][data-mode="חג"]'), 'chag');
    await addRange(4, '7', '0');
    must(D().querySelector('.range').textContent.trim() === '07:00–24:00', 'typed 7 and 0: ' + D().querySelector('.range')?.textContent);
    click(D().querySelector('[data-act=save]'), 'save');
    await sleep(1500);
    must(!D(), 'dialog closed');
    const create = fake.calls.find((c) => c.type === 'schedule/create');
    must(create && create.thursday[0].to === '24:00:00', 'schedule/create');
    const on = posts()[0].body.actions[0].choose[0].sequence[0];
    must(on.action === 'climate.set_temperature' && on.data.hvac_mode === 'heat' && on.data.temperature === 25, JSON.stringify(on));
    must(fake.entities['schedule.mzgn_yldym'].labels.includes('khg'), 'labelled chag');
    must(S().querySelector('.row[data-id="schedule.mzgn_yldym"]'), 'row appears');
  `],
  ['edit a schedule: rename and change what it does', '', `
    await openEditor('schedule.living_room_ac_shabbat');
    must(D().querySelector('.device'), 'What it does section');
    click(D().querySelector('[data-act=temp][data-v="-1"]'), 'minus');
    type(D().querySelector('#name'), 'מזגן סלון לשבת', 'name');
    click(D().querySelector('[data-act=save]'), 'save');
    await sleep(800);
    must(posts().length === 1, 'one rewrite: ' + posts().length);
    const p = posts()[0];
    must(p.path === 'config/automation/config/1767000000001', p.path);
    must(p.body.alias === 'Beit · מזגן סלון לשבת', p.body.alias);
    must(p.body.actions[0].choose[0].sequence[0].data.temperature === 23, 'temperature');
  `],
  ['a hand-edited automation is never rewritten', '', `
    await openEditor('schedule.balcony_light');
    must(!D().querySelector('.device'), 'no device section for a hand-written automation');
    click(D().querySelector('[data-act=save]'), 'save');
    await sleep(500);
    must(posts().length === 0, 'nothing rewritten');
  `],
  ['the editor opens on the week HA has now, not a stale copy', '', `
    // Someone adds a Tuesday range elsewhere; the schedule's state does not change, so the card is not told.
    fake._schedules = fake._schedules.map((x) => (x.id === 'hot_plate_shabbat' ? { ...x, tuesday: [{ from: '10:00:00', to: '11:00:00' }] } : x));
    await openEditor('schedule.hot_plate_shabbat');
    must([...D().querySelectorAll('.day')][2].querySelector('.range')?.textContent.trim() === '10:00–11:00', 'Tuesday from HA');
  `],
  ['the dialog cannot be closed while it saves', '', `
    await openEditor('schedule.hot_plate_shabbat');
    fake.stateDelay = 0;
    const slow = fake.callWS.bind(fake);
    fake.callWS = async (m) => { if (m.type === 'schedule/update') await sleep(400); return slow(m); };
    click(D().querySelector('[data-act=save]'), 'save');
    await sleep(50);
    must(D().querySelector('[data-act=close]').disabled, 'close disabled while saving');
    D().querySelector('[data-act=close]').click();
    must(D(), 'still open');
    await sleep(700);
    must(!D(), 'closes once saved');
  `],
  ['range times: 24-hour text, errors kept in place', '', `
    await openEditor('schedule.bedroom_ac_shabbat');
    must(D().querySelector('[data-act=add]'), 'editor');
    click(D().querySelector('[data-act=add][data-day="1"]'), 'add');
    must(D().querySelector('#from').type === 'text', 'a text field, not the browser clock');
    D().querySelector('#from').value = 'abc';
    click(D().querySelector('[data-act=rangeOk]'), 'ok');
    must(D().querySelector('.panel .error'), 'error shown');
    must(D().querySelector('#from').value === 'abc', 'what was typed is kept');
    D().querySelector('#from').value = '20';
    D().querySelector('#to').value = '19';
    click(D().querySelector('[data-act=rangeOk]'), 'ok');
    must(/לפני/.test(D().querySelector('.panel .error').textContent), 'reversed range');
  `],
  ['delete keeps hand-written automations and says so', '', `
    await openEditor('schedule.living_room_ac_shabbat');
    click(D().querySelector('[data-act=askDelete]'), 'delete');
    click(D().querySelector('[data-act=doDelete]'), 'confirm');
    await sleep(600);
    must(!fake.states['schedule.living_room_ac_shabbat'], 'schedule gone');
    must(!fake.states['automation.beit_living_room_ac_shabbat'], 'Beit automation gone');
    must(fake.states['automation.living_room_fan_shabbat'], 'hand-written one kept');
    const toasts = [...S().children].filter((c) => c.classList.contains('toast'));
    must(toasts.length === 1, 'one toast element: ' + toasts.length);
    must(!toasts[0].hidden && toasts[0].textContent.includes('מאוורר סלון בשבת'), 'kept list shown');
  `],
  ['day names fit, Hebrew', '', `
    await openEditor('schedule.bedroom_ac_shabbat');
    noOverlap();
  `],
  ['day names fit, English', 'lang=en', `
    await openEditor('schedule.bedroom_ac_shabbat');
    noOverlap();
  `],
  ['day names fit on a phone', 'lang=en&width=390', `
    await openEditor('schedule.bedroom_ac_shabbat');
    noOverlap();
  `],
  ['the mode switch turns every member on', '', `
    toggle(B().querySelector('[data-master="שבת"]'), true, 'master');
    await sleep(300);
    for (const id of ['automation.beit_bedroom_ac_shabbat', 'automation.beit_hot_plate_shabbat', 'automation.living_room_fan_shabbat']) {
      must(fake.states[id].state === 'on', id);
    }
  `],
  ['taking an automation out keeps a schedule another member follows', '', `
    click(B().querySelector('[data-act=members][data-mode="שבת"]'), 'Choose automations');
    await sleep(200);
    const dlg = B().querySelector('dialog');
    must(![...dlg.querySelectorAll('[data-id]')].some((b) => b.closest('label').textContent.includes('אוטומטי')), 'automatic ones are not offered');
    toggle(dlg.querySelector('[data-id="automation.living_room_fan_shabbat"]'), false, 'fan');
    await sleep(500);
    must(!fake.entities['automation.living_room_fan_shabbat'].labels.includes('shbt'), 'fan out');
    must(fake.entities['schedule.living_room_ac_shabbat'].labels.includes('shbt'), 'schedule still in the mode');
  `],
  ['automatic Shabbat: a start before candle lighting, off disables', '', `
    click(B().querySelector('[data-act=startEdit][data-mode="שבת"]'), 'change start');
    toggle(B().querySelector('[data-start-kind][value=hoursBefore]'), true, 'hours before');
    type(B().getElementById('start-hb'), '3', 'hours');
    click(B().querySelector('[data-act=startSave]'), 'save start');
    await sleep(100);
    toggle(B().querySelector('[data-automode="שבת"]'), true, 'switch on');
    await sleep(1200);
    const p = posts().find((c) => c.body.alias === 'Beit · מצב שבת אוטומטי');
    must(p && p.body.triggers[0].at.offset === '-03:00:00', 'offset: ' + JSON.stringify(p?.body.triggers[0]));
    toggle(B().querySelector('[data-automode="שבת"]'), false, 'switch off');
    await sleep(600);
    const id = Object.keys(fake.states).find((k) => fake.states[k].attributes.friendly_name === 'Beit · מצב שבת אוטומטי');
    must(id && fake.states[id].state === 'off', 'disabled, still there');
    must(!fake.calls.some((c) => c.method === 'DELETE'), 'never deleted');
  `],
  ['automatic chag is created with the Jewish Calendar', '', `
    toggle(B().querySelector('[data-automode="חג"]'), true, 'chag on');
    await sleep(1200);
    const p = posts().find((c) => c.body.alias === 'Beit · מצב חג אוטומטי');
    must(p, 'created');
    must(p.body.triggers[1].entity_id[0].startsWith('binary_sensor.jewish_calendar_issur_melacha'), 'ends with issur melacha');
    must(B().querySelector('[data-automode="חג"]').checked, 'shown on');
  `],
  ['show_modes: false hides Shabbat and chag', 'schedules=' + encodeURIComponent('{"show_modes":false}'), `
    must(!S().querySelector('.list .chip'), 'no mode chips');
    await openEditor('schedule.bedroom_ac_shabbat');
    must(!D().querySelector('.seg'), 'no mode choice');
  `],
  ['a fixed height scrolls inside the card', 'schedules=' + encodeURIComponent('{"height":"400px"}'), `
    const card = S().querySelector('ha-card');
    must(Math.round(card.getBoundingClientRect().height) === 400, 'height ' + card.getBoundingClientRect().height);
    const sc = S().querySelector('.scroll');
    must(sc.scrollHeight > sc.clientHeight && getComputedStyle(sc).overflowY === 'auto', 'scrolls');
  `],
  ['the visual editor creates the Beit dashboard, once', 'editors=1', `
    const ed = document.querySelector('beit-schedule-card-editor').shadowRoot;
    await sleep(200);
    click(ed.querySelector('[data-act=makeDash]'), 'create button');
    await sleep(300);
    must(fake._dashboards.some((d) => d.url_path === 'beit-schedules'), 'dashboard created');
    must(fake._lovelace['beit-schedules'].views[0].cards.length === 2, 'with both cards');
    must(ed.querySelector('[data-dash] a[href="/beit-schedules/beit"]'), 'Open link');
    must(!ed.querySelector('[data-act=makeDash]'), 'no second button');
  `],
  ['a non-admin editor offers no dashboard', 'editors=1&admin=0', `
    await sleep(300);
    must(document.querySelector('beit-schedule-card-editor').shadowRoot.querySelector('[data-dash]').hidden, 'hidden');
  `],
  ['the visual editor limits device types', 'editors=1', `
    const ed = document.querySelector('beit-schedule-card-editor').shadowRoot;
    toggle(ed.querySelector('[data-domain=climate]'), false, 'climate');
    await sleep(100);
    click(S().querySelector('[data-act=new]'), 'new');
    await sleep(200);
    click(D().querySelector('[data-act=pick]'), 'pick');
    await sleep(500);
    must(![...D().querySelectorAll('.pick')].some((b) => b.dataset.id.startsWith('climate.')), 'no air conditioners offered');
  `],
];

const stopServer = await startServer(PORT);
const page = await launchChrome();
let failed = 0;
try {
  for (const [name, query, body] of CHECKS) {
    const width = Number(new URLSearchParams(query).get('width')) || 1000;
    try {
      if (!(await page.open(BASE + query, { width, height: 900, ready: READY }))) {
        throw new Error(`page not ready: ${page.errors.join(' | ') || 'no error reported'}`);
      }
      await page.eval(`(async () => { ${PRELUDE}\n${body}\n })()`);
      console.log(`✔ ${name}`);
    } catch (err) {
      failed++;
      console.log(`✖ ${name}\n    ${String(err.message).split('\n')[0]}`);
    }
  }
} finally {
  page.close();
  stopServer();
}
console.log(`\n${CHECKS.length - failed}/${CHECKS.length} passed`);
process.exitCode = failed ? 1 : 0;
