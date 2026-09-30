// The small pieces of display logic that don't need a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatWhen, langOf } from '../dist/beit-schedule-card.js';

test('formatWhen: today, tomorrow, a weekday', () => {
  const now = new Date(2026, 0, 4, 9, 0); // Sunday
  assert.equal(formatWhen(new Date(2026, 0, 4, 16, 5), now), 'היום ב-16:05');
  assert.equal(formatWhen(new Date(2026, 0, 5, 6, 0), now), 'מחר ב-06:00');
  assert.equal(formatWhen(new Date(2026, 0, 9, 16, 0), now), 'ביום שישי ב-16:00');
  assert.equal(formatWhen(new Date(2026, 0, 9, 16, 0), now, 'en'), 'Friday at 16:00');
  assert.equal(formatWhen(new Date(2026, 0, 5, 6, 0), now, 'en'), 'tomorrow at 06:00');
});

test('langOf reads hass.locale, then hass.language', () => {
  assert.equal(langOf({ locale: { language: 'he' } }), 'he');
  assert.equal(langOf({ language: 'en-GB' }), 'en');
  assert.equal(langOf({ locale: { language: 'fr' } }), 'en');
  assert.equal(langOf(undefined), 'he');
});

import { readFileSync } from 'node:fs';
import { deviceSections, actionOptions } from '../dist/beit-schedule-card.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`fixtures/${n}.json`, import.meta.url)));

test('deviceSections groups by area, skips hidden and auxiliary entities, and searches', () => {
  const data = {
    states: Object.fromEntries(fx('states').map((s) => [s.entity_id, s])),
    display: fx('entity_registry_display'),
    devices: fx('device_registry'),
    areas: fx('area_registry'),
  };
  const sections = deviceSections(data);
  const all = sections.flatMap((s) => s.entities.map((e) => e.entity_id));
  assert.ok(!all.includes('switch.living_room_ac_display'), 'config entity');
  assert.ok(!all.some((id) => id.startsWith('sensor.') || id.startsWith('automation.') || id.startsWith('schedule.')));
  const kitchen = sections.find((s) => s.areaId === 'kitchen');
  // The entity's own area wins over its device's (the strip's device has none).
  assert.ok(kitchen.entities.some((e) => e.entity_id === 'light.kitchen_strip'));
  // Lights before switches within an area.
  assert.deepEqual(kitchen.entities.map((e) => e.entity_id), ['light.kitchen_strip', 'switch.hot_plate', 'media_player.kitchen_speaker']);
  assert.deepEqual(deviceSections(data, 'מזגן').flatMap((s) => s.entities.map((e) => e.entity_id)).sort(),
    ['climate.bedroom_ac', 'climate.kids_ac', 'climate.living_room_ac']);
  // A room name matches all its devices.
  assert.equal(deviceSections(data, 'מטבח')[0].entities.length, 3);
});

test('actionOptions per device', () => {
  const states = Object.fromEntries(fx('states').map((s) => [s.entity_id, s]));
  const ac = actionOptions(states['climate.kids_ac']);
  assert.deepEqual(ac.hvacModes, ['cool', 'heat']);
  assert.equal(ac.defaultHvac, 'cool');
  assert.deepEqual(ac.temp, { min: 17, max: 30, initial: 25 });
  assert.equal(actionOptions(states['light.balcony']).brightness, true);
  assert.equal(actionOptions(states['light.kitchen_strip']).brightness, false);
  assert.deepEqual(actionOptions(states['water_heater.boiler']).temp, { min: 40, max: 75, initial: 55 });
  assert.equal(actionOptions(states['switch.hot_plate']).temp, null);
});
