import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the card file imports under node and exports its API', async () => {
  const mod = await import('../dist/schedule-helper-card.js');
  assert.equal(typeof mod.VERSION, 'string');
  assert.equal(typeof mod.ScheduleHelperCard, 'function');
});
