# Plan: Beit Schedule Card v1.0

> Renamed in 2.0: the card is now **Schedule Helper Card** (`dist/schedule-helper-card.js`, `custom:schedule-helper-card`,
> `custom:schedule-helper-shabbat-card`). This plan keeps the 1.0 names it was written with.

The goal is a HACS dashboard plugin, one file `dist/beit-schedule-card.js`, that registers two cards,
`beit-schedule-card` and `beit-shabbat-card`. It does everything the README promises and follows the data contract in
[docs/contract.md](docs/contract.md) exactly.

The card is a port of the schedule editor and the Shabbat/chag screen of the Beit Flutter app. The app's code is the
reference implementation (listed at the top of the contract). Where the app and this plan disagree, the contract wins.

## Decisions (already made — do not relitigate)

- **Plain JavaScript with custom elements. No build step, no framework, no npm dependencies at runtime.** This matches
  the author's other card (ha-kcm-radio) and means HACS serves the source file as is.
- **Frontend only.** The card uses `hass.callWS`, `hass.callApi` and `hass.callService`. No Python integration.
- **One file, two cards.** Pure logic sits at the top of the file and is exported. Custom-element registration is
  guarded by `typeof customElements !== 'undefined'`, so that `node --test` can import the file.
- **Tests use Node's built-in runner** (`node --test 'tests/*.test.mjs'`), with no test dependencies.
- **Do not use Home Assistant's internal elements** (`ha-entity-picker`, `ha-dialog`…). They are lazy-loaded and
  change between releases. Build our own small controls from HA theme CSS variables. `ha-card` is fine.
- **Styling.** Use HA CSS variables (`--primary-color`, `--card-background-color`, `--primary-text-color`,
  `--secondary-text-color`, `--divider-color`, `--ha-card-border-radius`…).
- **Direction.** Take it from `hass.locale`/`hass.language`: `rtl` for `he`. Time bars always run left to right.
- **UI strings** in Hebrew and English, from a small `STRINGS` table, chosen by `hass.language`.

## Phases

Each phase ends with passing tests and **one commit**.

### 0 · Scaffold (partly done)
- Already present: `hacs.json`, `LICENSE`, `.github/workflows/validate.yml` (HACS action and `node --test`),
  `.claude/launch.json`.
- Add `dist/beit-schedule-card.js` exporting a stub card that renders "Beit Schedule Card".
- Add `tests/smoke.test.mjs`, which imports the file and checks the exports.

### 1 · Logic — a port of `schedule.dart`
- **Week model.**
  - `parseBlock` and `formatBlock`. `"24:00:00"` means 1440 minutes; `"23:59:59"` reads as 1440; precision is minutes.
  - `WeekSchedule` with `fromHA`, `toHA` (days sorted Sunday first) and `validate()`. `validate()` returns the Hebrew
    messages the app uses: an empty name, an end before the start, overlapping ranges.
- **Automation builder.**
  - `onActions(target)`, `offActions(target)`, `buildScheduleAutomation({id, scheduleEntityId, scheduleName, target})`
    must produce the same JSON as the Dart builder.
  - `BEIT_MARKER = 'נוצר באפליקציית Beit'`.
- **Other helpers.**
  - `isOurs(automationConfig)`.
  - `modeState(members)`, which returns `'on' | 'partial' | 'off' | 'empty'`.
  - `findCalendar(states)`, which finds the Jewish Calendar entities (by prefix, preferred) or the Hebcal ones.
  - `buildAutoShabbatAutomation({id, labelId, shabbatEndTrigger})`, which uses Jewish Calendar `motzei`/`issur`
    when present and otherwise Hebcal `True→False`.
- **Tests.**
  - Port the app's `schedule_test.dart` cases one for one.
  - Add round-trip tests over the synthetic fixtures.

### 2 · Fake `hass` and HA operations
- **`tests/fixtures/`: synthetic, anonymised data only.**
  - Make roughly 6 schedules with realistic Shabbat, chag and weekday patterns, including `24:00` and a 2-block Saturday.
  - Add about 10 devices across climate, light, switch, cover and water_heater.
  - Add labels, `list_for_display`, `search/related` results, 3–4 automation configs (hand-written ones and one
    carrying the marker), and Jewish Calendar states.
  - **Never commit real data from anyone's house.**
- **`tests/fake-hass.mjs`:** an in-memory `hass` that implements every command in the contract (`callWS`, `callApi`,
  `callService`) and mutates its state like HA does. For example, `schedule/create` adds `schedule.<slug>` to `states`.
- **`ops`, a set of functions taking `hass`,** mirroring the app's `home_store_ha_ops.dart`:
  - schedules: `listSchedules`, `createScheduleWithAutomation` (with rollback), `updateSchedule`, `deleteSchedule`
    (returns the automations it kept), `automationsFor`;
  - automations: `setAutomationEnabled`;
  - modes: `ensureLabel`, `setModeMembership` (merges labels), `setModeEnabled`, `modeMembers`, `findAutoShabbat`,
    `enableAutoShabbat`, `disableAutoShabbat`.
- **Tests:** each op against the fake, including the rollback path and "delete keeps hand-written automations".

### 3 · `beit-schedule-card`
- **The list.** One row per schedule: name, mode chip, on/off now, "starts/ends <when>" (from `next_event`), and seven
  thin day bars.
- **YAML schedules.** A schedule that is in `hass.states` but missing from `schedule/list` came from YAML. Show it
  read-only with a lock icon.
- **Rendering.** Re-render only when the relevant entities change. Keep a cheap signature of their `last_updated`, so
  the card doesn't redraw every second.
- **Config.** `getStubConfig`, and the options `title`, `mode`, `entities`, `hide_entities`, `show_add`.
- **Permissions.** Non-admin users (`hass.user.is_admin === false`) get no editing.

### 4 · The editor dialog
- **A plain dialog** (`<dialog>` or a fixed overlay), scrollable, and full-screen below 600 px.
- **New schedule.**
  - A device picker grouped by area, with search. Use `config/area_registry/list`, `config/device_registry/list` and
    `list_for_display` to place devices in areas, and filter the same way as the app.
  - The action options per domain: HVAC mode chips; a temperature checkbox with ±; a brightness checkbox with a
    slider; "turn off at the end".
- **Existing schedule.**
  - Name and hours.
  - The mode segment (רגיל / שבת / חג).
  - The automations it drives, each with an enable switch.
  - A warning when nothing drives it.
- **The week editor.**
  - A row per day, with chips for ranges. A chip opens a from/to pair of `<input type="time">`; an end of 00:00 means
    24:00.
  - "Copy to…", with the shortcuts "weekdays" and "whole week".
- **Saving.** Validate, then call the ops. Show HA's error text when a call fails.
- **Deleting.** Confirm first, then list the kept hand-written automations.

### 5 · `beit-shabbat-card`
- **Calendar block** from `findCalendar`: the Hebrew date, the holiday or parasha, candle lighting and havdalah.
- **A card section per mode.**
  - A master switch reflecting `modeState`.
  - The member automations with switches.
  - The member schedules with their next time.
  - "Choose automations": a checklist that writes labels. Adding an automation also labels the schedules it
    references (collect them from its config with `schedule\.[a-z0-9_]+`).
- **Automatic Shabbat mode.** One switch.
  - It detects an existing auto automation and never creates a second one.
  - It creates one per the contract, and removes only one that carries the marker.
- **The chag section** has no automatic switch in v1. Instead show a hint that Jewish Calendar makes one possible
  later.

### 6 · Visual config editors, polish
- A `getConfigElement()` editor for each card, like ha-kcm-radio's.
- Mobile layout, dark and light themes, keyboard focus, `aria-label`s.

### 7 · Verification
1. `node --test 'tests/*.test.mjs'` is green.
2. `python3 dev/serve.py` serves `dev/card-preview.html`.
   - **Offline mode** uses the fake `hass` built from the synthetic fixtures. Look at both cards in the Browser pane on
     a desktop and a mobile viewport, in RTL and LTR, and fix what looks wrong.
   - **Live mode** (`?live=1`) connects to a real HA using `dev.env.json` (git-ignored). The page opens HA's WebSocket
     directly. REST calls go through `serve.py`, which proxies `/api/*` and adds the token server-side (the browser
     cannot call HA's REST API cross-origin).
   - Live mode is **read-only** unless the page is opened with `&writes=1`.
3. **One real write round trip in live mode:**
   1. Create a probe schedule named `zz beit probe` whose hours cannot come up during the test.
   2. Check that its automation appears and is `on`.
   3. Delete it.
   4. Check that nothing is left behind.
   - **Never** toggle real devices, edit existing schedules or automations, or switch modes on a real house while
     testing.

### 8 · Release and install
1. Update `README.md` if behaviour changed, and add a real screenshot (`docs/card.png`) taken from the preview with
   the synthetic data.
2. Commit, push `main`, tag `v1.0.0`, and create a GitHub release with `dist/beit-schedule-card.js` attached.
3. Check that the `Validate` workflow passes on GitHub. Fix it and re-release if not.
4. Install on the owner's Home Assistant through HACS's WebSocket API:
   - add the custom repository (`hacs/repositories/add`, category `plugin`);
   - download it;
   - confirm that the Lovelace resource is registered (`lovelace/resources`).
5. Create a **new** dashboard "Beit" (`lovelace/dashboards/create`, then `lovelace/config/save`) with both cards.
   **Do not modify existing dashboards.**
6. Report what was verified and what was not.

## Out of scope for v1

- Drag-to-draw on a grid.
- Arbitrary service calls and conditions.
- Automatic chag mode.
- Editing YAML schedules.
- Submitting to the HACS default list. That is a PR to `hacs/default`; ask the owner first.
