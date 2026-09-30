// An in-memory Home Assistant for the tests and the offline preview.
//
// It implements every command in docs/contract.md and mutates its state the way HA does: schedule/create adds
// `schedule.<slug>` to `states` (a moment later, as HA does), an automation POST adds or replaces `automation.<slug>`,
// entity_registry/update replaces an entity's labels, automation.turn_on/off honours entity and label targets.
// It runs in node and in the browser: no imports, fixtures are passed in.

import { WeekSchedule, weekStatus, DAYS } from '../dist/beit-schedule-card.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

// Enough of HA's slugify for the tests: Hebrew is transliterated letter by letter, as unidecode would roughly do.
const HEBREW = { א: '', ב: 'b', ג: 'g', ד: 'd', ה: 'h', ו: 'v', ז: 'z', ח: 'kh', ט: 't', י: 'y', כ: 'k', ך: 'k', ל: 'l', מ: 'm', ם: 'm', נ: 'n', ן: 'n', ס: 's', ע: '', פ: 'p', ף: 'p', צ: 'ts', ץ: 'ts', ק: 'q', ר: 'r', ש: 'sh', ת: 't' };
export function slugify(text, fallback = 'unnamed') {
  const s = [...String(text).toLowerCase()].map((c) => HEBREW[c] ?? c).join('')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return s || fallback;
}

class HAError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class FakeHass {
  /**
   * @param fixtures {states, schedule_list, automation_configs, label_registry, entity_registry_display,
   *                  area_registry, device_registry}
   * @param options  {now: () => Date, stateDelay: ms, isAdmin, language}
   */
  constructor(fixtures, { now = () => new Date(), stateDelay = 5, isAdmin = true, language = 'he' } = {}) {
    const f = clone(fixtures);
    this.now = now;
    this.stateDelay = stateDelay;
    this.calls = [];
    this._fail = {};
    this._listeners = new Set();
    this._schedules = f.schedule_list || [];
    this._yamlSchedules = f.yaml_schedules || {}; // what get_schedule knows of YAML schedules
    this._configs = {}; // automation config id -> {entityId, config}
    for (const [entityId, config] of Object.entries(f.automation_configs || {})) this._configs[config.id] = { entityId, config };
    this._labels = f.label_registry || [];
    this._display = f.entity_registry_display || { entity_categories: {}, entities: [] };
    this._areas = f.area_registry || [];
    this._devices = f.device_registry || [];
    this._states = Object.fromEntries((f.states || []).map((s) => [s.entity_id, s]));
    for (const s of this._schedules) this._states[`schedule.${s.id}`] = this._scheduleState(s);
    this.user = { id: 'fake', name: 'Fake', is_admin: isAdmin };
    this.language = language;
    this.locale = { language };
    this.themes = { darkMode: false };
    this._rebuildEntities();
  }

  // ---- what a card reads --------------------------------------------------------------------------------------

  get states() {
    return this._states;
  }

  get entities() {
    return this._entities;
  }

  /** A fresh hass object, as HA hands a card on every change. */
  snapshot() {
    const self = this;
    return {
      states: this._states,
      entities: this._entities,
      user: this.user,
      language: this.language,
      locale: this.locale,
      themes: this.themes,
      callWS: (m) => self.callWS(m),
      callApi: (...a) => self.callApi(...a),
      callService: (...a) => self.callService(...a),
    };
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** Make the next call of this kind (a WS type, or "POST config/automation/config") fail with `message`. */
  failNext(kind, message = 'Simulated failure') {
    this._fail[kind] = message;
  }

  /** Recompute every UI schedule's state and next_event (the preview calls this once a minute). */
  tick() {
    for (const s of this._schedules) this._setState(`schedule.${s.id}`, this._scheduleState(s));
  }

  // ---- WebSocket -------------------------------------------------------------------------------------------------

  async callWS(msg) {
    this.calls.push({ kind: 'ws', ...clone(msg) });
    this._maybeFail(msg.type);
    const h = WS[msg.type];
    if (!h) throw new HAError('unknown_command', `Unknown command: ${msg.type}`);
    return clone(await h.call(this, msg));
  }

  // ---- REST (automation config) ------------------------------------------------------------------------------------

  async callApi(method, path, body) {
    this.calls.push({ kind: 'api', method, path, body: body && clone(body) });
    const m = path.match(/^config\/automation\/config\/(.+)$/);
    if (!m) throw new HAError('not_found', `404: ${path}`);
    this._maybeFail(`${method} config/automation/config`);
    const id = decodeURIComponent(m[1]);
    if (method === 'GET') {
      if (!this._configs[id]) throw new HAError('not_found', 'Resource not found');
      return clone(this._configs[id].config);
    }
    if (method === 'POST') {
      if (!body?.triggers?.length) throw new HAError('invalid', 'Message malformed: required key not provided @ data[\'triggers\']');
      const existing = this._configs[id];
      const entityId = existing?.entityId || this._freeId('automation', slugify(body.alias || id));
      this._configs[id] = { entityId, config: { ...clone(body), id } };
      this._later(() => {
        const prev = this._states[entityId];
        this._setState(entityId, this._state(entityId, prev?.state ?? 'on', {
          id, last_triggered: null, mode: body.mode || 'single', current: 0, friendly_name: body.alias || entityId,
        }));
        this._ensureRegistry(entityId, 'automation');
      });
      return { result: 'ok' };
    }
    if (method === 'DELETE') {
      const existing = this._configs[id];
      if (!existing) throw new HAError('not_found', 'Resource not found');
      delete this._configs[id];
      this._removeEntity(existing.entityId);
      return { result: 'ok' };
    }
    throw new HAError('not_allowed', `405: ${method}`);
  }

  // ---- services ------------------------------------------------------------------------------------------------------

  async callService(domain, service, data = {}, target = {}, _notifyOnError = true, returnResponse = false) {
    this.calls.push({ kind: 'service', domain, service, data: clone(data || {}), target: clone(target || {}) });
    this._maybeFail(`${domain}.${service}`);
    const ids = this._resolveTarget({ ...(data || {}), ...(target || {}) });
    if (domain === 'schedule' && service === 'get_schedule') {
      if (!returnResponse) throw new HAError('service_validation_error', 'Service call requires responses but caller did not ask for responses');
      const response = {};
      for (const id of ids) {
        const item = this._schedules.find((x) => `schedule.${x.id}` === id) || this._yamlSchedules[id];
        if (item) response[id] = Object.fromEntries(DAYS.map((d) => [d, clone(item[d] || [])]));
      }
      return { context: { id: 'fake' }, response };
    }
    if (domain === 'automation' && (service === 'turn_on' || service === 'turn_off')) {
      for (const id of ids.filter((x) => x.startsWith('automation.'))) {
        const st = this._states[id];
        if (st) this._setState(id, { ...st, state: service === 'turn_on' ? 'on' : 'off', last_updated: this.now().toISOString() });
      }
    }
    return { context: { id: 'fake' } };
  }

  // ---- internals ------------------------------------------------------------------------------------------------------

  _maybeFail(kind) {
    if (kind in this._fail) {
      const message = this._fail[kind];
      delete this._fail[kind];
      throw new HAError('home_assistant_error', message);
    }
  }

  _later(fn) {
    if (this.stateDelay > 0) setTimeout(fn, this.stateDelay);
    else fn();
  }

  _resolveTarget(t) {
    const ids = new Set([].concat(t.entity_id || []));
    for (const label of [].concat(t.label_id || [])) {
      for (const e of this._display.entities) if ((e.lb || []).includes(label)) ids.add(e.ei);
    }
    return [...ids];
  }

  _state(entityId, state, attributes) {
    const t = this.now().toISOString();
    return { entity_id: entityId, state, attributes, last_changed: t, last_updated: t, context: { id: 'fake', parent_id: null, user_id: null } };
  }

  _scheduleState(item) {
    const { on, next } = weekStatus(WeekSchedule.fromHA(item), this.now());
    const prev = this._states?.[`schedule.${item.id}`];
    const attributes = { editable: true, next_event: next ? isoLocal(next) : null, friendly_name: item.name };
    const state = on ? 'on' : 'off';
    if (prev && prev.state === state && JSON.stringify(prev.attributes) === JSON.stringify(attributes)) return prev;
    return this._state(`schedule.${item.id}`, state, attributes);
  }

  _setState(entityId, st) {
    if (this._states[entityId] === st) return;
    this._states = { ...this._states, [entityId]: st };
    this._emit();
  }

  _removeEntity(entityId) {
    const { [entityId]: _gone, ...rest } = this._states;
    this._states = rest;
    this._display = { ...this._display, entities: this._display.entities.filter((e) => e.ei !== entityId) };
    this._rebuildEntities();
    this._emit();
  }

  _ensureRegistry(entityId, platform) {
    if (this._display.entities.some((e) => e.ei === entityId)) return;
    this._display = { ...this._display, entities: [...this._display.entities, { ei: entityId, pl: platform, lb: [] }] };
    this._rebuildEntities();
    this._emit();
  }

  _freeId(domain, slug) {
    let id = `${domain}.${slug}`;
    for (let n = 2; this._states[id] || Object.values(this._configs).some((c) => c.entityId === id); n++) id = `${domain}.${slug}_${n}`;
    return id;
  }

  // hass.entities, as the frontend builds it from list_for_display.
  _rebuildEntities() {
    this._entities = Object.fromEntries(this._display.entities.map((e) => [e.ei, {
      entity_id: e.ei, device_id: e.di ?? null, area_id: e.ai ?? null, labels: e.lb || [], hidden: !!e.hb,
      entity_category: e.ec === undefined ? null : this._display.entity_categories[e.ec], platform: e.pl,
    }]));
  }

  _emit() {
    for (const fn of this._listeners) fn(this);
  }
}

function isoLocal(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

function checkWeek(msg) {
  if (!String(msg.name ?? '').trim()) throw new HAError('invalid_format', 'Invalid name');
  for (const d of DAYS) {
    const blocks = [...(msg[d] || [])].sort((a, b) => a.from.localeCompare(b.from));
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].to <= blocks[i].from) throw new HAError('invalid_format', `Invalid time range, from ${blocks[i].from} is after ${blocks[i].to}`);
      if (i > 0 && blocks[i].from < blocks[i - 1].to) throw new HAError('invalid_format', 'Overlapping times found in schedule');
    }
  }
}

const weekOf = (msg) => Object.fromEntries(DAYS.map((d) => [d, msg[d] || []]));

const WS = {
  'schedule/list'() {
    return this._schedules;
  },
  'schedule/create'(msg) {
    checkWeek(msg);
    let id = slugify(msg.name);
    for (let n = 2; this._schedules.some((s) => s.id === id) || this._states[`schedule.${id}`]; n++) id = `${slugify(msg.name)}_${n}`;
    const item = { id, name: msg.name, ...weekOf(msg) };
    this._schedules = [...this._schedules, item];
    this._later(() => {
      this._setState(`schedule.${id}`, this._scheduleState(item));
      this._ensureRegistry(`schedule.${id}`, 'schedule');
    });
    return item;
  },
  'schedule/update'(msg) {
    const i = this._schedules.findIndex((s) => s.id === msg.schedule_id);
    if (i < 0) throw new HAError('not_found', `Unable to find schedule_id ${msg.schedule_id}`);
    checkWeek(msg);
    const item = { id: msg.schedule_id, name: msg.name, ...weekOf(msg) };
    this._schedules = this._schedules.map((s, k) => (k === i ? item : s));
    this._setState(`schedule.${item.id}`, this._scheduleState(item));
    return item;
  },
  'schedule/delete'(msg) {
    if (!this._schedules.some((s) => s.id === msg.schedule_id)) throw new HAError('not_found', `Unable to find schedule_id ${msg.schedule_id}`);
    this._schedules = this._schedules.filter((s) => s.id !== msg.schedule_id);
    this._removeEntity(`schedule.${msg.schedule_id}`);
    return null;
  },
  'search/related'(msg) {
    if (msg.item_type === 'label') {
      // As HA does: automations that target the label, and entities that carry it.
      const needle = `"label_id":"${msg.item_id}"`;
      const targeting = Object.values(this._configs).filter((c) => JSON.stringify(c.config).includes(needle)).map((c) => c.entityId);
      const carrying = this._display.entities.filter((e) => (e.lb || []).includes(msg.item_id)).map((e) => e.ei);
      const automation = [...new Set([...targeting, ...carrying.filter((id) => id.startsWith('automation.'))])];
      const out = {};
      if (automation.length) out.automation = automation;
      if (carrying.length) out.entity = carrying;
      return out;
    }
    const needle = new RegExp(`\\b${msg.item_id.replace('.', '\\.')}\\b`);
    const automation = Object.values(this._configs)
      .filter((c) => needle.test(JSON.stringify(c.config)))
      .map((c) => c.entityId);
    const out = {};
    if (automation.length) out.automation = automation;
    const labels = this._display.entities.find((e) => e.ei === msg.item_id)?.lb;
    if (labels?.length) out.label = labels;
    return out;
  },
  'automation/config'(msg) {
    const hit = Object.values(this._configs).find((c) => c.entityId === msg.entity_id);
    if (!hit) throw new HAError('not_found', 'Entity not found');
    return { config: hit.config };
  },
  'config/label_registry/list'() {
    return this._labels;
  },
  'config/label_registry/create'(msg) {
    if (this._labels.some((l) => l.name === msg.name)) throw new HAError('invalid_info', `The name ${msg.name} is already in use`);
    let id = slugify(msg.name, 'label');
    for (let n = 2; this._labels.some((l) => l.label_id === id); n++) id = `${slugify(msg.name, 'label')}_${n}`;
    const label = { label_id: id, name: msg.name, icon: msg.icon ?? null, color: msg.color ?? null, description: null, created_at: 0, modified_at: 0 };
    this._labels = [...this._labels, label];
    return label;
  },
  'config/entity_registry/list_for_display'() {
    return this._display;
  },
  'config/entity_registry/get'(msg) {
    const e = this._display.entities.find((x) => x.ei === msg.entity_id);
    if (!e) throw new HAError('not_found', 'Entity not found');
    const [domain, objectId] = msg.entity_id.split('.');
    const config = Object.values(this._configs).find((c) => c.entityId === msg.entity_id);
    const scheduleIds = this._scheduleIds || {};
    const uniqueId = domain === 'schedule' ? scheduleIds[msg.entity_id] ?? objectId : domain === 'automation' ? config?.config.id ?? objectId : msg.entity_id;
    return { entity_id: msg.entity_id, unique_id: uniqueId, platform: e.pl, labels: [...(e.lb || [])], disabled_by: null };
  },
  'config/entity_registry/update'(msg) {
    const e = this._display.entities.find((x) => x.ei === msg.entity_id);
    if (!e) throw new HAError('not_found', 'Entity not found');
    for (const l of msg.labels || []) {
      if (!this._labels.some((x) => x.label_id === l)) throw new HAError('invalid_format', `Unknown label ${l}`);
    }
    const next = { ...e, lb: [...(msg.labels ?? e.lb)] };
    this._display = { ...this._display, entities: this._display.entities.map((x) => (x.ei === msg.entity_id ? next : x)) };
    this._rebuildEntities();
    this._emit();
    return { entity_entry: { entity_id: msg.entity_id, labels: next.lb } };
  },
  'config/area_registry/list'() {
    return this._areas;
  },
  'config/device_registry/list'() {
    return this._devices;
  },
};
