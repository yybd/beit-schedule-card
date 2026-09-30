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
