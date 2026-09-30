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

// ---------------------------------------------------------------------------- strings

export const STRINGS = {
  he: {
    errName: 'צריך שם לתזמון',
    errReversed: (day) => `ביום ${day}: שעת הסיום לפני שעת ההתחלה`,
    errOverlap: (day) => `ביום ${day}: יש טווחים חופפים`,
  },
  en: {
    errName: 'The schedule needs a name',
    errReversed: (day) => `${day}: a range ends before it starts`,
    errOverlap: (day) => `${day}: ranges overlap`,
  },
};

// ---------------------------------------------------------------------------- cards

class BeitScheduleCard extends (globalThis.HTMLElement || class {}) {
  setConfig(config) {
    this._config = config || {};
    this.innerHTML = '<ha-card><div style="padding:16px">Beit Schedule Card</div></ha-card>';
  }

  set hass(hass) {
    this._hass = hass;
  }

  getCardSize() {
    return 1;
  }
}

export { BeitScheduleCard };

if (typeof customElements !== 'undefined' && !customElements.get('beit-schedule-card')) {
  customElements.define('beit-schedule-card', BeitScheduleCard);
}
