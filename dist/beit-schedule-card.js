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

export const VERSION = '1.0.0';

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

// ---------------------------------------------------------------------------- device picker

/** Domains a schedule can drive, in the order the picker lists them (the app's tile domains, minus scene/script/lock). */
export const PICKABLE_DOMAINS = ['light', 'switch', 'fan', 'cover', 'climate', 'water_heater', 'media_player', 'input_boolean', 'vacuum', 'siren', 'valve'];

/**
 * The picker's sections: devices grouped by area (the entity's own area, else its device's), areas by name, then the
 * ones with no area. Hidden and auxiliary (config/diagnostic) entities are left out, as the app does.
 * `display` is `config/entity_registry/list_for_display`.
 */
export function deviceSections({ states, display, devices = [], areas = [] }, query = '', noAreaTitle = 'ללא חדר', lang = 'he') {
  const meta = Object.fromEntries((display?.entities || []).map((e) => [e.ei, e]));
  const deviceArea = Object.fromEntries(devices.map((d) => [d.id, d.area_id]));
  const q = query.trim().toLowerCase();
  const byArea = new Map();
  for (const e of Object.values(states || {})) {
    const domain = domainOf(e.entity_id);
    if (!PICKABLE_DOMAINS.includes(domain)) continue;
    const m = meta[e.entity_id];
    if (m && (m.hb || m.ec !== undefined && m.ec !== null)) continue;
    const areaId = m?.ai ?? (m?.di ? deviceArea[m.di] : null) ?? null;
    if (!byArea.has(areaId)) byArea.set(areaId, []);
    byArea.get(areaId).push(e);
  }
  const order = (e) => PICKABLE_DOMAINS.indexOf(domainOf(e.entity_id));
  const sorted = [...areas].sort((a, b) => a.name.localeCompare(b.name, lang));
  const sections = [
    ...sorted.map((a) => ({ areaId: a.area_id, title: a.name })),
    { areaId: null, title: noAreaTitle },
  ];
  return sections
    .map((sec) => ({
      ...sec,
      entities: (byArea.get(sec.areaId) || [])
        .filter((e) => !q || entityName(e).toLowerCase().includes(q) || sec.title.toLowerCase().includes(q) || e.entity_id.includes(q))
        .sort((a, b) => order(a) - order(b) || entityName(a).localeCompare(entityName(b), lang)),
    }))
    .filter((sec) => sec.entities.length);
}

/** What the editor offers for a device: HVAC modes, a temperature range, brightness. */
export function actionOptions(st) {
  const domain = domainOf(st.entity_id);
  const a = st.attributes || {};
  const hvacModes = domain === 'climate' ? (a.hvac_modes || []).filter((m) => m !== 'off') : [];
  const temp = domain === 'climate' || domain === 'water_heater'
    ? { min: Number(a.min_temp ?? 16), max: Number(a.max_temp ?? 30), initial: Number(a.temperature ?? Math.round(((a.min_temp ?? 16) + (a.max_temp ?? 30)) / 2)) }
    : null;
  const brightness = domain === 'light' && (a.supported_color_modes || []).some((m) => m !== 'onoff');
  return { domain, hvacModes, defaultHvac: hvacModes.includes('cool') ? 'cool' : hvacModes[0] ?? null, temp, brightness };
}

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
    editSchedule: 'עריכת תזמון',
    name: 'שם התזמון',
    type: 'סוג',
    regular: 'רגיל',
    modeHint: (m) => `יופעל ויכובה יחד עם שאר תזמוני ה${m}, מכרטיס "שבת וחג".`,
    device: 'מכשיר',
    chooseDevice: 'בחר מכשיר',
    changeDevice: 'החלף',
    searchDevice: 'חיפוש מכשיר או חדר',
    noArea: 'ללא חדר',
    noDevices: 'לא נמצאו מכשירים',
    whileActive: 'מצב בזמן פעילות',
    setTemp: 'לקבוע טמפרטורה',
    brightness: 'בהירות',
    turnOffAtEnd: 'לכבות בסוף הטווח',
    closeAtEnd: 'לסגור בסוף הטווח',
    drives: 'מפעיל את',
    autoOn: 'אוטומציה פעילה',
    autoOff: 'אוטומציה כבויה',
    drivesNothing: 'אף אוטומציה לא משתמשת בתזמון הזה — הוא לא מפעיל כלום.',
    hours: 'שעות פעילות',
    addRange: 'טווח',
    from: 'מ־',
    to: 'עד',
    midnightHint: 'סיום 00:00 = עד חצות',
    ok: 'אישור',
    cancel: 'ביטול',
    copyTo: (day) => `להעתיק את יום ${day} אל…`,
    weekdays: 'ימי חול',
    wholeWeek: 'כל השבוע',
    copy: 'העתק',
    copyDays: 'העתק לימים אחרים',
    clearAll: 'נקה הכול',
    save: 'שמור',
    delete: 'מחק',
    close: 'סגור',
    back: 'חזרה',
    deleteQ: 'למחוק את התזמון?',
    deleteText: 'האוטומציה שנוצרה עבורו תימחק גם היא. אוטומציות שנכתבו ידנית יישארו.',
    kept: (list) => `נשארו אוטומציות שמפנות לתזמון שנמחק: ${list}`,
    saveFailed: (e) => `השמירה נכשלה: ${e}`,
    deleteFailed: (e) => `המחיקה נכשלה: ${e}`,
    errEmpty: 'צריך לפחות טווח שעות אחד',
    errDevice: 'בחר מכשיר שהתזמון יפעיל',
    errRange: 'שעת הסיום לפני שעת ההתחלה',
    editRange: 'עריכת טווח',
    removeRange: 'מחיקת טווח',
    hvac: { cool: 'קירור', heat: 'חימום', heat_cool: 'אוטומטי', auto: 'אוטומטי', dry: 'ייבוש', fan_only: 'מאוורר' },
    shabbatAndChag: 'שבת וחג',
    modeTitle: (m) => `מצב ${m}`,
    modeEmpty: 'אין עדיין אוטומציות במצב הזה',
    modeOn: (n) => `פעיל — ${n} אוטומציות`,
    modeOff: 'כבוי',
    modePartial: (on, n) => `פעיל חלקית — ${on} מתוך ${n}`,
    modeSwitch: (m) => `הפעלת מצב ${m}`,
    scheduleList: 'תזמונים',
    chooseAutomations: 'בחירת אוטומציות',
    automationsIn: (m) => `אוטומציות במצב ${m}`,
    searchAutomation: 'חיפוש אוטומציה',
    noAutomations: 'לא נמצאו אוטומציות',
    autoShabbat: 'שבת אוטומטית',
    autoShabbatHint: 'מדליק את מצב השבת בשישי ב-12:00, ומכבה אחרי צאת השבת כשכל תזמוני השבת הסתיימו.',
    autoShabbatNotOurs: 'אוטומציה בשם הזה נכתבה ידנית — כיבוי רק ישבית אותה.',
    autoShabbatDelete: 'לכבות את השבת האוטומטית? האוטומציה תימחק, ואפשר ליצור אותה שוב בלחיצה.',
    autoChagHint: 'מצב חג אוטומטי עוד לא זמין. אינטגרציית Jewish Calendar מאפשרת אותו בעתיד.',
    calToday: 'היום',
    calParasha: 'פרשה',
    calHoliday: 'חג',
    calCandles: 'הדלקת נרות',
    calHavdalah: 'הבדלה',
    calInEffect: 'שבת / חג עכשיו',
    selfExcluded: 'אוטומציית השבת האוטומטית לא יכולה להיות חלק מהמצב — היא הייתה מכבה את עצמה.',
    edGeneral: 'כללי',
    edTitle: 'כותרת',
    edShowAdd: 'כפתור "תזמון חדש"',
    edShowModes: 'הצגת שבת וחג',
    edShowModesHint: 'כבו אם אין צורך במצבי שבת וחג: הכרטיס לא יציג אותם.',
    edModeFilter: 'הצגת תזמונים',
    edAllSchedules: 'כל התזמונים',
    edOnlyMode: (m) => `רק תזמוני ${m}`,
    edSchedules: 'תזמונים בכרטיס',
    edSchedulesHint: 'סמנו את התזמונים שיוצגו.',
    edAll: 'הכול',
    edNone: 'כלום',
    edModes: 'מצבים',
    edShowCalendar: 'הצגת זמני השבת והחג',
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
    editSchedule: 'Edit schedule',
    name: 'Schedule name',
    type: 'Type',
    regular: 'Regular',
    modeHint: (m) => `Switched on and off together with the other ${m} schedules, from the Shabbat & chag card.`,
    device: 'Device',
    chooseDevice: 'Choose a device',
    changeDevice: 'Change',
    searchDevice: 'Search a device or room',
    noArea: 'No room',
    noDevices: 'No devices found',
    whileActive: 'Mode while active',
    setTemp: 'Set a temperature',
    brightness: 'Brightness',
    turnOffAtEnd: 'Turn off at the end',
    closeAtEnd: 'Close at the end',
    drives: 'Drives',
    autoOn: 'Automation on',
    autoOff: 'Automation off',
    drivesNothing: 'No automation uses this schedule, so it drives nothing.',
    hours: 'Active hours',
    addRange: 'Range',
    from: 'From',
    to: 'To',
    midnightHint: 'An end of 00:00 means until midnight',
    ok: 'OK',
    cancel: 'Cancel',
    copyTo: (day) => `Copy ${day} to…`,
    weekdays: 'Weekdays',
    wholeWeek: 'Whole week',
    copy: 'Copy',
    copyDays: 'Copy to other days',
    clearAll: 'Clear all',
    save: 'Save',
    delete: 'Delete',
    close: 'Close',
    back: 'Back',
    deleteQ: 'Delete this schedule?',
    deleteText: 'The automation created for it is deleted too. Automations written by hand stay.',
    kept: (list) => `These automations still refer to the deleted schedule: ${list}`,
    saveFailed: (e) => `Saving failed: ${e}`,
    deleteFailed: (e) => `Deleting failed: ${e}`,
    errEmpty: 'Add at least one range of hours',
    errDevice: 'Choose the device this schedule drives',
    errRange: 'The range ends before it starts',
    editRange: 'Edit range',
    removeRange: 'Remove range',
    hvac: { cool: 'Cool', heat: 'Heat', heat_cool: 'Auto', auto: 'Auto', dry: 'Dry', fan_only: 'Fan' },
    shabbatAndChag: 'Shabbat & chag',
    modeTitle: (m) => `${m} mode`,
    modeEmpty: 'No automations in this mode yet',
    modeOn: (n) => `On — ${n} automations`,
    modeOff: 'Off',
    modePartial: (on, n) => `Partly on — ${on} of ${n}`,
    modeSwitch: (m) => `${m} mode`,
    scheduleList: 'Schedules',
    chooseAutomations: 'Choose automations',
    automationsIn: (m) => `Automations in ${m} mode`,
    searchAutomation: 'Search automations',
    noAutomations: 'No automations found',
    autoShabbat: 'Automatic Shabbat',
    autoShabbatHint: 'Turns Shabbat mode on on Friday at 12:00, and off after Shabbat ends once every Shabbat schedule has finished.',
    autoShabbatNotOurs: 'An automation with this name was written by hand; switching off only disables it.',
    autoShabbatDelete: 'Turn automatic Shabbat off? Its automation is deleted; one click creates it again.',
    autoChagHint: 'Automatic chag mode is not available yet. The Jewish Calendar integration makes it possible later.',
    calToday: 'Today',
    calParasha: 'Parasha',
    calHoliday: 'Holiday',
    calCandles: 'Candle lighting',
    calHavdalah: 'Havdalah',
    calInEffect: 'Shabbat / chag now',
    selfExcluded: 'The automatic-Shabbat automation cannot be part of the mode: it would switch itself off.',
    edGeneral: 'General',
    edTitle: 'Title',
    edShowAdd: '"New schedule" button',
    edShowModes: 'Show Shabbat and chag',
    edShowModesHint: 'Turn off if you have no use for Shabbat and chag modes: the card will not show them.',
    edModeFilter: 'Schedules shown',
    edAllSchedules: 'All schedules',
    edOnlyMode: (m) => `Only ${m} schedules`,
    edSchedules: 'Schedules on the card',
    edSchedulesHint: 'Tick the schedules to show.',
    edAll: 'All',
    edNone: 'None',
    edModes: 'Modes',
    edShowCalendar: 'Show Shabbat and chag times',
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
  back: 'M20,11V13H8L13.5,18.5L12.08,19.92L4.16,12L12.08,4.08L13.5,5.5L8,11H20Z',
};
const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
const MODE_GLYPH = { שבת: '🕯️', חג: '✡️' };

const BASE_STYLE = `
  :host { display: block; }
  ha-card { overflow: hidden; }
  * { box-sizing: border-box; }
  .ic { width: 20px; height: 20px; fill: currentColor; flex: none; }
  [dir=rtl] .ic.flip { transform: scaleX(-1); }
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

  _toast(text, ms = 6000) {
    const root = this._root();
    // A modal dialog sits in the top layer: a toast outside it would be hidden behind its backdrop.
    const host = root.querySelector('dialog[open]') || root;
    let el = host.querySelector(':scope > .toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      el.setAttribute('role', 'status');
      host.appendChild(el);
    }
    el.textContent = text;
    el.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => (el.hidden = true), ms);
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

  static getConfigElement() {
    return document.createElement('beit-schedule-card-editor');
  }

  setConfig(config) {
    if (config?.entities && !Array.isArray(config.entities)) throw new Error('entities must be a list');
    if (config?.hide_entities && !Array.isArray(config.hide_entities)) throw new Error('hide_entities must be a list');
    this._config = { show_add: true, show_modes: true, ...config };
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
    this._editor?.onHass();
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
      root.innerHTML = `<style>${BASE_STYLE}${SCHEDULE_STYLE}${EDITOR_STYLE}</style><ha-card><div class="body"></div></ha-card><div class="toast" hidden role="status"></div>`;
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
    const mode = this._config.show_modes !== false ? this._modeOf(e.entity_id, reg) : null;
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

  _openEditor(entityId) {
    if (!this._isAdmin || this._editor) return;
    if (entityId && !this._weeks?.[entityId.slice('schedule.'.length)]) return;
    this._editor = new ScheduleEditor(this, entityId);
    this._editor.open();
  }

  /** After a write: fresh weeks and labels, whatever the entity states say. */
  _afterWrite() {
    this._loadWeeks();
    this._loadLabels();
  }

  /** Areas, devices and the entity registry, for the device picker; read once per card. */
  async _pickerData() {
    this._pickerCache ??= Promise.all([
      this._h.callWS({ type: 'config/area_registry/list' }),
      this._h.callWS({ type: 'config/device_registry/list' }),
      this._h.callWS({ type: 'config/entity_registry/list_for_display' }),
    ]).then(([areas, devices, display]) => ({ areas, devices, display }));
    try {
      return await this._pickerCache;
    } catch (err) {
      this._pickerCache = null;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------- the editor dialog

const toMinutes = (v) => {
  const [h, m] = String(v || '').split(':').map((x) => parseInt(x, 10));
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

/** Create a schedule for a device, or edit the week of an existing one. Lives in a <dialog> in the card's shadow root. */
class ScheduleEditor {
  constructor(card, entityId) {
    this.card = card;
    this.entityId = entityId; // null = a new schedule
    this.isNew = !entityId;
    this.id = entityId ? entityId.slice('schedule.'.length) : null;
    this.week = entityId ? card._weeks[this.id].clone() : new WeekSchedule({ name: '' });
    this.mode = entityId ? card._modeOf(entityId) : null;
    this.originalMode = this.mode;
    this.view = 'main'; // 'picker' | 'confirmDelete'
    this.device = null;
    this.hvacMode = null;
    this.temperature = null;
    this.brightness = null;
    this.turnOffAtEnd = true;
    this.automations = null; // existing schedule: the automations it drives
    this.rangeEdit = null; // {day, index}
    this.copyFrom = null; // {day, chosen: Set}
    this.query = '';
    this.picker = null;
    this.saving = false;
    this.error = '';
  }

  get t() {
    return this.card._t;
  }

  get lang() {
    return this.card._lang;
  }

  open() {
    const root = this.card._root();
    const dlg = document.createElement('dialog');
    dlg.className = 'editor';
    dlg.setAttribute('aria-labelledby', 'dlg-title');
    root.appendChild(dlg);
    this.dlg = dlg;
    dlg.addEventListener('click', (e) => this.onClick(e));
    dlg.addEventListener('change', (e) => this.onChange(e));
    dlg.addEventListener('input', (e) => this.onInput(e));
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      this.back();
    });
    dlg.addEventListener('close', () => this.destroy());
    this.render();
    dlg.showModal();
    if (this.isNew) {
      this.card._pickerData().then((d) => { this.picker = d; if (this.view === 'picker') this.render(); }, (err) => { this.error = errorText(err); this.render(); });
    } else {
      automationsFor(this.card._h, this.entityId).then(
        (a) => { this.automations = a; this.renderLinked(); },
        () => { this.automations = []; this.renderLinked(); },
      );
    }
  }

  close() {
    if (this.dlg?.open) this.dlg.close();
    else this.destroy();
  }

  destroy() {
    this.dlg?.remove();
    if (this.card._editor === this) this.card._editor = null;
  }

  /** Escape or the back arrow: leave a sub-view first, then the dialog. */
  back() {
    if (this.saving) return;
    if (this.view !== 'main') {
      this.view = 'main';
      this.render();
    } else if (this.rangeEdit || this.copyFrom) {
      this.rangeEdit = this.copyFrom = null;
      this.render();
    } else this.close();
  }

  onHass() {
    if (this.view === 'main' && !this.isNew) this.renderLinked();
  }

  // ---- rendering ----

  render() {
    if (!this.dlg) return;
    const t = this.t;
    const root = this.card._root();
    const focusKey = root.activeElement?.dataset?.focus;
    const scroller = this.dlg.querySelector('.dlg-body');
    const scrollTop = scroller?.scrollTop ?? 0;
    this.dlg.setAttribute('dir', this.card._dirAttr());
    const title = this.view === 'picker' ? t.chooseDevice : this.isNew ? t.newSchedule : t.editSchedule;
    const head = this.view === 'main'
      ? `<button class="icon-btn" data-act="close" aria-label="${esc(t.close)}" data-focus="close">${icon('close')}</button>
         <h3 id="dlg-title">${esc(title)}</h3>
         ${this.isNew ? '' : `<button class="icon-btn" data-act="askDelete" aria-label="${esc(t.delete)}" title="${esc(t.delete)}" ${this.saving ? 'disabled' : ''}>${icon('delete')}</button>`}
         <button class="btn primary" data-act="save" ${this.saving ? 'disabled' : ''}>${this.saving ? '<span class="spinner"></span>' : ''}${esc(t.save)}</button>`
      : `<button class="icon-btn" data-act="back" aria-label="${esc(t.back)}" data-focus="back">${icon('back', 'flip')}</button><h3 id="dlg-title">${esc(this.view === 'picker' ? title : t.deleteQ)}</h3>`;
    const body = this.view === 'picker' ? this.pickerHtml() : this.view === 'confirmDelete' ? this.confirmHtml() : this.mainHtml();
    this.dlg.innerHTML = `<div class="dlg-head">${head}</div><div class="dlg-body">${body}</div>`;
    const again = this.dlg.querySelector('.dlg-body');
    if (this.view === 'main') again.scrollTop = scrollTop;
    const focus = (focusKey && this.dlg.querySelector(`[data-focus="${focusKey}"]`)) || this.dlg.querySelector('[data-autofocus]');
    focus?.focus();
  }

  mainHtml() {
    const t = this.t;
    const seg = [[null, t.regular, ''], ...MODES.map((m) => [m, t.modeName[m], MODE_GLYPH[m]])];
    return `
      ${this.error ? `<div class="error" role="alert">${icon('alert')}<span>${esc(this.error)}</span></div>` : ''}
      <label class="field"><span>${esc(t.name)}</span>
        <input id="name" data-focus="name" value="${esc(this.week.name)}" autocomplete="off" ${this.isNew ? '' : ''}></label>
      ${this.card._config.show_modes === false ? '' : `<div class="section">
        <div class="label">${esc(t.type)}</div>
        <div class="seg" role="radiogroup" aria-label="${esc(t.type)}">
          ${seg.map(([m, label, glyph]) => `<button role="radio" aria-checked="${this.mode === m}" data-act="mode" data-mode="${esc(m ?? '')}"
            data-focus="mode-${esc(m ?? '')}">${glyph ? `<span aria-hidden="true">${glyph}</span>` : ''}${esc(label)}</button>`).join('')}
        </div>
        ${this.mode ? `<div class="muted small">${esc(t.modeHint(t.modeName[this.mode]))}</div>` : ''}
      </div>`}
      ${this.isNew ? this.targetHtml() : `<div class="section linked">${this.linkedHtml()}</div>`}
      <div class="section">
        <div class="label row-between"><span>${esc(t.hours)}</span>
          <button class="link" data-act="clear" data-focus="clear">${esc(t.clearAll)}</button></div>
        <div class="muted small">${esc(t.midnightHint)}</div>
        <div class="days">${DAYS.map((_, i) => this.dayHtml(i)).join('')}</div>
      </div>`;
  }

  targetHtml() {
    const t = this.t;
    const d = this.device;
    let options = '';
    if (d) {
      const o = actionOptions(d);
      if (o.hvacModes.length) {
        options += `<div class="label">${esc(t.whileActive)}</div><div class="chips" role="radiogroup" aria-label="${esc(t.whileActive)}">
          ${o.hvacModes.map((m) => `<button class="choice" role="radio" aria-checked="${this.hvacMode === m}" data-act="hvac" data-v="${esc(m)}"
            data-focus="hvac-${esc(m)}">${esc(t.hvac[m] || m)}</button>`).join('')}</div>`;
      }
      if (o.temp) {
        options += `<div class="opt"><label class="check"><input type="checkbox" data-field="useTemp" data-focus="useTemp" ${this.temperature != null ? 'checked' : ''}>
          <span>${esc(t.setTemp)}</span></label>
          ${this.temperature != null ? `<span class="stepper" dir="ltr">
            <button class="icon-btn" data-act="temp" data-v="-1" aria-label="−" data-focus="temp-">${icon('minus')}</button>
            <b aria-live="polite">${esc(this.temperature)}°</b>
            <button class="icon-btn" data-act="temp" data-v="1" aria-label="+" data-focus="temp+">${icon('plus')}</button></span>` : ''}</div>`;
      }
      if (o.brightness) {
        options += `<div class="opt"><label class="check"><input type="checkbox" data-field="useBrightness" data-focus="useBrightness" ${this.brightness != null ? 'checked' : ''}>
          <span>${esc(t.brightness)}</span></label>
          ${this.brightness != null ? `<input type="range" min="1" max="100" value="${this.brightness}" data-field="brightness" data-focus="brightness"
            aria-label="${esc(t.brightness)}"><b class="bval">${this.brightness}%</b>` : ''}</div>`;
      }
      options += `<div class="opt"><span>${esc(o.domain === 'cover' ? t.closeAtEnd : t.turnOffAtEnd)}</span><span class="spacer"></span>
        ${switchHtml({ checked: this.turnOffAtEnd, label: o.domain === 'cover' ? t.closeAtEnd : t.turnOffAtEnd, attrs: 'data-field="turnOff" data-focus="turnOff"' })}</div>`;
    }
    return `<div class="section">
      <div class="label">${esc(t.device)}</div>
      <button class="device" data-act="pick" data-focus="pick">
        ${d ? `<span class="dname">${esc(entityName(d))}</span><span class="muted small" dir="ltr">${esc(d.entity_id)}</span><span class="spacer"></span><span class="link">${esc(t.changeDevice)}</span>`
          : `${icon('plus')}<span>${esc(t.chooseDevice)}</span>`}
      </button>
      ${options}
    </div>`;
  }

  linkedHtml() {
    const t = this.t;
    const autos = this.automations;
    const states = this.card._hass.states;
    let inner;
    if (autos === null) inner = `<div class="muted small">${esc(t.loading)}</div>`;
    else if (!autos.length) inner = `<div class="warn">${icon('alert')}<span>${esc(t.drivesNothing)}</span></div>`;
    else {
      inner = autos.map((a) => {
        const on = states[a]?.state === 'on';
        return `<div class="opt"><div class="grow"><div>${esc(entityName(states[a]) || a)}</div>
          <div class="muted small">${esc(on ? t.autoOn : t.autoOff)}</div></div>
          ${switchHtml({ checked: on, label: entityName(states[a]) || a, attrs: `data-field="auto" data-id="${esc(a)}" data-focus="auto-${esc(a)}"` })}</div>`;
      }).join('');
    }
    return `<div class="label">${esc(t.drives)}</div>${inner}`;
  }

  renderLinked() {
    const el = this.dlg?.querySelector('.linked');
    if (!el) return;
    const sig = JSON.stringify([this.automations, (this.automations || []).map((a) => this.card._hass.states[a]?.state)]);
    if (sig === this._linkedSig) return;
    this._linkedSig = sig;
    const focusKey = this.card._root().activeElement?.dataset?.focus;
    el.innerHTML = this.linkedHtml();
    if (focusKey) el.querySelector(`[data-focus="${focusKey}"]`)?.focus();
  }

  dayHtml(i) {
    const t = this.t;
    const name = DAY_NAMES[this.lang][i];
    const blocks = this.week.days[DAYS[i]];
    const chips = blocks.map((b, k) => `<span class="range"><button data-act="edit" data-day="${i}" data-index="${k}" dir="ltr"
        aria-label="${esc(`${t.editRange} ${name} ${blockLabel(b)}`)}" data-focus="edit-${i}-${k}">${esc(blockLabel(b))}</button><button
        class="x" data-act="remove" data-day="${i}" data-index="${k}" aria-label="${esc(`${t.removeRange} ${blockLabel(b)}`)}">${icon('close')}</button></span>`).join('');
    let panel = '';
    if (this.rangeEdit?.day === i) {
      const b = this.rangeEdit.index != null ? blocks[this.rangeEdit.index] : { start: 8 * 60, end: 9 * 60 };
      panel = `<div class="panel" role="group" aria-label="${esc(t.editRange)}">
        <div class="times" dir="ltr">
          <label><span>${esc(t.from)}</span><input type="time" step="60" id="from" value="${hm(b.start)}" data-autofocus></label>
          <span aria-hidden="true">–</span>
          <label><span>${esc(t.to)}</span><input type="time" step="60" id="to" value="${b.end === 1440 ? '00:00' : hm(b.end)}"></label>
        </div>
        ${this.rangeEdit.error ? `<div class="error small" role="alert">${esc(this.rangeEdit.error)}</div>` : ''}
        <div class="actions"><button class="btn" data-act="rangeCancel">${esc(t.cancel)}</button><button class="btn primary" data-act="rangeOk">${esc(t.ok)}</button></div>
      </div>`;
    } else if (this.copyFrom?.day === i) {
      const chosen = this.copyFrom.chosen;
      panel = `<div class="panel" role="group" aria-label="${esc(t.copyTo(name))}">
        <div class="label">${esc(t.copyTo(name))}</div>
        <div class="chips"><button class="choice" data-act="copyPreset" data-v="weekdays" data-autofocus>${esc(t.weekdays)}</button>
          <button class="choice" data-act="copyPreset" data-v="week">${esc(t.wholeWeek)}</button></div>
        <div class="copy-days">${DAYS.map((_, k) => (k === i ? '' : `<label class="check"><input type="checkbox" data-field="copyDay" data-v="${k}" ${chosen.has(k) ? 'checked' : ''}>
          <span>${esc(DAY_NAMES[this.lang][k])}</span></label>`)).join('')}</div>
        <div class="actions"><button class="btn" data-act="copyCancel">${esc(t.cancel)}</button><button class="btn primary" data-act="copyOk">${esc(t.copy)}</button></div>
      </div>`;
    }
    return `<div class="day">
      <div class="day-line">
        <span class="dname">${esc(name)}</span>
        <div class="ranges">${chips}<button class="add" data-act="add" data-day="${i}" data-focus="add-${i}" aria-label="${esc(`${t.addRange} ${name}`)}">${icon('plus')}<span>${esc(t.addRange)}</span></button></div>
        ${blocks.length ? `<button class="icon-btn" data-act="copyOpen" data-day="${i}" aria-label="${esc(`${t.copyDays} (${name})`)}" title="${esc(t.copyDays)}" data-focus="copy-${i}">${icon('copy')}</button>` : '<span class="icon-space"></span>'}
      </div>
      ${panel}
    </div>`;
  }

  pickerHtml() {
    const t = this.t;
    if (!this.picker) return `<div class="muted">${esc(t.loading)}</div>`;
    return `<label class="search">${icon('search')}<input type="search" id="q" data-focus="q" data-autofocus placeholder="${esc(t.searchDevice)}"
      aria-label="${esc(t.searchDevice)}" value="${esc(this.query)}"></label><div class="picker-list">${this.pickerListHtml()}</div>`;
  }

  pickerListHtml() {
    const t = this.t;
    const sections = deviceSections({ states: this.card._hass.states, ...this.picker }, this.query, t.noArea, this.lang);
    if (!sections.length) return `<div class="muted">${esc(t.noDevices)}</div>`;
    return sections.map((sec) => `<div class="area">${esc(sec.title)}</div>${sec.entities.map((e) => `
      <button class="pick" data-act="choose" data-id="${esc(e.entity_id)}"><span class="grow">${esc(entityName(e))}</span>
        <span class="muted small" dir="ltr">${esc(e.entity_id)}</span></button>`).join('')}`).join('');
  }

  confirmHtml() {
    const t = this.t;
    return `<p>${esc(t.deleteText)}</p>
      ${this.error ? `<div class="error" role="alert">${icon('alert')}<span>${esc(this.error)}</span></div>` : ''}
      <div class="actions"><button class="btn" data-act="back" ${this.saving ? 'disabled' : ''}>${esc(t.cancel)}</button>
        <button class="btn primary danger-fill" data-act="doDelete" data-autofocus ${this.saving ? 'disabled' : ''}>${this.saving ? '<span class="spinner"></span>' : ''}${esc(t.delete)}</button></div>`;
  }

  // ---- events ----

  onClick(e) {
    if (e.target === this.dlg) return; // the backdrop: keep what was typed
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const act = el.dataset.act;
    const day = el.dataset.day != null ? Number(el.dataset.day) : null;
    const index = el.dataset.index != null ? Number(el.dataset.index) : null;
    const w = this.week;
    switch (act) {
      case 'close': return this.close();
      case 'back': return this.back();
      case 'save': return this.save();
      case 'askDelete': this.view = 'confirmDelete'; this.error = ''; break;
      case 'doDelete': return this.remove();
      case 'mode': this.mode = el.dataset.mode || null; break;
      case 'pick': this.view = 'picker'; this.query = ''; break;
      case 'choose': {
        const d = this.card._hass.states[el.dataset.id];
        if (!d) return;
        this.device = d;
        const o = actionOptions(d);
        this.hvacMode = o.defaultHvac;
        this.temperature = null;
        this.brightness = null;
        if (!this.nameInput().trim()) this.week.name = entityName(d);
        this.view = 'main';
        break;
      }
      case 'hvac': this.hvacMode = el.dataset.v; break;
      case 'temp': {
        const o = actionOptions(this.device);
        this.temperature = Math.min(o.temp.max, Math.max(o.temp.min, Math.round(this.temperature + Number(el.dataset.v))));
        break;
      }
      case 'clear': for (const d of DAYS) w.days[d] = []; this.rangeEdit = this.copyFrom = null; break;
      case 'add': this.rangeEdit = { day, index: null }; this.copyFrom = null; break;
      case 'edit': this.rangeEdit = { day, index }; this.copyFrom = null; break;
      case 'remove': w.days[DAYS[day]] = w.days[DAYS[day]].filter((_, k) => k !== index); this.rangeEdit = null; break;
      case 'rangeCancel': this.rangeEdit = null; break;
      case 'rangeOk': {
        const start = toMinutes(this.dlg.querySelector('#from').value);
        let end = toMinutes(this.dlg.querySelector('#to').value);
        if (end === 0) end = 1440; // "until midnight"
        if (start == null || end == null || end <= start) {
          this.rangeEdit.error = this.t.errRange;
          break;
        }
        const d = DAYS[this.rangeEdit.day];
        const next = w.days[d].filter((_, k) => k !== this.rangeEdit.index);
        next.push({ start, end });
        w.days[d] = next.sort(byStart);
        this.rangeEdit = null;
        break;
      }
      case 'copyOpen': this.copyFrom = { day, chosen: new Set() }; this.rangeEdit = null; break;
      case 'copyPreset': for (const k of el.dataset.v === 'weekdays' ? [0, 1, 2, 3, 4] : [0, 1, 2, 3, 4, 5, 6]) this.copyFrom.chosen.add(k); break;
      case 'copyCancel': this.copyFrom = null; break;
      case 'copyOk': {
        const from = w.days[DAYS[this.copyFrom.day]];
        for (const k of this.copyFrom.chosen) if (k !== this.copyFrom.day) w.days[DAYS[k]] = from.map((b) => ({ ...b }));
        this.copyFrom = null;
        break;
      }
      default: return;
    }
    this.syncName();
    this.render();
  }

  onChange(e) {
    const f = e.target.dataset?.field;
    if (!f) return;
    if (f === 'auto') {
      const id = e.target.dataset.id;
      // Back to what HA says, whether the call worked or not.
      this.card._run(() => setAutomationEnabled(this.card._h, id, e.target.checked)).then(() => {
        this._linkedSig = null;
        this.renderLinked();
      });
      return;
    }
    if (f === 'copyDay') {
      const k = Number(e.target.dataset.v);
      e.target.checked ? this.copyFrom.chosen.add(k) : this.copyFrom.chosen.delete(k);
      return;
    }
    if (f === 'useTemp') this.temperature = e.target.checked ? actionOptions(this.device).temp.initial : null;
    else if (f === 'useBrightness') this.brightness = e.target.checked ? 80 : null;
    else if (f === 'turnOff') this.turnOffAtEnd = e.target.checked;
    else if (f === 'brightness') this.brightness = Number(e.target.value);
    else return;
    this.syncName();
    this.render();
  }

  onInput(e) {
    if (e.target.id === 'name') this.week.name = e.target.value;
    else if (e.target.id === 'q') {
      this.query = e.target.value;
      this.dlg.querySelector('.picker-list').innerHTML = this.pickerListHtml();
    } else if (e.target.dataset?.field === 'brightness') {
      this.brightness = Number(e.target.value);
      const b = this.dlg.querySelector('.bval');
      if (b) b.textContent = `${this.brightness}%`;
    }
  }

  nameInput() {
    return this.dlg.querySelector('#name')?.value ?? this.week.name;
  }

  syncName() {
    const el = this.dlg?.querySelector('#name');
    if (el) this.week.name = el.value;
  }

  // ---- writes ----

  async save() {
    const t = this.t;
    this.syncName();
    const problem = this.week.validate(this.lang) ?? (this.week.isEmpty ? t.errEmpty : null) ?? (this.isNew && !this.device ? t.errDevice : null);
    if (problem) {
      this.error = problem;
      this.render();
      this.dlg.querySelector('.dlg-body').scrollTop = 0;
      return;
    }
    this.error = '';
    this.saving = true;
    this.rangeEdit = this.copyFrom = null;
    this.render();
    const h = this.card._h;
    try {
      if (this.isNew) {
        const d = this.device;
        const climate = domainOf(d.entity_id) === 'climate';
        await createScheduleWithAutomation(h, this.week, {
          entityId: d.entity_id,
          name: entityName(d),
          hvacMode: climate ? this.hvacMode : null,
          temperature: this.temperature,
          brightnessPct: this.brightness,
          turnOffAtEnd: this.turnOffAtEnd,
        }, { labelName: this.mode });
      } else {
        await updateSchedule(h, this.id, this.week);
        // Only when the user changed it: the automations may carry a mode the schedule itself does not.
        if (this.mode !== this.originalMode) {
          const ids = [this.entityId, ...(this.automations || [])];
          const reg = await loadRegistry(h);
          for (const m of MODES) {
            if (this.mode === m) await setModeMembership(h, m, ids, true);
            else if (labelNamed(reg, m)) await setModeMembership(h, m, ids, false);
          }
        }
      }
      this.card._afterWrite();
      this.close();
    } catch (err) {
      this.saving = false;
      this.error = t.saveFailed(errorText(err));
      this.render();
      this.dlg.querySelector('.dlg-body').scrollTop = 0;
    }
  }

  async remove() {
    const t = this.t;
    this.saving = true;
    this.render();
    try {
      const kept = await deleteSchedule(this.card._h, this.entityId);
      this.card._afterWrite();
      this.close();
      if (kept.length) this.card._toast(t.kept(kept.join(', ')), 12000);
    } catch (err) {
      this.saving = false;
      this.error = t.deleteFailed(errorText(err));
      this.render();
    }
  }
}

const EDITOR_STYLE = `
  dialog.editor { padding: 0; border: 0; border-radius: var(--ha-card-border-radius, 12px); width: min(640px, calc(100vw - 32px));
    max-height: calc(100vh - 48px); background: var(--card-background-color, #fff); color: var(--primary-text-color);
    box-shadow: 0 8px 32px rgba(0,0,0,.35); overflow: hidden; }
  dialog.editor[open] { display: flex; flex-direction: column; }
  dialog.editor::backdrop { background: rgba(0,0,0,.5); }
  @media (max-width: 600px) {
    dialog.editor { width: 100vw; max-width: 100vw; height: 100vh; height: 100dvh; max-height: 100dvh; border-radius: 0; margin: 0; }
  }
  .dlg-head { display: flex; align-items: center; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--divider-color); flex: none; }
  .dlg-head h3 { flex: 1; margin: 0 4px; font-size: 18px; font-weight: 500; }
  .dlg-body { overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 18px; overscroll-behavior: contain; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field span, .label { font-size: 13px; color: var(--secondary-text-color); font-weight: 500; }
  .field input, .search input, .times input { font: inherit; color: inherit; padding: 9px 12px; border-radius: 8px;
    border: 1px solid var(--divider-color); background: var(--secondary-background-color, transparent); }
  .field input { font-size: 16px; }
  .section { display: flex; flex-direction: column; gap: 8px; }
  .row-between { display: flex; align-items: center; justify-content: space-between; }
  .link { font: inherit; font-size: 13px; color: var(--primary-color); background: none; border: 0; padding: 0; cursor: pointer; }
  .seg { display: inline-flex; align-self: flex-start; border: 1px solid var(--divider-color); border-radius: 18px; overflow: hidden; }
  .seg button { display: inline-flex; gap: 4px; align-items: center; padding: 7px 16px; border: 0; background: transparent; cursor: pointer; font-size: 14px; }
  .seg button + button { border-inline-start: 1px solid var(--divider-color); }
  .seg button[aria-checked="true"] { background: color-mix(in srgb, var(--primary-color) 20%, transparent); font-weight: 600; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .choice { padding: 6px 14px; border-radius: 16px; border: 1px solid var(--divider-color); background: transparent; cursor: pointer; font-size: 14px; }
  .choice[aria-checked="true"] { background: color-mix(in srgb, var(--primary-color) 20%, transparent); border-color: var(--primary-color); font-weight: 600; }
  .device { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 12px; border-radius: 8px; cursor: pointer; text-align: start;
    border: 1px dashed var(--divider-color); background: transparent; color: var(--primary-color); font-size: 14px; }
  .device .dname { color: var(--primary-text-color); font-weight: 500; }
  .opt { display: flex; align-items: center; gap: 8px; min-height: 40px; }
  .opt input[type=range] { flex: 1; accent-color: var(--primary-color); }
  .grow, .spacer { flex: 1; min-width: 0; }
  .check { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
  .check input { width: 18px; height: 18px; accent-color: var(--primary-color); margin: 0; }
  .stepper { display: inline-flex; align-items: center; gap: 2px; margin-inline-start: auto; }
  .stepper b { min-width: 40px; text-align: center; font-size: 16px; }
  .warn, .error { display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px; border-radius: 8px; font-size: 14px; }
  .warn { background: color-mix(in srgb, var(--warning-color, #ffa600) 16%, transparent); }
  .error { background: color-mix(in srgb, var(--error-color, #db4437) 14%, transparent); color: var(--error-color, #db4437); }
  .error.small { padding: 4px 8px; font-size: 13px; }
  .days { display: flex; flex-direction: column; }
  .day { border-bottom: 1px solid var(--divider-color); padding: 6px 0; }
  .day:last-child { border-bottom: 0; }
  .day-line { display: flex; align-items: center; gap: 8px; }
  .day-line .dname { width: 52px; flex: none; font-size: 14px; }
  .ranges { flex: 1; display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
  .range { display: inline-flex; align-items: center; border-radius: 16px; background: color-mix(in srgb, var(--primary-color) 16%, transparent); }
  .range button { border: 0; background: transparent; cursor: pointer; padding: 5px 4px 5px 12px; font-size: 14px; font-variant-numeric: tabular-nums; }
  .range .x { padding: 4px 8px 4px 2px; display: inline-flex; color: var(--secondary-text-color); }
  .range .x .ic { width: 16px; height: 16px; }
  .add { display: inline-flex; align-items: center; gap: 2px; padding: 4px 10px 4px 6px; border-radius: 16px; font-size: 13px; cursor: pointer;
    border: 1px dashed var(--divider-color); background: transparent; color: var(--primary-color); }
  .add .ic { width: 16px; height: 16px; }
  .icon-space { width: 36px; flex: none; }
  .panel { margin: 8px 0 4px; padding: 12px; border-radius: 10px; background: var(--secondary-background-color, rgba(127,127,127,.1));
    display: flex; flex-direction: column; gap: 10px; }
  .times { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
  .times label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--secondary-text-color); }
  .times input { font-size: 16px; color: var(--primary-text-color); background: var(--card-background-color); }
  .actions { display: flex; gap: 8px; justify-content: flex-end; }
  .copy-days { display: flex; flex-wrap: wrap; gap: 6px 16px; }
  .search { display: flex; align-items: center; gap: 8px; position: sticky; top: -16px; background: var(--card-background-color); padding: 4px 0 8px; z-index: 1; }
  .search input { flex: 1; font-size: 16px; }
  .search .ic { color: var(--secondary-text-color); }
  .picker-list { display: flex; flex-direction: column; }
  .area { font-size: 13px; font-weight: 600; color: var(--secondary-text-color); padding: 12px 4px 4px; }
  .pick { display: flex; align-items: center; gap: 8px; padding: 10px 8px; border: 0; border-radius: 8px; background: transparent; cursor: pointer; text-align: start; font-size: 15px; }
  .pick:hover { background: color-mix(in srgb, var(--primary-color) 8%, transparent); }
  .btn.danger-fill, .btn.danger-fill:hover { background: var(--error-color, #db4437); border-color: var(--error-color, #db4437); }
  .spinner { width: 14px; height: 14px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
`;

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

// ---------------------------------------------------------------------------- beit-shabbat-card

/** What the calendar block shows, from findCalendar: Jewish Calendar values first, Hebcal's where it has none. */
export function calendarRows(states, cal, lang = 'he', now = new Date()) {
  const t = STRINGS[lang];
  const val = (id) => (id && usable(states[id]) ? String(states[id].state) : null);
  const when = (id, hebcalId) => {
    const v = val(id);
    if (v) {
      const d = new Date(v);
      if (!isNaN(d)) return formatWhen(d, now, lang);
    }
    return val(hebcalId);
  };
  const rows = [
    ['calHoliday', val(cal.holiday) || (cal.holiday ? null : val(cal.hebcal.event))],
    ['calParasha', val(cal.parasha) || val(cal.hebcal.parasha)],
    ['calCandles', when(cal.candleLighting, cal.hebcal.candleLighting)],
    ['calHavdalah', when(cal.havdalah, cal.hebcal.havdalah)],
  ].filter(([, v]) => v);
  return {
    date: val(cal.date) || val(cal.hebcal.date),
    inEffect: states[cal.issur]?.state === 'on' || states[cal.hebcal.isShabbat]?.state === 'True',
    rows: rows.map(([k, v]) => ({ label: t[k], value: v })),
  };
}

class BeitShabbatCard extends BeitCardBase {
  static getStubConfig() {
    return { modes: [...MODES], show_calendar: true };
  }

  static getConfigElement() {
    return document.createElement('beit-shabbat-card-editor');
  }

  setConfig(config) {
    if (config?.modes && !Array.isArray(config.modes)) throw new Error('modes must be a list');
    this._config = { modes: [...MODES], show_calendar: true, ...config };
    this._sig = null;
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._loadLabels();
    if (this._autoSig !== this._automationIds()) this._loadAuto();
    this._render();
    this._members?.render();
  }

  get hass() {
    return this._hass;
  }

  getCardSize() {
    return 3 + this._config.modes.length * 3;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6 };
  }

  connectedCallback() {
    this._clock = setInterval(() => this._render(), 60000);
  }

  disconnectedCallback() {
    clearInterval(this._clock);
  }

  _automationIds() {
    return Object.keys(this._hass?.states || {}).filter((id) => id.startsWith('automation.')).join('|');
  }

  /** Finds the automatic-Shabbat automation. Its config is admin-only; others see it by alias alone. */
  async _loadAuto() {
    this._autoSig = this._automationIds();
    if (!this._config.modes.includes('שבת')) return;
    if (!this._isAdmin) {
      const hit = Object.values(this._hass.states).find((e) => e.entity_id.startsWith('automation.') && e.attributes?.friendly_name === AUTO_SHABBAT_ALIAS);
      this._auto = hit ? { entityId: hit.entity_id, ours: true } : null;
    } else {
      try {
        this._auto = await findAutoShabbat(this._h);
      } catch {
        this._auto = null;
      }
    }
    this._autoLoaded = true;
    this._render(true);
  }

  _render(force = false) {
    if (!this._config || !this._hass) return;
    const states = this._hass.states;
    const reg = this._registry();
    const cal = findCalendar(states);
    const modes = this._config.modes.filter((m) => MODES.includes(m));
    const members = Object.fromEntries(modes.map((m) => [m, {
      automations: modeMembers(states, reg, m).filter((e) => e.attributes?.friendly_name !== AUTO_SHABBAT_ALIAS),
      schedules: modeMembers(states, reg, m, 'schedule'),
    }]));
    const calIds = [cal.issur, cal.candleLighting, cal.havdalah, cal.date, cal.parasha, cal.holiday, ...Object.values(cal.hebcal)].filter(Boolean);
    const sig = JSON.stringify([
      this._lang, this._isAdmin, this._config, new Date().toDateString(), new Date().getHours(), this._busy,
      calIds.map((id) => states[id]?.state), this._labels?.length, this._auto, this._auto && states[this._auto.entityId]?.state,
      modes.map((m) => [members[m].automations.map((e) => [e.entity_id, e.state]), members[m].schedules.map((e) => [e.entity_id, e.last_updated])]),
    ]);
    if (!force && sig === this._sig) return;
    this._sig = sig;
    const root = this._root();
    if (!root.querySelector('ha-card')) {
      root.innerHTML = `<style>${BASE_STYLE}${SHABBAT_STYLE}${EDITOR_STYLE}</style><ha-card><div class="body"></div></ha-card><div class="toast" hidden role="status"></div>`;
      root.addEventListener('click', (e) => this._onClick(e));
      root.addEventListener('change', (e) => this._onChange(e));
    }
    const t = this._t;
    const body = root.querySelector('.body');
    body.setAttribute('dir', this._dirAttr());
    body.innerHTML = `
      ${this._config.title !== '' ? `<div class="header"><h2>${esc(this._config.title ?? t.shabbatAndChag)}</h2></div>` : ''}
      ${this._config.show_calendar !== false ? this._calendarHtml(states, cal) : ''}
      ${modes.map((m) => this._modeHtml(m, members[m], cal)).join('')}`;
  }

  _calendarHtml(states, cal) {
    const c = calendarRows(states, cal, this._lang);
    if (!c.date && !c.rows.length) return '';
    return `<div class="cal">
      <div class="cal-date">${esc(c.date || '')}${c.inEffect ? `<span class="chip shabbat">${esc(this._t.calInEffect)}</span>` : ''}</div>
      ${c.rows.map((r) => `<div class="cal-row"><span class="muted">${esc(r.label)}</span><span>${esc(r.value)}</span></div>`).join('')}
    </div>`;
  }

  _modeHtml(mode, { automations, schedules }, cal) {
    const t = this._t;
    const name = t.modeName[mode];
    const state = modeState(automations);
    const onCount = automations.filter((a) => a.state === 'on').length;
    const status = state === 'empty' ? t.modeEmpty : state === 'on' ? t.modeOn(automations.length) : state === 'off' ? t.modeOff : t.modePartial(onCount, automations.length);
    const busy = this._busy === mode;
    const now = new Date();
    return `<section class="mode ${mode === 'שבת' ? 'shabbat' : 'chag'} ${state}">
      <div class="mode-head">
        <span class="glyph" aria-hidden="true">${MODE_GLYPH[mode]}</span>
        <div class="grow"><div class="mode-title">${esc(t.modeTitle(name))}</div><div class="muted small">${esc(status)}</div></div>
        ${switchHtml({ checked: state === 'on', partial: state === 'partial', disabled: state === 'empty' || busy, label: t.modeSwitch(name), attrs: `data-master="${esc(mode)}"` })}
      </div>
      ${automations.length ? `<div class="members">${automations.map((a) => `
        <div class="member"><span class="grow">${esc(entityName(a))}</span>
          ${switchHtml({ checked: a.state === 'on', label: entityName(a), attrs: `data-auto="${esc(a.entity_id)}"` })}</div>`).join('')}</div>` : ''}
      ${schedules.length ? `<div class="scheds"><div class="label muted small">${esc(t.scheduleList)}</div>${schedules.map((s) => {
        const next = s.attributes?.next_event ? new Date(s.attributes.next_event) : null;
        const on = s.state === 'on';
        return `<div class="sched"><span class="dot ${on ? 'on' : ''}"></span><span class="grow">${esc(entityName(s))}</span>
          ${next && !isNaN(next) ? `<span class="muted small">${esc(`${on ? t.ends : t.starts} ${formatWhen(next, now, this._lang)}`)}</span>` : ''}</div>`;
      }).join('')}</div>` : ''}
      ${mode === 'שבת' ? this._autoHtml(cal) : `<div class="muted small hint-line">${esc(t.autoChagHint)}</div>`}
      ${this._isAdmin ? `<div class="mode-foot"><button class="btn" data-act="members" data-mode="${esc(mode)}">${icon('checklist')}<span>${esc(t.chooseAutomations)}</span></button></div>` : ''}
    </section>`;
  }

  _autoHtml(cal) {
    const t = this._t;
    const auto = this._auto;
    const on = !!auto && this._hass.states[auto.entityId]?.state === 'on';
    const noCalendar = !auto && !autoShabbatEndTrigger(cal);
    const disabled = !this._isAdmin || !this._autoLoaded || this._busy === 'auto' || noCalendar;
    return `<div class="auto">
      <div class="grow"><div>${esc(t.autoShabbat)}</div>
        <div class="muted small">${esc(noCalendar ? t.errNoCalendar : auto && !auto.ours ? t.autoShabbatNotOurs : t.autoShabbatHint)}</div></div>
      ${switchHtml({ checked: on, disabled, label: t.autoShabbat, attrs: 'data-autoshabbat="1"' })}
    </div>`;
  }

  _onClick(e) {
    const el = e.target.closest?.('[data-act]');
    if (el?.dataset.act === 'members' && !this._members) {
      this._members = new MembershipDialog(this, el.dataset.mode);
      this._members.open();
    }
  }

  async _onChange(e) {
    const d = e.target.dataset || {};
    const on = e.target.checked;
    if (d.master) {
      this._busy = d.master;
      this._render(true);
      await this._run(() => setModeEnabled(this._h, this._registry(), d.master, on));
      this._busy = null;
      this._render(true);
    } else if (d.auto) {
      await this._run(() => setAutomationEnabled(this._h, d.auto, on));
      this._render(true);
    } else if (d.autoshabbat) {
      if (!on && this._auto?.ours && !confirm(this._t.autoShabbatDelete)) {
        e.target.checked = true;
        return;
      }
      this._busy = 'auto';
      this._render(true);
      await this._run(() => (on ? enableAutoShabbat(this._h) : disableAutoShabbat(this._h)));
      this._busy = null;
      await this._loadAuto();
      this._loadLabels();
    }
  }
}

/** "Choose automations": a checklist that writes the mode's label to an automation and the schedules it follows. */
class MembershipDialog {
  constructor(card, mode) {
    this.card = card;
    this.mode = mode;
    this.busy = new Set();
    this.query = '';
  }

  open() {
    const dlg = document.createElement('dialog');
    dlg.className = 'editor';
    dlg.setAttribute('aria-labelledby', 'dlg-title');
    this.card._root().appendChild(dlg);
    this.dlg = dlg;
    dlg.addEventListener('click', (e) => {
      if (e.target.closest?.('[data-act=close]')) dlg.close();
    });
    dlg.addEventListener('input', (e) => {
      if (e.target.id === 'q') {
        this.query = e.target.value;
        this.renderList();
      }
    });
    dlg.addEventListener('change', (e) => this.toggle(e.target));
    dlg.addEventListener('close', () => {
      dlg.remove();
      this.card._members = null;
    });
    const t = this.card._t;
    dlg.setAttribute('dir', this.card._dirAttr());
    dlg.innerHTML = `<div class="dlg-head"><button class="icon-btn" data-act="close" aria-label="${esc(t.close)}">${icon('close')}</button>
      <h3 id="dlg-title">${esc(t.automationsIn(t.modeName[this.mode]))}</h3></div>
      <div class="dlg-body"><label class="search">${icon('search')}<input type="search" id="q" placeholder="${esc(t.searchAutomation)}" aria-label="${esc(t.searchAutomation)}"></label>
      <div class="muted small">${esc(t.selfExcluded)}</div><div class="checklist"></div></div>`;
    this.renderList();
    dlg.showModal();
  }

  render() {
    if (this.dlg) this.renderList();
  }

  renderList() {
    const t = this.card._t;
    const states = this.card._hass.states;
    const reg = this.card._registry();
    const members = new Set(modeMembers(states, reg, this.mode).map((e) => e.entity_id));
    const q = this.query.trim().toLowerCase();
    const autos = Object.values(states)
      .filter((e) => e.entity_id.startsWith('automation.') && e.attributes?.friendly_name !== AUTO_SHABBAT_ALIAS)
      .filter((e) => !q || entityName(e).toLowerCase().includes(q) || e.entity_id.includes(q))
      .sort((a, b) => entityName(a).localeCompare(entityName(b), this.card._lang));
    const list = this.dlg.querySelector('.checklist');
    const focusId = this.card._root().activeElement?.dataset?.id;
    list.innerHTML = autos.length ? autos.map((a) => `
      <label class="check-row"><input type="checkbox" data-id="${esc(a.entity_id)}" ${members.has(a.entity_id) ? 'checked' : ''} ${this.busy.has(a.entity_id) ? 'disabled' : ''}>
        <span class="grow"><span>${esc(entityName(a))}</span><span class="muted small" dir="ltr">${esc(a.entity_id)}</span></span>
        ${this.busy.has(a.entity_id) ? '<span class="spinner"></span>' : ''}</label>`).join('') : `<div class="muted">${esc(t.noAutomations)}</div>`;
    if (focusId) list.querySelector(`[data-id="${CSS.escape(focusId)}"]`)?.focus();
  }

  async toggle(input) {
    const id = input.dataset?.id;
    if (!id) return;
    const member = input.checked;
    const h = this.card._h;
    this.busy.add(id);
    this.renderList();
    try {
      // The automation and the schedules it follows move together.
      const schedules = schedulesIn(await automationConfig(h, id));
      await setModeMembership(h, this.mode, [id, ...schedules], member);
      await this.card._loadLabels();
    } catch (err) {
      this.card._toast(errorText(err));
    } finally {
      this.busy.delete(id);
      this.renderList();
    }
  }
}

const SHABBAT_STYLE = `
  .cal { margin: 0 16px 8px; padding: 12px 14px; border-radius: 10px; background: color-mix(in srgb, #ffa000 10%, transparent); }
  .cal-date { font-weight: 600; font-size: 15px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 4px; }
  .cal-row { display: flex; gap: 12px; font-size: 14px; padding: 2px 0; }
  .cal-row .muted { min-width: 96px; }
  .mode { margin: 8px 16px 12px; padding: 12px 0 4px; border-top: 1px solid var(--divider-color); }
  .mode-head { display: flex; align-items: center; gap: 10px; }
  .glyph { font-size: 22px; width: 32px; text-align: center; filter: grayscale(1); opacity: .6; }
  .mode.on .glyph, .mode.partial .glyph { filter: none; opacity: 1; }
  .mode-title { font-size: 17px; font-weight: 600; }
  .grow { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .members, .scheds { margin-top: 8px; padding-inline-start: 42px; }
  .member, .auto { display: flex; align-items: center; gap: 8px; min-height: 36px; }
  .sched { display: flex; align-items: center; gap: 8px; min-height: 26px; font-size: 14px; }
  .sched .grow { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .auto { margin-top: 8px; padding: 8px 10px 8px 12px; border-radius: 10px; background: var(--secondary-background-color, rgba(127,127,127,.08)); }
  .hint-line { margin-top: 8px; padding-inline-start: 42px; }
  .mode-foot { display: flex; justify-content: flex-end; margin-top: 8px; }
  .checklist { display: flex; flex-direction: column; }
  .check-row { display: flex; align-items: center; gap: 12px; padding: 8px 4px; border-bottom: 1px solid var(--divider-color); cursor: pointer; }
  .check-row input { width: 18px; height: 18px; margin: 0; accent-color: var(--primary-color); flex: none; }
  .check-row .grow span:first-child { font-size: 15px; }
`;

// ---------------------------------------------------------------------------- visual config editors

/** Shared by both editors: HA echoes our own config-changed back through setConfig; re-rendering then would steal focus. */
class BeitEditorBase extends Base {
  setConfig(config) {
    if (this._emitted && JSON.stringify(config) === this._emitted) return;
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._render();
  }

  get _t() {
    return STRINGS[langOf(this._hass)];
  }

  _emit(config) {
    for (const [k, v] of Object.entries(config)) {
      if (v === '' || v === undefined || (Array.isArray(v) && !v.length && k !== 'modes')) delete config[k];
    }
    this._config = config;
    this._emitted = JSON.stringify(config);
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config }, bubbles: true, composed: true }));
  }

  _shell(inner) {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `<style>${CONFIG_EDITOR_STYLE}</style><div class="ed" dir="${langOf(this._hass) === 'he' ? 'rtl' : 'ltr'}">${inner}</div>`;
    return this.shadowRoot;
  }
}

class BeitScheduleCardEditor extends BeitEditorBase {
  _render() {
    if (!this._config) return;
    const t = this._t;
    const c = this._config;
    const showModes = c.show_modes !== false;
    const schedules = Object.values(this._hass?.states || {})
      .filter((e) => e.entity_id.startsWith('schedule.'))
      .sort((a, b) => entityName(a).localeCompare(entityName(b), langOf(this._hass)));
    const whitelist = Array.isArray(c.entities);
    const shown = (id) => (whitelist ? c.entities.includes(id) : !(c.hide_entities || []).includes(id));
    const root = this._shell(`
      <section>
        <h3>${esc(t.edGeneral)}</h3>
        <label class="field"><span>${esc(t.edTitle)}</span><input data-key="title" value="${esc(c.title ?? '')}" placeholder="${esc(t.schedules)}"></label>
        <label class="chk"><input type="checkbox" data-bool="show_add" ${c.show_add !== false ? 'checked' : ''}><span>${esc(t.edShowAdd)}</span></label>
        <label class="chk"><input type="checkbox" data-bool="show_modes" ${showModes ? 'checked' : ''}><span>${esc(t.edShowModes)}</span></label>
        <p class="hint">${esc(t.edShowModesHint)}</p>
        ${showModes ? `<label class="field"><span>${esc(t.edModeFilter)}</span><select data-key="mode">
          <option value="" ${!c.mode ? 'selected' : ''}>${esc(t.edAllSchedules)}</option>
          ${MODES.map((m) => `<option value="${esc(m)}" ${c.mode === m ? 'selected' : ''}>${esc(t.edOnlyMode(t.modeName[m]))}</option>`).join('')}
        </select></label>` : ''}
      </section>
      <section>
        <h3>${esc(t.edSchedules)}</h3>
        <p class="hint">${esc(t.edSchedulesHint)}</p>
        <div class="actions"><button data-all>${esc(t.edAll)}</button><button data-none>${esc(t.edNone)}</button></div>
        <div class="list">${schedules.map((e) => `<label class="chk row"><input type="checkbox" data-schedule="${esc(e.entity_id)}" ${shown(e.entity_id) ? 'checked' : ''}>
          <span>${esc(entityName(e))}</span><small dir="ltr">${esc(e.entity_id)}</small></label>`).join('') || `<div class="hint">${esc(t.noSchedules)}</div>`}</div>
      </section>`);
    root.querySelectorAll('[data-key]').forEach((el) => el.addEventListener('change', () => this._emit({ ...this._config, [el.dataset.key]: el.value.trim() })));
    root.querySelectorAll('[data-bool]').forEach((el) => el.addEventListener('change', () => {
      const config = { ...this._config, [el.dataset.bool]: el.checked };
      if (el.dataset.bool === 'show_modes' && !el.checked) delete config.mode;
      if (el.checked) delete config[el.dataset.bool]; // both default to true
      this._emit(config);
      if (el.dataset.bool === 'show_modes') this._render();
    }));
    root.querySelector('.list').addEventListener('change', () => this._saveSchedules());
    root.querySelector('[data-all]').addEventListener('click', () => this._setAll(true));
    root.querySelector('[data-none]').addEventListener('click', () => this._setAll(false));
  }

  _setAll(on) {
    this.shadowRoot.querySelectorAll('[data-schedule]').forEach((b) => (b.checked = on));
    this._saveSchedules();
  }

  _saveSchedules() {
    const boxes = [...this.shadowRoot.querySelectorAll('[data-schedule]')];
    const config = { ...this._config };
    if (Array.isArray(config.entities)) config.entities = boxes.filter((b) => b.checked).map((b) => b.dataset.schedule);
    else config.hide_entities = boxes.filter((b) => !b.checked).map((b) => b.dataset.schedule);
    this._emit(config);
  }
}

class BeitShabbatCardEditor extends BeitEditorBase {
  _render() {
    if (!this._config) return;
    const t = this._t;
    const c = this._config;
    const modes = c.modes || MODES;
    const root = this._shell(`
      <section>
        <h3>${esc(t.edGeneral)}</h3>
        <label class="field"><span>${esc(t.edTitle)}</span><input data-key="title" value="${esc(c.title ?? '')}" placeholder="${esc(t.shabbatAndChag)}"></label>
        <label class="chk"><input type="checkbox" data-bool="show_calendar" ${c.show_calendar !== false ? 'checked' : ''}><span>${esc(t.edShowCalendar)}</span></label>
      </section>
      <section>
        <h3>${esc(t.edModes)}</h3>
        ${MODES.map((m) => `<label class="chk"><input type="checkbox" data-mode="${esc(m)}" ${modes.includes(m) ? 'checked' : ''}><span>${MODE_GLYPH[m]} ${esc(t.modeTitle(t.modeName[m]))}</span></label>`).join('')}
      </section>`);
    root.querySelector('[data-key]').addEventListener('change', (e) => this._emit({ ...this._config, title: e.target.value.trim() }));
    root.querySelector('[data-bool]').addEventListener('change', (e) => {
      const config = { ...this._config, show_calendar: e.target.checked };
      if (e.target.checked) delete config.show_calendar;
      this._emit(config);
    });
    root.querySelectorAll('[data-mode]').forEach((el) => el.addEventListener('change', () => {
      const chosen = [...root.querySelectorAll('[data-mode]')].filter((b) => b.checked).map((b) => b.dataset.mode);
      this._emit({ ...this._config, modes: chosen });
    }));
  }
}

const CONFIG_EDITOR_STYLE = `
  .ed { display: flex; flex-direction: column; gap: 18px; color: var(--primary-text-color); font-size: 14px; }
  section { display: flex; flex-direction: column; gap: 8px; }
  h3 { margin: 0; font-size: 15px; font-weight: 600; }
  .hint, small { color: var(--secondary-text-color); font-size: 12px; margin: 0; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field span { font-size: 12px; color: var(--secondary-text-color); }
  .field input, .field select { font: inherit; color: inherit; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--divider-color);
    background: var(--card-background-color, transparent); }
  .chk { display: flex; align-items: center; gap: 10px; cursor: pointer; }
  .chk input { width: 16px; height: 16px; margin: 0; accent-color: var(--primary-color); flex: none; }
  .chk span { flex: 1; min-width: 0; }
  .list { display: flex; flex-direction: column; max-height: 280px; overflow-y: auto; border: 1px solid var(--divider-color); border-radius: 10px; }
  .row { padding: 7px 10px; border-bottom: 1px solid var(--divider-color); }
  .row:last-child { border-bottom: 0; }
  .actions { display: flex; gap: 12px; }
  .actions button { font: inherit; font-size: 12px; color: var(--primary-color); background: none; border: 0; padding: 0; cursor: pointer; }
`;

export { BeitScheduleCardEditor, BeitShabbatCardEditor };

export { BeitScheduleCard, BeitShabbatCard, BeitCardBase };

if (typeof customElements !== 'undefined') {
  console.info(`%c BEIT-SCHEDULE-CARD %c ${VERSION} `, 'background:#ffa000;color:#000;font-weight:600', 'background:#333;color:#fff');
  if (!customElements.get('beit-schedule-card')) customElements.define('beit-schedule-card', BeitScheduleCard);
  if (!customElements.get('beit-shabbat-card')) customElements.define('beit-shabbat-card', BeitShabbatCard);
  if (!customElements.get('beit-schedule-card-editor')) customElements.define('beit-schedule-card-editor', BeitScheduleCardEditor);
  if (!customElements.get('beit-shabbat-card-editor')) customElements.define('beit-shabbat-card-editor', BeitShabbatCardEditor);
  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === 'beit-schedule-card')) {
    window.customCards.push({
      type: 'beit-schedule-card',
      name: 'Beit — תזמונים / Schedules',
      description: 'לוח זמנים שבועי לכל מכשיר, עם מצבי שבת וחג. Weekly device schedules with Shabbat and chag modes.',
      preview: false,
    });
  }
  if (!window.customCards.some((c) => c.type === 'beit-shabbat-card')) {
    window.customCards.push({
      type: 'beit-shabbat-card',
      name: 'Beit — שבת וחג / Shabbat & chag',
      description: 'מצבי שבת וחג בלחיצה, שבת אוטומטית וזמני השבת. Shabbat and chag modes, automatic Shabbat, and the times.',
      preview: false,
    });
  }
}
