// A port of the Beit app's test/schedule_test.dart (the first four tests, one for one), plus the helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  WeekSchedule, parseBlock, formatBlock, blockLabel, DAYS, BEIT_MARKER, buildScheduleAutomation, onActions, offActions,
  isOurs, schedulesIn, modeState, findCalendar, autoShabbatEndTrigger, buildAutoShabbatAutomation, AUTO_SHABBAT_ALIAS,
} from '../dist/beit-schedule-card.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url)));

// ---- schedule_test.dart ----------------------------------------------------------------------------------------

test('round-trips HA schedule JSON, including 24:00 and 23:59:59 ends', () => {
  const w = WeekSchedule.fromHA({
    name: 'AC Boys',
    friday: [{ from: '22:00:00', to: '24:00:00' }],
    saturday: [
      { from: '13:30:00', to: '17:30:00' },
      { from: '00:00:00', to: '09:30:00' },
    ],
    sunday: [{ from: '16:00:00', to: '23:59:59' }],
  });
  const j = w.toHA();
  assert.deepEqual(j.friday, [{ from: '22:00:00', to: '24:00:00' }]);
  // Sorted on the way out.
  assert.deepEqual(j.saturday[0], { from: '00:00:00', to: '09:30:00' });
  assert.deepEqual(j.sunday, [{ from: '16:00:00', to: '24:00:00' }]);
  assert.deepEqual(j.monday, []);
  assert.equal(w.validate(), null);
});

test('rejects overlaps and reversed blocks', () => {
  const w = new WeekSchedule({ name: 'x', days: { monday: [{ start: 600, end: 720 }, { start: 700, end: 800 }] } });
  assert.match(w.validate('he'), /חופפים/);
  const r = new WeekSchedule({ name: 'x', days: { monday: [{ start: 700, end: 600 }] } });
  assert.match(r.validate('he'), /לפני/);
  assert.notEqual(new WeekSchedule({ name: ' ' }).validate(), null);
});

test('builds an on/off automation that ignores restarts', () => {
  const a = buildScheduleAutomation({
    id: '1',
    scheduleEntityId: 'schedule.salon',
    scheduleName: 'סלון שבת',
    target: { entityId: 'climate.salon', name: 'מזגן סלון', hvacMode: 'cool', temperature: 24 },
  });
  assert.equal(a.triggers.length, 2);
  assert.ok(a.triggers[0].not_from.includes('unavailable'));
  assert.ok(a.description.includes(BEIT_MARKER));
  const choose = a.actions[0].choose;
  const on = choose[0].sequence[0];
  assert.equal(on.action, 'climate.set_temperature');
  assert.deepEqual(on.data, { temperature: 24.0, hvac_mode: 'cool' });
  assert.equal(choose.at(-1).sequence[0].action, 'climate.turn_off');
});

test('no off trigger when the device should stay on', () => {
  const a = buildScheduleAutomation({
    id: '2',
    scheduleEntityId: 'schedule.x',
    scheduleName: 'x',
    target: { entityId: 'light.x', name: 'x', turnOffAtEnd: false },
  });
  assert.equal(a.triggers.length, 1);
  assert.equal(a.actions[0].choose.length, 1);
});

// ---- the full JSON, as the Dart builder writes it ----------------------------------------------------------------

test('the automation JSON matches the contract exactly', () => {
  const a = buildScheduleAutomation({
    id: '1790000000000',
    scheduleEntityId: 'schedule.living_room_ac_shabbat',
    scheduleName: 'מזגן סלון שבת',
    target: { entityId: 'climate.living_room_ac', name: 'מזגן סלון', hvacMode: 'heat' },
  });
  assert.deepEqual(a, {
    id: '1790000000000',
    alias: 'Beit · מזגן סלון שבת',
    description: 'נוצר באפליקציית Beit — מזגן סלון לפי schedule.living_room_ac_shabbat',
    triggers: [
      { trigger: 'state', entity_id: ['schedule.living_room_ac_shabbat'], to: ['on'], not_from: ['unavailable', 'unknown'], id: 'schedule_on' },
      { trigger: 'state', entity_id: ['schedule.living_room_ac_shabbat'], to: ['off'], not_from: ['unavailable', 'unknown'], id: 'schedule_off' },
    ],
    conditions: [],
    actions: [{ choose: [
      { conditions: [{ condition: 'trigger', id: 'schedule_on' }], sequence: [{ action: 'climate.set_hvac_mode', target: { entity_id: 'climate.living_room_ac' }, data: { hvac_mode: 'heat' } }] },
      { conditions: [{ condition: 'trigger', id: 'schedule_off' }], sequence: [{ action: 'climate.turn_off', target: { entity_id: 'climate.living_room_ac' } }] },
    ] }],
    mode: 'queued',
  });
});

test('on and off actions per domain', () => {
  const t = (entityId, extra = {}) => ({ entityId, ...extra });
  assert.deepEqual(onActions(t('climate.a')), [{ action: 'climate.set_hvac_mode', target: { entity_id: 'climate.a' }, data: { hvac_mode: 'cool' } }]);
  assert.deepEqual(onActions(t('climate.a', { temperature: 22 })), [{ action: 'climate.set_temperature', target: { entity_id: 'climate.a' }, data: { temperature: 22 } }]);
  assert.deepEqual(onActions(t('water_heater.w', { temperature: 55 })).map((a) => a.action), ['water_heater.turn_on', 'water_heater.set_temperature']);
  assert.deepEqual(onActions(t('water_heater.w')).length, 1);
  assert.deepEqual(onActions(t('light.l', { brightnessPct: 40 })), [{ action: 'light.turn_on', target: { entity_id: 'light.l' }, data: { brightness_pct: 40 } }]);
  assert.deepEqual(onActions(t('light.l')), [{ action: 'light.turn_on', target: { entity_id: 'light.l' } }]);
  assert.equal(onActions(t('cover.c'))[0].action, 'cover.open_cover');
  assert.equal(onActions(t('valve.v'))[0].action, 'valve.open_valve');
  assert.equal(onActions(t('switch.s'))[0].action, 'switch.turn_on');
  assert.equal(offActions(t('cover.c'))[0].action, 'cover.close_cover');
  assert.equal(offActions(t('valve.v'))[0].action, 'valve.close_valve');
  assert.equal(offActions(t('media_player.m'))[0].action, 'media_player.media_pause');
  assert.equal(offActions(t('water_heater.w'))[0].action, 'water_heater.turn_off');
  assert.deepEqual(offActions(t('switch.s', { turnOffAtEnd: false })), []);
});

// ---- the week model ------------------------------------------------------------------------------------------------

test('parses and formats blocks at minute precision', () => {
  assert.equal(parseBlock('00:00:00'), 0);
  assert.equal(parseBlock('09:30:00'), 570);
  assert.equal(parseBlock('24:00:00'), 1440);
  assert.equal(parseBlock('23:59:59'), 1440);
  assert.equal(parseBlock('23:59:00'), 1439);
  assert.equal(parseBlock('07:15:30'), 435);
  assert.equal(formatBlock(1440), '24:00:00');
  assert.equal(formatBlock(435), '07:15:00');
  assert.equal(blockLabel({ start: 1320, end: 1440 }), '22:00–24:00');
});

test('toHA writes the days Sunday first', () => {
  assert.deepEqual(Object.keys(new WeekSchedule({ name: 'n' }).toHA()), ['name', ...DAYS]);
});

test('English validation messages', () => {
  const r = new WeekSchedule({ name: 'x', days: { friday: [{ start: 700, end: 600 }] } });
  assert.match(r.validate('en'), /Friday/);
});

test('every synthetic fixture round-trips to what HA would store', () => {
  for (const item of fixture('schedule_list')) {
    const w = WeekSchedule.fromHA(item);
    assert.equal(w.validate(), null, item.id);
    const out = w.toHA();
    const again = WeekSchedule.fromHA(out).toHA();
    assert.deepEqual(again, out, item.id);
    for (const d of DAYS) {
      assert.equal(out[d].length, item[d].length);
      for (const b of out[d]) assert.notEqual(b.to, '23:59:59');
    }
  }
});

// ---- helpers -------------------------------------------------------------------------------------------------------

test('isOurs looks for the marker in the description', () => {
  assert.equal(isOurs({ description: `${BEIT_MARKER} — x` }), true);
  assert.equal(isOurs({ description: 'hand-written' }), false);
  assert.equal(isOurs(null), false);
});

test('schedulesIn collects the schedules an automation refers to', () => {
  const cfg = fixture('automation_configs')['automation.living_room_fan_shabbat'];
  assert.deepEqual(schedulesIn(cfg), ['schedule.living_room_ac_shabbat']);
});

test('modeState', () => {
  assert.equal(modeState([]), 'empty');
  assert.equal(modeState(['on', 'on']), 'on');
  assert.equal(modeState([{ state: 'on' }, { state: 'off' }]), 'partial');
  assert.equal(modeState(['off']), 'off');
});

test('findCalendar prefers Jewish Calendar and tolerates suffixes', () => {
  const states = Object.fromEntries(fixture('states').map((s) => [s.entity_id, s]));
  const cal = findCalendar(states);
  assert.equal(cal.source, 'jewish_calendar');
  assert.equal(cal.issur, 'binary_sensor.jewish_calendar_issur_melacha_in_effect_2');
  assert.equal(cal.candleLighting, 'sensor.jewish_calendar_upcoming_candle_lighting_2');
  assert.equal(cal.hebcal.isShabbat, 'sensor.hebcal_is_shabbat');
  // A near-miss id is not a match.
  assert.equal(findCalendar({ 'sensor.jewish_calendar_dateline': { state: 'x' } }).date, null);
  assert.equal(findCalendar({}).source, null);
});

test('the end-of-Shabbat trigger: Jewish Calendar first, then Hebcal', () => {
  assert.deepEqual(autoShabbatEndTrigger({ issur: 'binary_sensor.i', hebcal: {} }),
    { trigger: 'state', entity_id: ['binary_sensor.i'], from: 'on', to: 'off', id: 'motzei_shabbat' });
  assert.deepEqual(autoShabbatEndTrigger({ motzei: 'binary_sensor.m', hebcal: {} }).to, 'on');
  assert.deepEqual(autoShabbatEndTrigger({ hebcal: { isShabbat: 'sensor.hebcal_is_shabbat' } }),
    { trigger: 'state', entity_id: ['sensor.hebcal_is_shabbat'], from: 'True', to: 'False', id: 'motzei_shabbat' });
  assert.equal(autoShabbatEndTrigger({ hebcal: {} }), null);
});

test('the automatic-Shabbat automation matches the contract', () => {
  const a = buildAutoShabbatAutomation({
    id: '5',
    labelId: 'shbt',
    shabbatEndTrigger: autoShabbatEndTrigger({ hebcal: { isShabbat: 'sensor.hebcal_is_shabbat' } }),
  });
  assert.equal(a.alias, AUTO_SHABBAT_ALIAS);
  assert.ok(isOurs(a));
  assert.equal(a.mode, 'single');
  assert.deepEqual(a.triggers[0], { trigger: 'time', at: '12:00:00', id: 'erev_shabbat' });
  const [erev, motzei] = a.actions[0].choose;
  assert.deepEqual(erev.conditions[1], { condition: 'time', weekday: ['fri'] });
  assert.deepEqual(erev.sequence, [{ action: 'automation.turn_on', target: { label_id: 'shbt' } }]);
  assert.equal(motzei.sequence[0].wait_template,
    "{{ label_entities('shbt') | select('match', 'schedule\\\\.') | select('is_state', 'on') | list | count == 0 }}");
  assert.equal(motzei.sequence[0].timeout, '06:00:00');
  assert.deepEqual(motzei.sequence[1], { action: 'automation.turn_off', target: { label_id: 'shbt' }, data: { stop_actions: false } });
});
