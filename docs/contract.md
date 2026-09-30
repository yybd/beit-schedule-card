# The data contract shared with the Beit app

The card and the Beit native app (`../app`, Flutter) edit **the same HA objects**. Anything one creates, the other
must read and be able to edit or delete. Change this contract in both places or not at all.

The Dart that implements it today lives in the Beit app: `lib/ha/schedule.dart` (week model, automation builder,
marker), `test/schedule_test.dart` (cases to port 1:1), `lib/store/home_store.dart` (every HA call and its order),
`lib/ui/schedule_editor.dart` and `lib/ui/shabbat_screen.dart` (the UI this card mirrors).

## 1. Schedules

- The HA `schedule` helper, UI-managed, via WebSocket `schedule/list | create | update | delete`.
- Days are HA's keys, shown Sunday first: `sunday … saturday`.
- A block is `{"from": "HH:MM:SS", "to": "HH:MM:SS"}`.
  - `"24:00:00"` means "until midnight" (HA accepts it; verified on 2026.8).
  - Read `"23:59:59"` as 24:00; the app writes it back as `"24:00:00"`.
  - Minute precision.
- Blocks within a day must not overlap, and `to > from`. HA rejects the write otherwise.
- `schedule/create` generates the id as a slug of the name. The entity is `schedule.<id>`.
- `schedule/update` takes the full body: `schedule_id`, `name` and all seven days.

## 2. The automation a schedule drives

Written with `POST /api/config/automation/config/<id>`. From a card this is `hass.callApi('POST', 'config/automation/config/<id>', body)`. `<id>` is `Date.now()` as a string.

```json
{
  "id": "<ms timestamp>",
  "alias": "Beit · <schedule name>",
  "description": "נוצר באפליקציית Beit — <device name> לפי schedule.<id>",
  "triggers": [
    {"trigger": "state", "entity_id": ["schedule.<id>"], "to": ["on"],  "not_from": ["unavailable", "unknown"], "id": "schedule_on"},
    {"trigger": "state", "entity_id": ["schedule.<id>"], "to": ["off"], "not_from": ["unavailable", "unknown"], "id": "schedule_off"}
  ],
  "conditions": [],
  "actions": [{"choose": [
    {"conditions": [{"condition": "trigger", "id": "schedule_on"}],  "sequence": ["<on actions>"]},
    {"conditions": [{"condition": "trigger", "id": "schedule_off"}], "sequence": ["<off actions>"]}
  ]}],
  "mode": "queued"
}
```

- **The marker.** The description contains `נוצר באפליקציית Beit`. That string is the marker. **Only automations carrying it may be rewritten or deleted.** Hand-written automations are listed, never touched.
- **When the device stays on at the end of the range,** there is no `schedule_off` trigger and no off branch.
- **On actions, per domain:**
  - `climate`: `climate.set_temperature {temperature, hvac_mode}` when a temperature is set; otherwise `climate.set_hvac_mode {hvac_mode}`.
  - `water_heater`: `turn_on`, plus `set_temperature` if one is set.
  - `light`: `turn_on`, with `brightness_pct` if set.
  - `cover`: `open_cover`.
  - `valve`: `open_valve`.
  - Anything else: `<domain>.turn_on`.
- **Off actions:** `close_cover`, `close_valve`, `media_player.media_pause`, otherwise `<domain>.turn_off`.
- **Order when creating:**
  1. `schedule/create`.
  2. Wait for `schedule.<id>` to appear in `hass.states`.
  3. POST the automation.
  4. If the POST fails, `schedule/delete`, so the card never leaves a helper that drives nothing.
- **Renaming a schedule:** each related automation carrying the marker and still named `Beit · <old name>` is POSTed
  again with `alias: "Beit · <new name>"` and nothing else changed. An alias the user changed is left alone.
- **Finding a schedule's automations:** `search/related {item_type: "entity", item_id: "schedule.<id>"}` → `.automation[]`.
- **Reading one automation:** `automation/config {entity_id}` → `.config`.
- **Deleting a schedule:**
  1. For each related automation carrying the marker: `DELETE /api/config/automation/config/<config id>`.
  2. `schedule/delete`.
  3. Report the related automations that were kept.

## 3. Shabbat / chag modes

- **A mode is an HA label.** Labels are identified by **name**, `שבת` and `חג`, never by id. HA slugs Hebrew names (for example `shbt`), and the slug is not guaranteed.
- **Creating a missing label:** `config/label_registry/create {name, icon: "mdi:candle" | "mdi:star-david", color: "amber" | "indigo"}`.
- **Membership:** an automation, and the schedules it follows, carry the label. Write it with `config/entity_registry/update {entity_id, labels: [...]}`. That call **replaces** the list, so merge with the existing labels, which you read from `config/entity_registry/list_for_display` → `lb`.
- **Switching a mode:** `automation.turn_on` / `automation.turn_off` with target `{label_id}`, or with the member list. The switch shows:
  - "on" when every member is on;
  - "partial" when some are;
  - "off" when none are.
- **Automatic Shabbat.** One automation, alias `Beit · מצב שבת אוטומטי`, carrying the marker:
  - Fridays at 12:00 it turns the label on. That is before typical Friday-afternoon schedules; candle lighting is too late.
  - When Shabbat ends (see §4), it waits until every `schedule.*` carrying the label is off (6 h timeout), then turns the label off with `stop_actions: false`.
  - The card creates it on request, and **recognises** an existing one by the marker and the alias, so there is never a second.

## 4. Calendar sources

Find these entities by prefix, not by exact id: HA may add suffixes such as `_2` or `_3`.

- **Jewish Calendar (core integration). Preferred.**
  - `binary_sensor.jewish_calendar_issur_melacha_in_effect*` covers Shabbat **and** yom tov.
  - Also `…_erev_shabbat_hag*`, `…_motzei_shabbat_hag*`, `sensor.jewish_calendar_upcoming_candle_lighting*` and `…_upcoming_havdalah*`.
- **Hebcal (custom integration). Optional.**
  - `sensor.hebcal_is_shabbat` (`True`/`False`) is reliable for Shabbat.
  - `sensor.hebcal_is_yomtov` has been seen reporting "אין מידע" through Sukkot, so do not use it for chag.
  - Its sensors pass through `unknown` on every HA restart, so triggers on them must use explicit `from`/`to`.
