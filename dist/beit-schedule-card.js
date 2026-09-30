/*
 * Beit Schedule Card — weekly schedules for any device, with Shabbat and chag modes.
 *
 *   type: custom:beit-schedule-card
 *   type: custom:beit-shabbat-card
 *
 * Everything the card writes is a native Home Assistant object: a `schedule` helper and an ordinary automation,
 * and a label per mode. The data shapes are fixed by docs/contract.md, shared with the Beit app.
 *
 * Pure logic sits at the top and is exported, so `node --test` can import this file.
 * Custom elements are registered only where `customElements` exists.
 */

export const VERSION = '0.0.0';

// ---------------------------------------------------------------------------- week model

/** HA's day keys, Sunday first — the Israeli week. */
export const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export const DAY_NAMES = {
  he: ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};
export const DAY_SHORT = {
  he: ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'],
  en: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'],
};

/** "HH:MM[:SS]" → minutes from midnight. "24:00:00" is 1440, and so is "23:59:59". Minute precision. */
export function parseBlock(hms) {
  const p = String(hms).split(':').map((x) => parseInt(x, 10));
  const minutes = p[0] * 60 + (p[1] || 0);
  return p.length > 2 && p[2] === 59 && minutes === 1439 ? 1440 : minutes;
}

/** Minutes → "HH:MM:00"; 1440 → "24:00:00" (HA's "until midnight"). */
export function formatBlock(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
}

/** Minutes → "HH:MM" for display; 1440 → "24:00". */
export const hm = (m) => formatBlock(m).slice(0, 5);

export const blockLabel = (b) => `${hm(b.start)}–${hm(b.end)}`;

const byStart = (a, b) => a.start - b.start;

export class WeekSchedule {
  constructor({ name = '', days = {} } = {}) {
    this.name = name;
    this.days = {};
    for (const d of DAYS) this.days[d] = (days[d] || []).map((b) => ({ start: b.start, end: b.end }));
  }

  /** From a `schedule/list` item (or anything with the seven day keys). */
  static fromHA(j) {
    const days = {};
    for (const d of DAYS) {
      days[d] = (j?.[d] || []).map((b) => ({ start: parseBlock(b.from), end: parseBlock(b.to) })).sort(byStart);
    }
    return new WeekSchedule({ name: j?.name ?? '', days });
  }

  /** The body HA's `schedule/create` and `schedule/update` expect (minus the id). Days go out Sunday first, sorted. */
  toHA() {
    const out = { name: this.name.trim() };
    for (const d of DAYS) out[d] = [...this.days[d]].sort(byStart).map((b) => ({ from: formatBlock(b.start), to: formatBlock(b.end) }));
    return out;
  }

  get isEmpty() {
    return DAYS.every((d) => !this.days[d].length);
  }

  clone() {
    return new WeekSchedule({ name: this.name, days: this.days });
  }

  /** Why HA would reject this week, in words; null when it is valid. */
  validate(lang = 'he') {
    const t = STRINGS[lang] || STRINGS.he;
    if (!this.name.trim()) return t.errName;
    for (let i = 0; i < DAYS.length; i++) {
      const blocks = [...this.days[DAYS[i]]].sort(byStart);
      const day = (DAY_NAMES[lang] || DAY_NAMES.he)[i];
      for (let k = 0; k < blocks.length; k++) {
        if (blocks[k].end <= blocks[k].start) return t.errReversed(day);
        if (k > 0 && blocks[k].start < blocks[k - 1].end) return t.errOverlap(day);
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------- the automation a schedule drives

/** Marks automations Beit wrote, so it knows which ones it may rewrite or delete. */
export const BEIT_MARKER = 'נוצר באפליקציית Beit';

/**
 * What a new schedule does to its device:
 * `{entityId, name, hvacMode?, temperature?, brightnessPct?, turnOffAtEnd = true}`.
 */
const domainOf = (entityId) => String(entityId).split('.')[0];
const given = (v) => v !== null && v !== undefined;

export function onActions(target) {
  const domain = domainOf(target.entityId);
  const t = { entity_id: target.entityId };
  switch (domain) {
    case 'climate':
      if (given(target.temperature)) {
        const data = { temperature: target.temperature };
        if (given(target.hvacMode)) data.hvac_mode = target.hvacMode;
        return [{ action: 'climate.set_temperature', target: t, data }];
      }
      return [{ action: 'climate.set_hvac_mode', target: t, data: { hvac_mode: target.hvacMode ?? 'cool' } }];
    case 'water_heater':
      return [
        { action: 'water_heater.turn_on', target: t },
        ...(given(target.temperature) ? [{ action: 'water_heater.set_temperature', target: t, data: { temperature: target.temperature } }] : []),
      ];
    case 'light':
      return [{ action: 'light.turn_on', target: t, ...(given(target.brightnessPct) ? { data: { brightness_pct: target.brightnessPct } } : {}) }];
    case 'cover':
      return [{ action: 'cover.open_cover', target: t }];
    case 'valve':
      return [{ action: 'valve.open_valve', target: t }];
    default:
      return [{ action: `${domain}.turn_on`, target: t }];
  }
}

export function offActions(target) {
  if (target.turnOffAtEnd === false) return [];
  const domain = domainOf(target.entityId);
  const t = { entity_id: target.entityId };
  switch (domain) {
    case 'cover':
      return [{ action: 'cover.close_cover', target: t }];
    case 'valve':
      return [{ action: 'valve.close_valve', target: t }];
    case 'media_player':
      return [{ action: 'media_player.media_pause', target: t }];
    default:
      return [{ action: `${domain}.turn_off`, target: t }];
  }
}

/** The automation that makes a schedule drive a device (contract §2). */
export function buildScheduleAutomation({ id, scheduleEntityId, scheduleName, target }) {
  // A restart makes the schedule pass through "unavailable"; that is not an edge.
  const notFrom = ['unavailable', 'unknown'];
  const off = offActions(target);
  const trigger = (to, tid) => ({ trigger: 'state', entity_id: [scheduleEntityId], to: [to], not_from: notFrom, id: tid });
  const branch = (tid, sequence) => ({ conditions: [{ condition: 'trigger', id: tid }], sequence });
  return {
    id,
    alias: `Beit · ${scheduleName}`,
    description: `${BEIT_MARKER} — ${target.name ?? target.entityId} לפי ${scheduleEntityId}`,
    triggers: [trigger('on', 'schedule_on'), ...(off.length ? [trigger('off', 'schedule_off')] : [])],
    conditions: [],
    actions: [{ choose: [branch('schedule_on', onActions(target)), ...(off.length ? [branch('schedule_off', off)] : [])] }],
    mode: 'queued',
  };
}

/** True for an automation config Beit wrote (and so may rewrite or delete). */
export const isOurs = (config) => String(config?.description ?? '').includes(BEIT_MARKER);

/** The schedule entities an automation config refers to. */
export function schedulesIn(config) {
  return [...new Set(JSON.stringify(config ?? {}).match(/schedule\.[a-z0-9_]+/g) || [])];
}

// ---------------------------------------------------------------------------- modes

export const MODES = ['שבת', 'חג'];
export const MODE_LABEL_STYLE = {
  שבת: { icon: 'mdi:candle', color: 'amber' },
  חג: { icon: 'mdi:star-david', color: 'indigo' },
};

/** A mode's switch: 'on' when every member automation is on, 'partial' when some are, 'off' when none, 'empty'. */
export function modeState(members) {
  const list = members || [];
  if (!list.length) return 'empty';
  const on = list.filter((m) => (typeof m === 'string' ? m : m?.state) === 'on').length;
  return on === list.length ? 'on' : on ? 'partial' : 'off';
}

// ---------------------------------------------------------------------------- calendar

const UNUSABLE = new Set(['unknown', 'unavailable', 'אין מידע', '', 'None']);
export const usable = (st) => !!st && !UNUSABLE.has(String(st.state));

/** The entity for a base id, allowing HA's `_2`/`_3` suffixes. Prefers the exact id, then a live one. */
function pick(states, base) {
  const re = new RegExp(`^${base.replace(/\./g, '\\.')}(_\\d+)?$`);
  const hits = Object.keys(states).filter((id) => re.test(id)).sort((a, b) => a.length - b.length || a.localeCompare(b));
  return hits.find((id) => usable(states[id])) || hits[0] || null;
}

/**
 * The Jewish calendar entities in this house: the core Jewish Calendar integration (preferred) and Hebcal.
 * Every field is an entity id or null.
 */
export function findCalendar(states) {
  const s = states || {};
  const jc = (kind, suffix) => pick(s, `${kind}.jewish_calendar_${suffix}`);
  const hc = (suffix) => (s[`sensor.hebcal_${suffix}`] ? `sensor.hebcal_${suffix}` : null);
  const cal = {
    issur: jc('binary_sensor', 'issur_melacha_in_effect'),
    erev: jc('binary_sensor', 'erev_shabbat_hag'),
    motzei: jc('binary_sensor', 'motzei_shabbat_hag'),
    candleLighting: jc('sensor', 'upcoming_candle_lighting'),
    havdalah: jc('sensor', 'upcoming_havdalah'),
    date: jc('sensor', 'date'),
    parasha: jc('sensor', 'weekly_torah_portion'),
    holiday: jc('sensor', 'holiday'),
    hebcal: {
      isShabbat: hc('is_shabbat'),
      date: hc('hebrew_date'),
      parasha: hc('parasha'),
      event: hc('event_name'),
      candleLighting: hc('shabbat_entry'),
      havdalah: hc('shabbat_came_out'),
    },
  };
  cal.source = cal.issur || cal.motzei ? 'jewish_calendar' : cal.hebcal.isShabbat ? 'hebcal' : null;
  return cal;
}

// ---------------------------------------------------------------------------- automatic Shabbat

export const AUTO_SHABBAT_ALIAS = 'Beit · מצב שבת אוטומטי';

/**
 * The trigger that marks the end of Shabbat. Jewish Calendar's "issur melacha" going off is preferred
 * (then its "motzei" going on); Hebcal's is_shabbat True→False otherwise. Explicit from/to: both pass
 * through "unknown" on a restart. Null when the house has no calendar.
 */
export function autoShabbatEndTrigger(cal) {
  const t = (entity, from, to) => ({ trigger: 'state', entity_id: [entity], from, to, id: 'motzei_shabbat' });
  if (cal?.issur) return t(cal.issur, 'on', 'off');
  if (cal?.motzei) return t(cal.motzei, 'off', 'on');
  if (cal?.hebcal?.isShabbat) return t(cal.hebcal.isShabbat, 'True', 'False');
  return null;
}

/** The one automatic-Shabbat automation (contract §3). */
export function buildAutoShabbatAutomation({ id, labelId, shabbatEndTrigger }) {
  const source = String(shabbatEndTrigger.entity_id[0]).includes('hebcal') ? 'Hebcal' : 'Jewish Calendar';
  const target = { label_id: labelId };
  return {
    id,
    alias: AUTO_SHABBAT_ALIAS,
    description:
      `${BEIT_MARKER} — מדליק את כל האוטומציות עם התווית "שבת" בשישי ב-12:00 (לפני התזמונים של אחר הצהריים), ` +
      `ומכבה אותן ביציאת השבת לפי ${source}, אחרי שכל תזמוני השבת הסתיימו.`,
    triggers: [{ trigger: 'time', at: '12:00:00', id: 'erev_shabbat' }, shabbatEndTrigger],
    conditions: [],
    actions: [
      {
        choose: [
          {
            conditions: [
              { condition: 'trigger', id: 'erev_shabbat' },
              { condition: 'time', weekday: ['fri'] },
            ],
            sequence: [{ action: 'automation.turn_on', target }],
          },
          {
            conditions: [{ condition: 'trigger', id: 'motzei_shabbat' }],
            sequence: [
              {
                wait_template: `{{ label_entities('${labelId}') | select('match', 'schedule\\\\.') | select('is_state', 'on') | list | count == 0 }}`,
                timeout: '06:00:00',
                continue_on_timeout: true,
              },
              { action: 'automation.turn_off', target, data: { stop_actions: false } },
            ],
          },
        ],
      },
    ],
    mode: 'single',
  };
}

// ---------------------------------------------------------------------------- time

const MINUTES_PER_WEEK = 7 * 1440;

/**
 * Whether a week is "on" at `now` (local time) and when it next changes, the way HA computes a schedule's state
 * and `next_event`. Adjacent ranges (Friday until 24:00, Saturday from 00:00) are one range.
 */
export function weekStatus(week, now = new Date()) {
  const ranges = [];
  DAYS.forEach((d, i) => {
    for (const b of week.days[d]) ranges.push([i * 1440 + b.start, i * 1440 + b.end]);
  });
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  if (!merged.length) return { on: false, next: null };
  if (merged.length === 1 && merged[0][0] === 0 && merged[0][1] === MINUTES_PER_WEEK) return { on: true, next: null };
  // A range that runs to the end of Saturday continues into Sunday's first one.
  if (merged.length > 1 && merged.at(-1)[1] === MINUTES_PER_WEEK && merged[0][0] === 0) {
    const tail = merged.pop();
    merged[0] = [tail[0], merged[0][1] + MINUTES_PER_WEEK];
  }
  const t = now.getDay() * 1440 + now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const inside = (r, x) => x >= r[0] && x < r[1];
  const on = merged.find((r) => inside(r, t) || inside(r, t + MINUTES_PER_WEEK));
  let delta;
  if (on) {
    delta = (inside(on, t) ? on[1] - t : on[1] - (t + MINUTES_PER_WEEK));
  } else {
    delta = Math.min(...merged.map((r) => ((r[0] - t) % MINUTES_PER_WEEK + MINUTES_PER_WEEK) % MINUTES_PER_WEEK));
  }
  const next = new Date(now.getTime() + delta * 60000);
  next.setSeconds(0, 0);
  return { on: !!on, next };
}

// ---------------------------------------------------------------------------- Home Assistant operations
//
// Every function takes `hass`: anything with callWS, callApi, callService and a *live* `states` (the card passes an
// adapter that always reads its latest hass). The order of calls follows the Beit app's home_store.dart.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** HA's own error text: WebSocket errors carry `message`, REST ones (hass.callApi) `body.message` or `error`. */
export const errorText = (err) =>
  err?.body?.message || err?.message || (typeof err?.error === 'string' && err.error) || (typeof err === 'string' ? err : JSON.stringify(err));

/** Waits for an entity to appear in the live state, matched by `test`. */
export async function waitForEntity(hass, test, { tries = 40, every = 150 } = {}) {
  for (let i = 0; i < tries; i++) {
    const hit = Object.values(hass.states || {}).find(test);
    if (hit) return hit;
    await sleep(every);
  }
  throw new Error('Home Assistant did not report the new entity');
}

/** `{id: WeekSchedule}` for every UI-managed schedule. */
export async function listSchedules(hass) {
  const list = await hass.callWS({ type: 'schedule/list' });
  return Object.fromEntries(list.map((s) => [s.id, WeekSchedule.fromHA(s)]));
}

export const updateSchedule = (hass, id, week) => hass.callWS({ type: 'schedule/update', schedule_id: id, ...week.toHA() });

export async function automationsFor(hass, entityId) {
  const r = await hass.callWS({ type: 'search/related', item_type: 'entity', item_id: entityId });
  return r?.automation || [];
}

export async function automationConfig(hass, automationEntityId) {
  const r = await hass.callWS({ type: 'automation/config', entity_id: automationEntityId });
  return r?.config ?? null;
}

/**
 * Creates the schedule helper and the automation that drives `target` from it; if the automation cannot be written,
 * the helper is deleted again. Returns the new schedule's entity id.
 */
export async function createScheduleWithAutomation(hass, week, target, { labelName = null, waitOptions } = {}) {
  const created = await hass.callWS({ type: 'schedule/create', ...week.toHA() });
  const scheduleEntityId = `schedule.${created.id}`;
  try {
    await waitForEntity(hass, (e) => e.entity_id === scheduleEntityId, waitOptions);
  } catch (err) {
    await hass.callWS({ type: 'schedule/delete', schedule_id: created.id });
    throw err;
  }
  const automationId = String(Date.now());
  try {
    await hass.callApi(
      'POST',
      `config/automation/config/${automationId}`,
      buildScheduleAutomation({ id: automationId, scheduleEntityId, scheduleName: week.name.trim(), target }),
    );
  } catch (err) {
    // Half a schedule (a helper that drives nothing) is worse than none.
    await hass.callWS({ type: 'schedule/delete', schedule_id: created.id });
    throw err;
  }
  if (labelName) {
    const automation = await waitForEntity(
      hass,
      (e) => e.entity_id.startsWith('automation.') && String(e.attributes?.id) === automationId,
      waitOptions,
    );
    await setModeMembership(hass, labelName, [scheduleEntityId, automation.entity_id], true);
  }
  return scheduleEntityId;
}

/**
 * Deletes a schedule and the automations driving it that Beit wrote. Automations written by hand are left alone;
 * their names are returned.
 */
export async function deleteSchedule(hass, scheduleEntityId) {
  const kept = [];
  for (const a of await automationsFor(hass, scheduleEntityId)) {
    const cfg = await automationConfig(hass, a);
    if (isOurs(cfg) && cfg?.id != null) await hass.callApi('DELETE', `config/automation/config/${cfg.id}`);
    else kept.push(hass.states?.[a]?.attributes?.friendly_name || a);
  }
  await hass.callWS({ type: 'schedule/delete', schedule_id: scheduleEntityId.slice('schedule.'.length) });
  return kept;
}

export const setAutomationEnabled = (hass, automationEntityId, enabled) =>
  hass.callService('automation', enabled ? 'turn_on' : 'turn_off', {}, { entity_id: automationEntityId });

// ---- modes: an HA label names the automations (and schedules) of a mode ----

/** Labels and each entity's labels, read fresh from HA: `{labels, entityLabels: {entity_id: [label_id]}}`. */
export async function loadRegistry(hass) {
  const [labels, display] = await Promise.all([
    hass.callWS({ type: 'config/label_registry/list' }),
    hass.callWS({ type: 'config/entity_registry/list_for_display' }),
  ]);
  return { labels, entityLabels: Object.fromEntries(display.entities.map((e) => [e.ei, e.lb || []])), display };
}

export const labelNamed = (registry, name) => registry?.labels?.find((l) => l.name === name) || null;

export async function ensureLabel(hass, name) {
  const labels = await hass.callWS({ type: 'config/label_registry/list' });
  const existing = labels.find((l) => l.name === name);
  if (existing) return existing;
  const style = MODE_LABEL_STYLE[name] || {};
  return hass.callWS({ type: 'config/label_registry/create', name, ...style });
}

/**
 * Adds the mode's label to (or removes it from) each entity. `config/entity_registry/update` replaces the whole
 * list, so the entity's other labels are merged back in.
 */
export async function setModeMembership(hass, labelName, entityIds, member) {
  const label = await ensureLabel(hass, labelName);
  const { entityLabels } = await loadRegistry(hass);
  for (const id of entityIds) {
    const current = entityLabels[id] || [];
    const next = member ? [...new Set([...current, label.label_id])] : current.filter((l) => l !== label.label_id);
    if (next.length === current.length && next.every((l) => current.includes(l))) continue;
    await hass.callWS({ type: 'config/entity_registry/update', entity_id: id, labels: next });
  }
  return label;
}

/** The entities of a mode, by name, sorted by their display name. */
export function modeMembers(states, registry, labelName, domain = 'automation') {
  const label = labelNamed(registry, labelName);
  if (!label) return [];
  return Object.values(states || {})
    .filter((e) => e.entity_id.startsWith(`${domain}.`) && (registry.entityLabels[e.entity_id] || []).includes(label.label_id))
    .sort((a, b) => entityName(a).localeCompare(entityName(b), 'he'));
}

/** Switches every automation of a mode on or off in one call. */
export async function setModeEnabled(hass, registry, labelName, enabled) {
  const members = modeMembers(hass.states, registry, labelName);
  if (!members.length) return;
  await hass.callService('automation', enabled ? 'turn_on' : 'turn_off', {}, { entity_id: members.map((m) => m.entity_id) });
}

// ---- automatic Shabbat ----

/**
 * The existing automatic-Shabbat automation, if any: `{entityId, config, ours}`. Recognised by its alias; one that
 * carries the marker is preferred.
 */
export async function findAutoShabbat(hass) {
  const candidates = Object.values(hass.states || {}).filter(
    (e) => e.entity_id.startsWith('automation.') && e.attributes?.friendly_name === AUTO_SHABBAT_ALIAS,
  );
  let fallback = null;
  for (const c of candidates) {
    const config = await automationConfig(hass, c.entity_id).catch(() => null);
    const found = { entityId: c.entity_id, config, ours: isOurs(config) };
    if (found.ours) return found;
    fallback ??= found;
  }
  return fallback;
}

/** Turns automatic Shabbat on: switches an existing one on, or creates the one automation. Never a second one. */
export async function enableAutoShabbat(hass, { waitOptions } = {}) {
  const existing = await findAutoShabbat(hass);
  if (existing) {
    if (hass.states?.[existing.entityId]?.state !== 'on') await setAutomationEnabled(hass, existing.entityId, true);
    return existing.entityId;
  }
  const trigger = autoShabbatEndTrigger(findCalendar(hass.states));
  if (!trigger) throw new Error(STRINGS.he.errNoCalendar);
  const label = await ensureLabel(hass, 'שבת');
  const id = String(Date.now());
  await hass.callApi('POST', `config/automation/config/${id}`, buildAutoShabbatAutomation({ id, labelId: label.label_id, shabbatEndTrigger: trigger }));
  const entity = await waitForEntity(hass, (e) => e.entity_id.startsWith('automation.') && String(e.attributes?.id) === id, waitOptions);
  return entity.entity_id;
}

/** Turns automatic Shabbat off: deletes the automation if Beit wrote it, otherwise only switches it off. */
export async function disableAutoShabbat(hass) {
  const existing = await findAutoShabbat(hass);
  if (!existing) return null;
  if (existing.ours && existing.config?.id != null) {
    await hass.callApi('DELETE', `config/automation/config/${existing.config.id}`);
    return 'deleted';
  }
  await setAutomationEnabled(hass, existing.entityId, false);
  return 'turned_off';
}

export const entityName = (st) => st?.attributes?.friendly_name || st?.entity_id || '';

// ---------------------------------------------------------------------------- strings

export const STRINGS = {
  he: {
    errName: 'צריך שם לתזמון',
    errReversed: (day) => `ביום ${day}: שעת הסיום לפני שעת ההתחלה`,
    errOverlap: (day) => `ביום ${day}: יש טווחים חופפים`,
    errNoCalendar: 'לא נמצא לוח שנה עברי (Jewish Calendar או Hebcal) — אין לפי מה לדעת מתי השבת יוצאת',
    schedules: 'תזמונים',
    newSchedule: 'תזמון חדש',
    onNow: 'פועל עכשיו',
    offNow: 'כבוי',
    starts: 'מתחיל',
    ends: 'נגמר',
    today: 'היום',
    tomorrow: 'מחר',
    onDay: (day) => `ביום ${day}`,
    at: (when, time) => `${when} ב-${time}`,
    yaml: 'מוגדר ב-YAML — לקריאה בלבד',
    noSchedules: 'אין תזמונים להצגה',
    loading: 'טוען…',
    readOnly: 'צפייה בלבד — רק מנהל יכול לערוך',
    modeName: { שבת: 'שבת', חג: 'חג' },
  },
  en: {
    errName: 'The schedule needs a name',
    errReversed: (day) => `${day}: a range ends before it starts`,
    errOverlap: (day) => `${day}: ranges overlap`,
    errNoCalendar: 'No Jewish calendar found (Jewish Calendar or Hebcal), so there is no way to tell when Shabbat ends',
    schedules: 'Schedules',
    newSchedule: 'New schedule',
    onNow: 'On now',
    offNow: 'Off',
    starts: 'starts',
    ends: 'ends',
    today: 'today',
    tomorrow: 'tomorrow',
    onDay: (day) => day,
    at: (when, time) => `${when} at ${time}`,
    yaml: 'Defined in YAML — read only',
    noSchedules: 'No schedules to show',
    loading: 'Loading…',
    readOnly: 'View only — only an administrator can edit',
    modeName: { שבת: 'Shabbat', חג: 'Chag' },
  },
};

export const langOf = (hass) => (String(hass?.locale?.language || hass?.language || 'he').startsWith('he') ? 'he' : 'en');

/** "היום ב-16:00" / "tomorrow at 16:00" / "ביום שישי ב-16:00". */
export function formatWhen(date, now = new Date(), lang = 'he') {
  const t = STRINGS[lang];
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(date) - midnight(now)) / 86400000);
  const when = days === 0 ? t.today : days === 1 ? t.tomorrow : t.onDay(DAY_NAMES[lang][date.getDay()]);
  return t.at(when, time);
}

// ---------------------------------------------------------------------------- UI helpers

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Material Design Icons paths (Apache 2.0), inlined: HA's own icon elements are not ours to depend on.
const ICONS = {
  plus: 'M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z',
  close: 'M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z',
  lock: 'M12,17A2,2 0 0,0 14,15C14,13.89 13.1,13 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10C4,8.89 4.9,8 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z',
  delete: 'M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z',
  copy: 'M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z',
  search: 'M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z',
  clock: 'M12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22C6.47,22 2,17.5 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z',
  alert: 'M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z',
  checklist: 'M3,5H9V11H3V5M5,7V9H7V7H5M11,7H21V9H11V7M11,15H21V17H11V15M5,20L1.5,16.5L2.91,15.09L5,17.17L9.59,12.59L11,14L5,20Z',
  minus: 'M19,13H5V11H19V13Z',
};
const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
const MODE_GLYPH = { שבת: '🕯️', חג: '✡️' };

const BASE_STYLE = `
  :host { display: block; }
  ha-card { overflow: hidden; }
  * { box-sizing: border-box; }
  .ic { width: 20px; height: 20px; fill: currentColor; flex: none; }
  button { font: inherit; color: inherit; }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 18px; cursor: pointer;
    border: 1px solid var(--divider-color); background: transparent; color: var(--primary-color); font-size: 14px; font-weight: 500; }
  .btn.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
  .btn.danger { color: var(--error-color, #db4437); }
  .btn:disabled { opacity: .5; cursor: default; }
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%;
    border: 0; background: transparent; cursor: pointer; color: var(--secondary-text-color); flex: none; }
  .icon-btn:hover, .btn:hover { background: color-mix(in srgb, var(--primary-color) 10%, transparent); }
  .btn.primary:hover { filter: brightness(1.08); background: var(--primary-color); }
  :focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
  .header { display: flex; align-items: center; gap: 8px; padding: 16px 16px 8px; }
  .header h2 { margin: 0; flex: 1; font-size: 20px; font-weight: 500; color: var(--ha-card-header-color, var(--primary-text-color)); }
  .muted { color: var(--secondary-text-color); }
  .small { font-size: 12px; }
  .hint { color: var(--secondary-text-color); font-size: 13px; padding: 8px 16px 16px; }
  .chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 10px; font-size: 12px; line-height: 18px;
    background: color-mix(in srgb, var(--chip-color, var(--primary-color)) 16%, transparent); color: var(--primary-text-color); white-space: nowrap; }
  .chip.shabbat { --chip-color: #ffa000; }
  .chip.chag { --chip-color: #5c6bc0; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--disabled-text-color, #9e9e9e); flex: none; }
  .dot.on { background: var(--success-color, #43a047); }
  /* a switch built from a checkbox */
  .switch { position: relative; display: inline-block; width: 36px; height: 20px; flex: none; }
  .switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; z-index: 1; }
  .switch .track { position: absolute; inset: 3px 0; border-radius: 7px; background: var(--switch-unchecked-track-color, #9e9e9e); opacity: .5; transition: .15s; }
  .switch .knob { position: absolute; top: 0; inset-inline-start: 0; width: 20px; height: 20px; border-radius: 50%;
    background: var(--switch-unchecked-button-color, #fafafa); box-shadow: 0 1px 3px rgba(0,0,0,.4); transition: .15s; }
  .switch input:checked ~ .track { background: var(--switch-checked-track-color, var(--primary-color)); }
  .switch input:checked ~ .knob { inset-inline-start: 16px; background: var(--switch-checked-button-color, var(--primary-color)); }
  .switch.partial input ~ .knob { inset-inline-start: 8px; background: var(--switch-checked-button-color, var(--primary-color)); }
  .switch input:disabled { cursor: default; }
  .switch input:disabled ~ .knob, .switch input:disabled ~ .track { opacity: .35; }
  .switch input:focus-visible ~ .knob { outline: 2px solid var(--primary-color); outline-offset: 2px; }
  .toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 10; max-width: min(560px, calc(100vw - 32px));
    background: var(--primary-text-color); color: var(--card-background-color, #fff); padding: 10px 16px; border-radius: 8px; font-size: 14px;
    box-shadow: 0 2px 8px rgba(0,0,0,.3); }
  .toast[hidden] { display: none; }
`;

const switchHtml = ({ checked = false, partial = false, disabled = false, label = '', attrs = '' } = {}) =>
  `<span class="switch ${partial ? 'partial' : ''}"><input type="checkbox" role="switch" ${checked ? 'checked' : ''}
    aria-checked="${partial ? 'mixed' : checked}" ${disabled ? 'disabled' : ''} aria-label="${esc(label)}" ${attrs}>
    <span class="track"></span><span class="knob"></span></span>`;

const Base = globalThis.HTMLElement || class {};

/** What both cards share: shadow root, language, a live adapter over hass for the ops, the label registry, a toast. */
class BeitCardBase extends Base {
  constructor() {
    super();
    // The ops wait for entities to appear, so they need the latest hass, not the one they started with.
    const self = this;
    this._h = {
      callWS: (m) => self._hass.callWS(m),
      callApi: (...a) => self._hass.callApi(...a),
      callService: (...a) => self._hass.callService(...a),
      get states() {
        return self._hass?.states || {};
      },
    };
    this._labels = null;
    this._displayLabels = null;
  }

  get _lang() {
    return langOf(this._hass);
  }

  get _t() {
    return STRINGS[this._lang];
  }

  get _isAdmin() {
    return this._hass?.user?.is_admin !== false;
  }

  _root() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    return this.shadowRoot;
  }

  /** Labels by name, and each entity's labels: from hass.entities when HA provides them, else list_for_display. */
  _registry() {
    const ents = this._hass?.entities;
    const entityLabels = {};
    if (ents && Object.keys(ents).length) {
      for (const [id, e] of Object.entries(ents)) entityLabels[id] = e.labels || [];
    } else Object.assign(entityLabels, this._displayLabels || {});
    return { labels: this._labels || [], entityLabels };
  }

  async _loadLabels() {
    try {
      const reg = await loadRegistry(this._h);
      this._labels = reg.labels;
      this._displayLabels = reg.entityLabels;
    } catch {
      this._labels ??= [];
    }
    this._render(true);
  }

  _modeOf(entityId, reg = this._registry()) {
    const own = reg.entityLabels[entityId] || [];
    return MODES.find((m) => {
      const l = labelNamed(reg, m);
      return l && own.includes(l.label_id);
    }) || null;
  }

  _toast(text) {
    const el = this._root().querySelector('.toast');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => (el.hidden = true), 6000);
  }

  /** Runs a write; HA's error text goes to the toast. Returns the result, or undefined when it failed. */
  async _run(fn) {
    try {
      return await fn();
    } catch (err) {
      this._toast(errorText(err));
      return undefined;
    }
  }

  _dirAttr() {
    return this._lang === 'he' ? 'rtl' : 'ltr';
  }
}

// ---------------------------------------------------------------------------- beit-schedule-card

class BeitScheduleCard extends BeitCardBase {
  static getStubConfig() {
    return { show_add: true };
  }

  setConfig(config) {
    if (config?.entities && !Array.isArray(config.entities)) throw new Error('entities must be a list');
    if (config?.hide_entities && !Array.isArray(config.hide_entities)) throw new Error('hide_entities must be a list');
    this._config = { show_add: true, ...config };
    this._sig = null;
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._loadLabels();
      this._loadWeeks();
    } else if (this._weeksSig !== this._scheduleSig()) this._loadWeeks();
    this._render();
  }

  get hass() {
    return this._hass;
  }

  getCardSize() {
    return 2 + this._visible().length * 2;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6 };
  }

  connectedCallback() {
    // "today"/"tomorrow" go stale at midnight; the signature carries the date, so a tick is enough.
    this._clock = setInterval(() => this._render(), 60000);
  }

  disconnectedCallback() {
    clearInterval(this._clock);
  }

  // Which schedule entities changed, cheaply: their last_updated.
  _scheduleSig() {
    return Object.values(this._hass?.states || {})
      .filter((e) => e.entity_id.startsWith('schedule.'))
      .map((e) => `${e.entity_id}@${e.last_updated}`)
      .join('|');
  }

  async _loadWeeks() {
    this._weeksSig = this._scheduleSig();
    if (!this._isAdmin) return; // schedule/list is an admin command
    try {
      this._weeks = await listSchedules(this._h);
    } catch (err) {
      this._weeks ??= {};
      this._weeksError = errorText(err);
    }
    this._render(true);
  }

  _visible() {
    const c = this._config || {};
    const reg = this._registry();
    const only = c.entities;
    const hide = c.hide_entities || [];
    return Object.values(this._hass?.states || {})
      .filter((e) => e.entity_id.startsWith('schedule.'))
      .filter((e) => (!only || only.includes(e.entity_id)) && !hide.includes(e.entity_id))
      .filter((e) => !c.mode || this._modeOf(e.entity_id, reg) === c.mode)
      .sort((a, b) => entityName(a).localeCompare(entityName(b), this._lang));
  }

  _render(force = false) {
    if (!this._config || !this._hass) return;
    const reg = this._registry();
    const visible = this._visible();
    const sig = JSON.stringify([
      this._lang, this._isAdmin, this._config, new Date().toDateString(), new Date().getHours(),
      visible.map((e) => [e.entity_id, e.last_updated, reg.entityLabels[e.entity_id]]), !!this._weeks, this._labels?.length,
    ]);
    if (!force && sig === this._sig) return;
    this._sig = sig;
    const t = this._t;
    const root = this._root();
    if (!root.querySelector('ha-card')) {
      root.innerHTML = `<style>${BASE_STYLE}${SCHEDULE_STYLE}</style><ha-card><div class="body"></div></ha-card><div class="toast" hidden role="status"></div>`;
      root.addEventListener('click', (e) => this._onClick(e));
      root.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.row[data-id]')) {
          e.preventDefault();
          this._onClick(e);
        }
      });
    }
    const canEdit = this._isAdmin;
    const now = new Date();
    const rows = visible.map((e) => this._rowHtml(e, reg, now, canEdit)).join('');
    root.querySelector('.body').setAttribute('dir', this._dirAttr());
    root.querySelector('.body').innerHTML = `
      <div class="header">
        <h2>${esc(this._config.title ?? t.schedules)}</h2>
        ${canEdit && this._config.show_add !== false ? `<button class="btn primary" data-act="new">${icon('plus')}<span>${esc(t.newSchedule)}</span></button>` : ''}
      </div>
      ${canEdit ? '' : `<div class="hint">${esc(t.readOnly)}</div>`}
      <div class="list" role="list">${rows || `<div class="hint">${esc(this._weeks || !canEdit ? t.noSchedules : t.loading)}</div>`}</div>`;
  }

  _rowHtml(e, reg, now, canEdit) {
    const t = this._t;
    const id = e.entity_id.slice('schedule.'.length);
    const week = this._weeks?.[id];
    const yaml = e.attributes?.editable === false || (this._weeks && !week);
    const mode = this._modeOf(e.entity_id, reg);
    const on = e.state === 'on';
    const next = e.attributes?.next_event ? new Date(e.attributes.next_event) : null;
    const editable = canEdit && !yaml && !!week;
    const when = next && !isNaN(next) ? `${on ? t.ends : t.starts} ${formatWhen(next, now, this._lang)}` : '';
    return `
      <div class="row ${editable ? 'editable' : ''}" role="listitem" ${editable ? `data-id="${esc(e.entity_id)}" tabindex="0"` : ''}
        aria-label="${esc(entityName(e))}">
        <div class="line">
          <span class="dot ${on ? 'on' : ''}" title="${esc(on ? t.onNow : t.offNow)}"></span>
          <span class="name">${esc(entityName(e))}</span>
          ${mode ? `<span class="chip ${mode === 'שבת' ? 'shabbat' : 'chag'}">${MODE_GLYPH[mode]} ${esc(t.modeName[mode])}</span>` : ''}
          ${yaml ? `<span class="lock" title="${esc(t.yaml)}" aria-label="${esc(t.yaml)}">${icon('lock')}</span>` : ''}
          <span class="spacer"></span>
          <span class="state ${on ? 'on' : ''}">${esc(on ? t.onNow : t.offNow)}</span>
        </div>
        ${when ? `<div class="when muted small">${esc(when)}</div>` : ''}
        ${week ? weekBarsHtml(week, this._lang) : yaml ? `<div class="muted small">${esc(t.yaml)}</div>` : ''}
      </div>`;
  }

  _onClick(e) {
    const act = e.target.closest?.('[data-act]')?.dataset.act;
    if (act === 'new') return this._openEditor(null);
    const row = e.target.closest?.('.row[data-id]');
    if (row) this._openEditor(row.dataset.id);
  }

  _openEditor(_entityId) {
    // The editor dialog comes next.
  }
}

/** Seven thin bars, one per day, Sunday first; the time axis always runs left to right. */
function weekBarsHtml(week, lang) {
  const names = DAY_NAMES[lang];
  return `<div class="bars" dir="ltr">${DAYS.map((d, i) => `
    <div class="bar-row" title="${esc(names[i])}: ${esc(week.days[d].map(blockLabel).join(', ') || '—')}">
      <span class="bar-day">${esc(DAY_SHORT[lang][i])}</span>
      <span class="bar">${week.days[d].map((b) => `<i style="left:${(b.start / 14.4).toFixed(2)}%;width:${((b.end - b.start) / 14.4).toFixed(2)}%"></i>`).join('')}</span>
    </div>`).join('')}</div>`;
}

const SCHEDULE_STYLE = `
  .list { padding: 0 8px 8px; }
  .row { padding: 10px 8px; border-top: 1px solid var(--divider-color); border-radius: 8px; }
  .row:first-child { border-top: 0; }
  .row.editable { cursor: pointer; }
  .row.editable:hover { background: color-mix(in srgb, var(--primary-color) 6%, transparent); }
  .line { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .name { font-size: 15px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .spacer { flex: 1; }
  .state { font-size: 12px; color: var(--secondary-text-color); white-space: nowrap; }
  .state.on { color: var(--success-color, #43a047); font-weight: 500; }
  .lock { display: inline-flex; color: var(--secondary-text-color); }
  .lock .ic { width: 16px; height: 16px; }
  .when { margin: 2px 16px 0; }
  .bars { margin: 8px 16px 0; display: flex; flex-direction: column; gap: 3px; }
  .bar-row { display: flex; align-items: center; gap: 6px; }
  .bar-day { width: 16px; font-size: 10px; color: var(--secondary-text-color); text-align: center; flex: none; }
  .bar { position: relative; flex: 1; height: 5px; border-radius: 3px; background: color-mix(in srgb, var(--divider-color) 70%, transparent); overflow: hidden; }
  .bar i { position: absolute; top: 0; bottom: 0; background: var(--primary-color); border-radius: 3px; }
`;

export { BeitScheduleCard, BeitCardBase };

if (typeof customElements !== 'undefined') {
  if (!customElements.get('beit-schedule-card')) customElements.define('beit-schedule-card', BeitScheduleCard);
  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === 'beit-schedule-card')) {
    window.customCards.push({
      type: 'beit-schedule-card',
      name: 'Beit — תזמונים / Schedules',
      description: 'לוח זמנים שבועי לכל מכשיר, עם מצבי שבת וחג. Weekly device schedules with Shabbat and chag modes.',
      preview: false,
    });
  }
}
