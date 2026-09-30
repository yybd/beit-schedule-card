// The HA operations, run against the in-memory fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeHass, slugify } from './fake-hass.mjs';
import {
  WeekSchedule, listSchedules, createScheduleWithAutomation, updateSchedule, deleteSchedule, automationsFor,
  setAutomationEnabled, ensureLabel, setModeMembership, setModeEnabled, modeMembers, loadRegistry, findAutoShabbat,
  enableAutoShabbat, disableAutoShabbat, isOurs, weekStatus, errorText, AUTO_SHABBAT_ALIAS, BEIT_MARKER,
} from '../dist/beit-schedule-card.js';

const NAMES = ['states', 'schedule_list', 'automation_configs', 'label_registry', 'entity_registry_display', 'area_registry', 'device_registry', 'yaml_schedules'];
export const fixtures = Object.fromEntries(NAMES.map((n) => [n, JSON.parse(readFileSync(new URL(`fixtures/${n}.json`, import.meta.url)))]));
// A Sunday morning, local time.
const SUNDAY_9AM = () => new Date(2026, 0, 4, 9, 0, 0);
const house = (opts = {}) => new FakeHass(fixtures, { now: SUNDAY_9AM, ...opts });
const FAST = { waitOptions: { tries: 20, every: 5 } };

const week = (name, days) => new WeekSchedule({ name, days });
const writes = (hass) => hass.calls.filter((c) => !['schedule/list', 'search/related', 'automation/config', 'config/label_registry/list',
  'config/entity_registry/list_for_display', 'config/area_registry/list', 'config/device_registry/list'].includes(c.type) && c.method !== 'GET');

// ---- schedules -----------------------------------------------------------------------------------------------------

test('listSchedules returns every UI schedule, not the YAML one', async () => {
  const hass = house();
  const all = await listSchedules(hass);
  assert.equal(Object.keys(all).length, 6);
  assert.ok(!('pool_pump' in all));
  assert.ok(hass.states['schedule.pool_pump']);
  assert.equal(all.balcony_light.days.sunday[0].end, 1440);
});

test('create: schedule, then its automation, in that order; the automation is on', async () => {
  const hass = house();
  const w = week('Night light', { monday: [{ start: 1200, end: 1440 }] });
  const id = await createScheduleWithAutomation(hass, w, { entityId: 'switch.night_light', name: 'מנורת לילה' }, FAST);
  assert.equal(id, 'schedule.night_light');
  const [create, post] = writes(hass);
  assert.equal(create.type, 'schedule/create');
  assert.deepEqual(create.monday, [{ from: '20:00:00', to: '24:00:00' }]);
  assert.equal(post.method, 'POST');
  assert.equal(post.path, `config/automation/config/${post.body.id}`);
  assert.ok(isOurs(post.body));
  assert.deepEqual(post.body.triggers[0].entity_id, ['schedule.night_light']);
  await new Promise((r) => setTimeout(r, 20));
  const auto = Object.values(hass.states).find((s) => s.attributes.id === post.body.id);
  assert.equal(auto.state, 'on');
  assert.deepEqual(await automationsFor(hass, id), [auto.entity_id]);
});

test('create with a mode labels both the schedule and its automation, keeping other labels', async () => {
  const hass = house();
  const id = await createScheduleWithAutomation(hass, week('פלטה 2', { friday: [{ start: 900, end: 1440 }] }),
    { entityId: 'switch.hot_plate', name: 'פלטה' }, { labelName: 'שבת', ...FAST });
  const reg = await loadRegistry(hass);
  assert.deepEqual(reg.entityLabels[id], ['shbt']);
  const autos = await automationsFor(hass, id);
  assert.deepEqual(reg.entityLabels[autos[0]], ['shbt']);
});

test('create rolls back the helper when the automation cannot be written', async () => {
  const hass = house();
  hass.failNext('POST config/automation/config', 'Message malformed: extra keys not allowed');
  await assert.rejects(
    createScheduleWithAutomation(hass, week('Doomed', { monday: [{ start: 60, end: 120 }] }), { entityId: 'switch.night_light', name: 'x' }, FAST),
    /Message malformed/,
  );
  const w = writes(hass);
  assert.deepEqual(w.map((c) => c.type || `${c.method} ${c.path.split('/').slice(0, 3).join('/')}`),
    ['schedule/create', 'POST config/automation/config', 'schedule/delete']);
  assert.equal(w[2].schedule_id, 'doomed');
  assert.ok(!('doomed' in (await listSchedules(hass))));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!hass.states['schedule.doomed']);
});

test('HA rejects an overlapping week, and the error text comes through', async () => {
  const hass = house();
  const w = week('Bad', { monday: [{ start: 60, end: 180 }, { start: 120, end: 200 }] });
  await assert.rejects(createScheduleWithAutomation(hass, w, { entityId: 'switch.night_light' }, FAST), (err) => {
    assert.match(errorText(err), /Overlapping/);
    return true;
  });
});

test('update sends the full body and changes the state', async () => {
  const hass = house();
  const all = await listSchedules(hass);
  const w = all.water_heater_weekdays;
  w.days.sunday = [{ start: 8 * 60, end: 10 * 60 }];
  await updateSchedule(hass, 'water_heater_weekdays', w);
  const call = writes(hass)[0];
  assert.equal(call.schedule_id, 'water_heater_weekdays');
  for (const d of ['name', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']) assert.ok(d in call, d);
  // Sunday 09:00 is now inside the range.
  assert.equal(hass.states['schedule.water_heater_weekdays'].state, 'on');
});

test('delete removes Beit automations and keeps hand-written ones', async () => {
  const hass = house();
  const kept = await deleteSchedule(hass, 'schedule.living_room_ac_shabbat');
  assert.deepEqual(kept, ['מאוורר סלון בשבת']);
  const w = writes(hass);
  assert.deepEqual(w.map((c) => c.type || `${c.method} ${c.path}`), ['DELETE config/automation/config/1767000000001', 'schedule/delete']);
  assert.ok(!hass.states['automation.beit_living_room_ac_shabbat']);
  assert.ok(hass.states['automation.living_room_fan_shabbat']);
  assert.ok(!hass.states['schedule.living_room_ac_shabbat']);
});

test('delete of a schedule driven only by hand-written automations deletes no automation', async () => {
  const hass = house();
  const kept = await deleteSchedule(hass, 'schedule.balcony_light');
  assert.deepEqual(kept, ['תאורת מרפסת בערב']);
  assert.ok(!writes(hass).some((c) => c.method === 'DELETE'));
});

test('setAutomationEnabled', async () => {
  const hass = house();
  await setAutomationEnabled(hass, 'automation.beit_bedroom_ac_shabbat', true);
  assert.equal(hass.states['automation.beit_bedroom_ac_shabbat'].state, 'on');
  await setAutomationEnabled(hass, 'automation.beit_bedroom_ac_shabbat', false);
  assert.equal(hass.states['automation.beit_bedroom_ac_shabbat'].state, 'off');
});

// ---- modes ---------------------------------------------------------------------------------------------------------

test('modeMembers finds a mode by label name', async () => {
  const hass = house();
  const reg = await loadRegistry(hass);
  assert.deepEqual(modeMembers(hass.states, reg, 'שבת').map((e) => e.entity_id).sort(), [
    'automation.beit_bedroom_ac_shabbat', 'automation.beit_hot_plate_shabbat', 'automation.beit_living_room_ac_shabbat', 'automation.living_room_fan_shabbat',
  ]);
  assert.deepEqual(modeMembers(hass.states, reg, 'חג', 'schedule').map((e) => e.entity_id), ['schedule.kids_ac_chag']);
  assert.deepEqual(modeMembers(hass.states, reg, 'nope'), []);
});

test('ensureLabel creates a missing label with the contract icon and colour, once', async () => {
  const hass = new FakeHass({ ...fixtures, label_registry: [] }, { now: SUNDAY_9AM });
  const label = await ensureLabel(hass, 'שבת');
  assert.deepEqual([label.name, label.icon, label.color], ['שבת', 'mdi:candle', 'amber']);
  const again = await ensureLabel(hass, 'שבת');
  assert.equal(again.label_id, label.label_id);
  assert.equal(hass.calls.filter((c) => c.type === 'config/label_registry/create').length, 1);
  const chag = await ensureLabel(hass, 'חג');
  assert.deepEqual([chag.icon, chag.color], ['mdi:star-david', 'indigo']);
});

test('setModeMembership merges labels and skips entities already right', async () => {
  const hass = house();
  await setModeMembership(hass, 'שבת', ['schedule.water_heater_weekdays', 'schedule.hot_plate_shabbat'], true);
  const updates = hass.calls.filter((c) => c.type === 'config/entity_registry/update');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].labels, ['energy', 'shbt']);
  await setModeMembership(hass, 'שבת', ['schedule.water_heater_weekdays'], false);
  assert.deepEqual((await loadRegistry(hass)).entityLabels['schedule.water_heater_weekdays'], ['energy']);
  assert.deepEqual(hass.entities['schedule.water_heater_weekdays'].labels, ['energy']);
});

test('setModeEnabled switches every member in one call', async () => {
  const hass = house();
  const reg = await loadRegistry(hass);
  await setModeEnabled(hass, reg, 'שבת', true);
  const call = hass.calls.at(-1);
  assert.equal(call.service, 'turn_on');
  assert.equal(call.target.entity_id.length, 4);
  for (const m of modeMembers(hass.states, reg, 'שבת')) assert.equal(m.state, 'on');
  await setModeEnabled(hass, reg, 'שבת', false);
  for (const m of modeMembers(hass.states, reg, 'שבת')) assert.equal(m.state, 'off');
});

// ---- automatic Shabbat ---------------------------------------------------------------------------------------------

test('enableAutoShabbat creates exactly one automation, then recognises it', async () => {
  const hass = house();
  assert.equal(await findAutoShabbat(hass), null);
  const id = await enableAutoShabbat(hass, FAST);
  const found = await findAutoShabbat(hass);
  assert.equal(found.entityId, id);
  assert.ok(found.ours);
  // Uses Jewish Calendar, which the synthetic house has.
  assert.deepEqual(found.config.triggers[1].entity_id, ['binary_sensor.jewish_calendar_issur_melacha_in_effect_2']);
  assert.equal(found.config.actions[0].choose[0].sequence[0].target.label_id, 'shbt');
  // Turned off by hand, then enabled again: switched on, not duplicated.
  await setAutomationEnabled(hass, id, false);
  await enableAutoShabbat(hass, FAST);
  assert.equal(hass.states[id].state, 'on');
  assert.equal(hass.calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(Object.values(hass.states).filter((s) => s.attributes.friendly_name === AUTO_SHABBAT_ALIAS).length, 1);
});

test('enableAutoShabbat falls back to Hebcal', async () => {
  const states = fixtures.states.filter((s) => !s.entity_id.includes('jewish_calendar'));
  const hass = new FakeHass({ ...fixtures, states }, { now: SUNDAY_9AM });
  const id = await enableAutoShabbat(hass, FAST);
  const { config } = await findAutoShabbat(hass);
  assert.deepEqual(config.triggers[1], { trigger: 'state', entity_id: ['sensor.hebcal_is_shabbat'], from: 'True', to: 'False', id: 'motzei_shabbat' });
  assert.ok(id.startsWith('automation.'));
});

test('enableAutoShabbat refuses without a calendar', async () => {
  const states = fixtures.states.filter((s) => !s.entity_id.includes('jewish_calendar') && !s.entity_id.includes('hebcal'));
  const hass = new FakeHass({ ...fixtures, states }, { now: SUNDAY_9AM });
  await assert.rejects(enableAutoShabbat(hass, FAST), /לוח שנה/);
});

test('an existing auto-Shabbat automation with the marker is recognised and never duplicated', async () => {
  const existing = {
    id: '1700000000000', alias: AUTO_SHABBAT_ALIAS, description: `${BEIT_MARKER} — older wording`, mode: 'single',
    triggers: [{ trigger: 'time', at: '12:00:00', id: 'erev_shabbat' }], conditions: [], actions: [],
  };
  const states = [...fixtures.states, {
    entity_id: 'automation.auto_shabbat_older', state: 'on', attributes: { id: existing.id, friendly_name: AUTO_SHABBAT_ALIAS },
    last_changed: '', last_updated: '',
  }];
  const hass = new FakeHass({ ...fixtures, states, automation_configs: { ...fixtures.automation_configs, 'automation.auto_shabbat_older': existing } },
    { now: SUNDAY_9AM });
  assert.equal((await findAutoShabbat(hass)).entityId, 'automation.auto_shabbat_older');
  assert.equal(await enableAutoShabbat(hass, FAST), 'automation.auto_shabbat_older');
  assert.ok(!hass.calls.some((c) => c.method === 'POST'));
  // Switching off disables it; it is never deleted.
  assert.equal(await disableAutoShabbat(hass), 'turned_off');
  assert.equal(hass.states['automation.auto_shabbat_older'].state, 'off');
  assert.ok(!hass.calls.some((c) => c.method === 'DELETE'));
  // On again: the same automation, not a new one.
  assert.equal(await enableAutoShabbat(hass, FAST), 'automation.auto_shabbat_older');
  assert.equal(hass.states['automation.auto_shabbat_older'].state, 'on');
  assert.ok(!hass.calls.some((c) => c.method === 'POST'));
});

test('a hand-written automation with the same alias is only switched off, never deleted', async () => {
  const handWritten = { id: '42', alias: AUTO_SHABBAT_ALIAS, description: 'mine', triggers: [{ trigger: 'time', at: '12:00:00' }], conditions: [], actions: [], mode: 'single' };
  const states = [...fixtures.states, { entity_id: 'automation.my_auto', state: 'on', attributes: { id: '42', friendly_name: AUTO_SHABBAT_ALIAS }, last_changed: '', last_updated: '' }];
  const hass = new FakeHass({ ...fixtures, states, automation_configs: { ...fixtures.automation_configs, 'automation.my_auto': handWritten } }, { now: SUNDAY_9AM });
  assert.equal(await disableAutoShabbat(hass), 'turned_off');
  assert.ok(hass.states['automation.my_auto']);
  assert.equal(hass.states['automation.my_auto'].state, 'off');
  assert.ok(!hass.calls.some((c) => c.method === 'DELETE'));
});

// ---- the fake behaves like HA ------------------------------------------------------------------------------------------

test('weekStatus: state and next_event', () => {
  const w = WeekSchedule.fromHA(fixtures.schedule_list.find((s) => s.id === 'living_room_ac_shabbat'));
  // Friday 17:00: on until Saturday 09:30 (Friday's 24:00 runs into Saturday's 00:00).
  let s = weekStatus(w, new Date(2026, 0, 9, 17, 0));
  assert.equal(s.on, true);
  assert.deepEqual([s.next.getDay(), s.next.getHours(), s.next.getMinutes()], [6, 9, 30]);
  // Saturday 10:00: off until 13:30.
  s = weekStatus(w, new Date(2026, 0, 10, 10, 0));
  assert.equal(s.on, false);
  assert.deepEqual([s.next.getDay(), s.next.getHours(), s.next.getMinutes()], [6, 13, 30]);
  // Sunday: off until Friday 16:00.
  s = weekStatus(w, SUNDAY_9AM());
  assert.deepEqual([s.on, s.next.getDay(), s.next.getHours()], [false, 5, 16]);
  // A range running across the week boundary: Saturday 22:00 → Sunday 02:00.
  const wrap = new WeekSchedule({ name: 'w', days: { saturday: [{ start: 1320, end: 1440 }], sunday: [{ start: 0, end: 120 }] } });
  s = weekStatus(wrap, new Date(2026, 0, 4, 1, 0));
  assert.deepEqual([s.on, s.next.getDay(), s.next.getHours()], [true, 0, 2]);
  assert.deepEqual(weekStatus(new WeekSchedule({ name: 'e' })), { on: false, next: null });
});

test('slugify approximates HA for Hebrew names', () => {
  assert.equal(slugify('Night light'), 'night_light');
  assert.equal(slugify('מזגן סלון'), 'mzgn_slvn');
});

// ---- renaming ------------------------------------------------------------------------------------------------------

import { parseScheduleAutomation, renameScheduleAutomations, buildScheduleAutomation } from '../dist/beit-schedule-card.js';

test('parseScheduleAutomation reads back exactly what the builder wrote, and nothing edited by hand', () => {
  for (const target of [
    { entityId: 'climate.a', name: 'מזגן', hvacMode: 'heat', temperature: 23, brightnessPct: null, turnOffAtEnd: true },
    { entityId: 'climate.a', name: 'מזגן', hvacMode: 'cool', temperature: null, brightnessPct: null, turnOffAtEnd: false },
    { entityId: 'light.l', name: 'אור', hvacMode: null, temperature: null, brightnessPct: 40, turnOffAtEnd: true },
    { entityId: 'water_heater.w', name: 'דוד', hvacMode: null, temperature: 60, brightnessPct: null, turnOffAtEnd: true },
    { entityId: 'cover.c', name: 'תריס', hvacMode: null, temperature: null, brightnessPct: null, turnOffAtEnd: true },
  ]) {
    const cfg = buildScheduleAutomation({ id: '9', scheduleEntityId: 'schedule.s', scheduleName: 'שם', target });
    assert.deepEqual(parseScheduleAutomation(cfg), { scheduleEntityId: 'schedule.s', scheduleName: 'שם', target }, target.entityId);
  }
  const cfg = buildScheduleAutomation({ id: '9', scheduleEntityId: 'schedule.s', scheduleName: 'שם', target: { entityId: 'switch.x', name: 'x' } });
  assert.equal(parseScheduleAutomation({ ...cfg, mode: 'single' }), null, 'edited by hand');
  assert.equal(parseScheduleAutomation({ ...cfg, description: 'mine' }), null, 'no marker');
  // Fixture automations the card wrote parse; hand-written ones don't.
  assert.ok(parseScheduleAutomation(fixtures.automation_configs['automation.beit_bedroom_ac_shabbat']));
  assert.equal(parseScheduleAutomation(fixtures.automation_configs['automation.living_room_fan_shabbat']), null);
});

test('renaming a schedule renames only the Beit automations still named after it', async () => {
  const hass = house();
  const autos = await automationsFor(hass, 'schedule.living_room_ac_shabbat');
  const renamed = await renameScheduleAutomations(hass, autos, 'מזגן סלון שבת', 'מזגן סלון לשבת');
  assert.deepEqual(renamed, ['automation.beit_living_room_ac_shabbat']);
  const post = hass.calls.find((c) => c.method === 'POST');
  assert.equal(post.path, 'config/automation/config/1767000000001');
  assert.equal(post.body.alias, 'Beit · מזגן סלון לשבת');
  // Everything else is as it was.
  assert.deepEqual({ ...post.body, alias: null }, { ...fixtures.automation_configs['automation.beit_living_room_ac_shabbat'], alias: null });
  // The hand-written one, and a Beit one renamed by the user, stay.
  assert.deepEqual(await renameScheduleAutomations(house(), autos, 'שם אחר', 'חדש'), []);
  assert.deepEqual(await renameScheduleAutomations(house(), autos, 'x', 'x'), []);
});

import { rewriteScheduleAutomation } from '../dist/beit-schedule-card.js';

test('rewriteScheduleAutomation changes device and action under the same id, and only when something changed', async () => {
  const hass = house();
  const cfg = fixtures.automation_configs['automation.beit_bedroom_ac_shabbat'];
  assert.equal(await rewriteScheduleAutomation(hass, cfg, {}), false);
  assert.equal(hass.calls.filter((c) => c.method === 'POST').length, 0);
  const target = { entityId: 'climate.bedroom_ac', name: 'מזגן חדר שינה', hvacMode: 'heat', temperature: 22, brightnessPct: null, turnOffAtEnd: true };
  assert.equal(await rewriteScheduleAutomation(hass, cfg, { scheduleName: 'מזגן חדר שינה שבת', target }), true);
  const post = hass.calls.find((c) => c.method === 'POST');
  assert.equal(post.path, 'config/automation/config/1767000000002');
  assert.deepEqual(post.body.actions[0].choose[0].sequence[0].data, { temperature: 22, hvac_mode: 'heat' });
  await new Promise((r) => setTimeout(r, 20));
  // Same entity, same on/off state.
  assert.equal(hass.states['automation.beit_bedroom_ac_shabbat'].state, 'off');
  await assert.rejects(rewriteScheduleAutomation(hass, fixtures.automation_configs['automation.living_room_fan_shabbat'], { target }), /by hand/);
});

// ---- automatic modes: start time and chag ------------------------------------------------------------------------

import {
  autoStartTrigger, parseAutoStart, autoAvailable, buildAutoModeAutomation, enableAuto, disableAuto, setAutoStart, findAuto,
  findCalendar, AUTO_ALIAS, startText,
} from '../dist/beit-schedule-card.js';

const calOf = (states) => findCalendar(Object.fromEntries(states.map((s) => [s.entity_id, s])));

test('the start of an automatic mode: a time of day, or hours before candle lighting', () => {
  const cal = calOf(fixtures.states);
  assert.deepEqual(autoStartTrigger('שבת', { at: '13:30' }, cal), { trigger: 'time', at: '13:30:00', id: 'erev_shabbat' });
  assert.deepEqual(autoStartTrigger('שבת', { hoursBefore: 3 }, cal),
    { trigger: 'time', at: { entity_id: 'sensor.jewish_calendar_upcoming_shabbat_candle_lighting_2', offset: '-03:00:00' }, id: 'erev_shabbat' });
  assert.deepEqual(autoStartTrigger('חג', { hoursBefore: 1.5 }, cal).at,
    { entity_id: 'sensor.jewish_calendar_upcoming_candle_lighting_2', offset: '-01:30:00' });
  // Hebcal has no timestamp to count back from.
  assert.equal(autoStartTrigger('שבת', { hoursBefore: 2 }, { hebcal: { isShabbat: 'sensor.hebcal_is_shabbat' } }), null);
  for (const start of [{ at: '12:00' }, { at: '09:15' }, { hoursBefore: 4 }, { hoursBefore: 2.5 }]) {
    for (const mode of ['שבת', 'חג']) {
      assert.deepEqual(parseAutoStart(buildAutoModeAutomation({ id: '1', mode, labelId: 'l', start, cal })), start, `${mode} ${JSON.stringify(start)}`);
    }
  }
  assert.equal(startText({ hoursBefore: 3 }), '3 שעות לפני הדלקת הנרות');
  assert.equal(startText({ at: '12:00' }, 'en'), 'at 12:00');
});

test('automatic chag: on at erev chag (a Friday only when a chag joins Shabbat), off after it, Jewish Calendar only', () => {
  const cal = calOf(fixtures.states);
  const a = buildAutoModeAutomation({ id: '7', mode: 'חג', labelId: 'khg', cal });
  assert.equal(a.alias, AUTO_ALIAS['חג']);
  assert.ok(isOurs(a));
  const [on, off] = a.actions[0].choose;
  const tpl = on.conditions[1].value_template;
  assert.match(tpl, /is_state\('binary_sensor\.jewish_calendar_erev_shabbat_hag_2', 'on'\)/);
  assert.match(tpl, /now\(\)\.weekday\(\) != 4/);
  assert.match(tpl, /> 129600/);
  assert.deepEqual(on.sequence, [{ action: 'automation.turn_on', target: { label_id: 'khg' } }]);
  assert.deepEqual(a.triggers[1], { trigger: 'state', entity_id: ['binary_sensor.jewish_calendar_issur_melacha_in_effect_2'], from: 'on', to: 'off', id: 'motzei_chag' });
  assert.match(off.sequence[0].wait_template, /label_entities\('khg'\)/);
  assert.equal(autoAvailable('חג', cal), true);
  assert.equal(autoAvailable('חג', calOf(fixtures.states.filter((s) => !s.entity_id.includes('jewish_calendar')))), false);
  assert.equal(autoAvailable('שבת', calOf(fixtures.states.filter((s) => !s.entity_id.includes('jewish_calendar')))), true);
});

test('enableAuto creates automatic chag once, disableAuto only disables it', async () => {
  const hass = house();
  const id = await enableAuto(hass, 'חג', { start: { hoursBefore: 2 }, ...FAST });
  assert.equal(hass.states[id].attributes.friendly_name, AUTO_ALIAS['חג']);
  assert.deepEqual(parseAutoStart((await findAuto(hass, 'חג')).config), { hoursBefore: 2 });
  assert.equal(await disableAuto(hass, 'חג'), 'turned_off');
  assert.equal(hass.states[id].state, 'off');
  assert.equal(await enableAuto(hass, 'חג', FAST), id);
  assert.equal(hass.calls.filter((c) => c.method === 'POST').length, 1);
  const hebcalOnly = new FakeHass({ ...fixtures, states: fixtures.states.filter((s) => !s.entity_id.includes('jewish_calendar')) }, { now: SUNDAY_9AM });
  await assert.rejects(enableAuto(hebcalOnly, 'חג', FAST), /Jewish Calendar/);
});

test('setAutoStart replaces only the start trigger, and the description while it is still ours', async () => {
  const hass = house();
  await enableAuto(hass, 'שבת', FAST);
  const before = (await findAuto(hass, 'שבת')).config;
  assert.equal(await setAutoStart(hass, 'שבת', { hoursBefore: 4 }), true);
  const after = (await findAuto(hass, 'שבת')).config;
  assert.deepEqual(parseAutoStart(after), { hoursBefore: 4 });
  assert.deepEqual(after.triggers[1], before.triggers[1]);
  assert.deepEqual(after.actions, before.actions);
  assert.match(after.description, /4 שעות לפני הדלקת הנרות/);
  assert.equal(await setAutoStart(hass, 'שבת', { hoursBefore: 4 }), false);
  // An older wording is left alone, only the trigger changes.
  const older = new FakeHass({
    ...fixtures,
    states: [...fixtures.states, { entity_id: 'automation.auto', state: 'on', attributes: { id: '5', friendly_name: AUTO_ALIAS['שבת'] }, last_changed: '', last_updated: '' }],
    automation_configs: { ...fixtures.automation_configs, 'automation.auto': { ...before, id: '5', description: `${BEIT_MARKER} — older wording` } },
  }, { now: SUNDAY_9AM });
  await setAutoStart(older, 'שבת', { at: '13:00' });
  const cfg = (await findAuto(older, 'שבת')).config;
  assert.equal(cfg.description, `${BEIT_MARKER} — older wording`);
  assert.equal(cfg.triggers[0].at, '13:00:00');
});

import { setAutomationInMode } from '../dist/beit-schedule-card.js';

test('taking an automation out of a mode keeps a schedule another member still follows', async () => {
  const hass = house();
  // Both the Beit automation and the hand-written fan follow the living-room schedule.
  await setAutomationInMode(hass, 'שבת', 'automation.living_room_fan_shabbat', false);
  let reg = await loadRegistry(hass);
  assert.deepEqual(reg.entityLabels['automation.living_room_fan_shabbat'], []);
  assert.deepEqual(reg.entityLabels['schedule.living_room_ac_shabbat'], ['shbt']);
  // The last one out takes the schedule with it.
  await setAutomationInMode(hass, 'שבת', 'automation.beit_living_room_ac_shabbat', false);
  reg = await loadRegistry(hass);
  assert.deepEqual(reg.entityLabels['schedule.living_room_ac_shabbat'], []);
  // And in again: the automation and its schedule.
  await setAutomationInMode(hass, 'חג', 'automation.beit_water_heater_weekdays', true);
  reg = await loadRegistry(hass);
  assert.deepEqual(reg.entityLabels['schedule.water_heater_weekdays'], ['energy', 'khg']);
});

import { readSchedules } from '../dist/beit-schedule-card.js';

test('readSchedules reads UI and YAML weeks through get_schedule, which non-admins may call', async () => {
  const hass = house({ isAdmin: false });
  const weeks = await readSchedules(hass, ['schedule.pool_pump', 'schedule.balcony_light']);
  assert.deepEqual(weeks['schedule.pool_pump'].days.monday, [{ start: 360, end: 480 }]);
  assert.equal(weeks['schedule.balcony_light'].days.sunday[0].end, 1440);
  const call = hass.calls.at(-1);
  assert.deepEqual([call.domain, call.service, call.target], ['schedule', 'get_schedule', { entity_id: ['schedule.pool_pump', 'schedule.balcony_light'] }]);
  assert.deepEqual(await readSchedules(hass, []), {});
});
