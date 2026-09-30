// A `hass` for the preview's live mode: HA's WebSocket opened from the page, REST through dev/serve.py's /api proxy.
// Read-only unless the page was opened with &writes=1: every command that could change the house throws first.

const READS = new Set([
  'get_states', 'get_config', 'auth/current_user', 'subscribe_entities', 'subscribe_events', 'schedule/list', 'search/related',
  'automation/config', 'config/label_registry/list', 'config/entity_registry/list_for_display', 'config/area_registry/list',
  'config/device_registry/list',
]);

export async function connectLive({ writes = false, language = 'he', onChange = () => {}, log = () => {} } = {}) {
  const { ws: url, token } = await (await fetch('/live.json')).json();
  const ws = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const subs = new Map();
  await new Promise((resolve, reject) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      else if (msg.type === 'auth_ok') resolve();
      else if (msg.type === 'auth_invalid') reject(new Error(msg.message));
    };
    ws.onerror = () => reject(new Error(`cannot open ${url}`));
  });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === 'result' && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.success ? resolve(msg.result) : reject(msg.error);
    } else if (msg.type === 'event' && subs.has(msg.id)) subs.get(msg.id)(msg.event);
  };
  const send = (msg) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, ...msg }));
  });
  const subscribe = async (msg, fn) => {
    const id = nextId;
    subs.set(id, fn);
    await send(msg);
  };
  const guard = (what) => {
    if (!writes) throw { code: 'read_only', message: `Read-only preview: ${what} was not sent (open with &writes=1)` };
  };

  let states = {};
  let entities = {};
  const loadEntities = async () => {
    const d = await send({ type: 'config/entity_registry/list_for_display' });
    entities = Object.fromEntries(d.entities.map((e) => [e.ei, {
      entity_id: e.ei, device_id: e.di ?? null, area_id: e.ai ?? null, labels: e.lb || [], hidden: !!e.hb,
      entity_category: e.ec === undefined ? null : d.entity_categories[e.ec], platform: e.pl,
    }]));
  };
  const user = await send({ type: 'auth/current_user' });
  await loadEntities();

  const hass = {
    get states() { return states; },
    get entities() { return entities; },
    user,
    language,
    locale: { language },
    themes: { darkMode: false },
    async callWS(msg) {
      if (!READS.has(msg.type)) guard(msg.type);
      log(`ws ${JSON.stringify(msg)}`);
      return send(msg);
    },
    async callApi(method, path, body) {
      if (method !== 'GET') guard(`${method} ${path}`);
      log(`api ${method} ${path}`);
      const res = await fetch(`/api/${path}`, { method, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!res.ok) throw { error: data?.message || res.statusText, status_code: res.status, body: data };
      return data;
    },
    async callService(domain, service, data = {}, target = {}, _notifyOnError = true, returnResponse = false) {
      // schedule.get_schedule only reads; everything else could change the house.
      if (!(domain === 'schedule' && service === 'get_schedule')) guard(`${domain}.${service}`);
      log(`service ${domain}.${service} ${JSON.stringify(target)}`);
      return send({ type: 'call_service', domain, service, service_data: data, target, ...(returnResponse ? { return_response: true } : {}) });
    },
  };
  const snapshot = () => ({ ...hass, states, entities });

  // subscribe_entities sends compressed states: a = added in full, c = changed (+ / -), r = removed.
  const iso = (sec) => new Date(sec * 1000).toISOString();
  const full = (id, s) => ({
    entity_id: id, state: s.s, attributes: s.a || {}, context: { id: s.c },
    last_changed: iso(s.lc), last_updated: iso(s.lu ?? s.lc),
  });
  await subscribe({ type: 'subscribe_entities' }, (ev) => {
    const next = { ...states };
    for (const [id, s] of Object.entries(ev.a || {})) next[id] = full(id, s);
    for (const [id, ch] of Object.entries(ev.c || {})) {
      const cur = next[id];
      if (!cur) continue;
      const e = { ...cur, attributes: { ...cur.attributes } };
      const plus = ch['+'];
      if (plus) {
        if ('s' in plus) e.state = plus.s;
        if (plus.a) Object.assign(e.attributes, plus.a);
        if (plus.lc) e.last_changed = e.last_updated = iso(plus.lc);
        if (plus.lu) e.last_updated = iso(plus.lu);
      }
      for (const k of ch['-']?.a || []) delete e.attributes[k];
      next[id] = e;
    }
    for (const id of ev.r || []) delete next[id];
    states = next;
    onChange(snapshot());
  });
  await subscribe({ type: 'subscribe_events', event_type: 'entity_registry_updated' }, async () => {
    await loadEntities();
    onChange(snapshot());
  });
  return { snapshot };
}
