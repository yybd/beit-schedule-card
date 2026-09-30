<h1 align="center">Beit Schedule Card</h1>

<p align="center">
  Weekly schedules for any device, with <b>Shabbat and chag modes</b>, on your Home Assistant dashboard.<br>
  Built entirely on Home Assistant's own <b>schedule helper</b> and ordinary automations. No custom integration, no extra
  engine running on your server.
</p>

<p align="center">
  <a href="https://github.com/hacs/integration"><img src="https://img.shields.io/badge/HACS-Custom-41BDF5.svg" alt="HACS"></a>
  <a href="https://github.com/yybd/beit-schedule-card/releases"><img src="https://img.shields.io/github/v/release/yybd/beit-schedule-card" alt="Release"></a>
  <a href="https://github.com/yybd/beit-schedule-card/actions/workflows/validate.yml"><img src="https://github.com/yybd/beit-schedule-card/actions/workflows/validate.yml/badge.svg" alt="Validate"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/yybd/beit-schedule-card" alt="License"></a>
</p>

<p align="center"><img src="https://raw.githubusercontent.com/yybd/beit-schedule-card/main/docs/card.png" alt="The schedules card and the Shabbat and chag card" width="760"></p>

---

## Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Why Beit Schedule Card](#why-beit-schedule-card)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Shabbat and chag modes](#shabbat-and-chag-modes)
- [How it works](#how-it-works)
- [Permissions](#permissions)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Schedule a device in one step.** Choose a device (air conditioner, light, water heater, plug, blinds), what it should
  do while the schedule is active (HVAC mode, temperature, brightness), and the hours for each day of the week. The card
  creates the schedule helper and the automation that drives the device.
- **Edit every schedule in the house.** A clear week view for each UI-managed schedule helper. You can add ranges, copy a
  day to the other weekdays or to the whole week, and set ranges that run until midnight.
- **Shabbat and chag modes.** A single switch turns on or off every automation that belongs to a mode, and the card
  shows whether the mode is fully on, partly on or off.
- **Automatic Shabbat mode.** Switches on before Friday's schedules begin and off after Shabbat ends. It turns off only
  once every Shabbat schedule has finished, so no device is left running.
- **Jewish calendar on the card.** Candle lighting, havdalah, the parasha and today's holiday, from the core
  [Jewish Calendar](https://www.home-assistant.io/integrations/jewish_calendar/) integration (or Hebcal, if installed).
- **Hebrew first.** Full right-to-left layout and a week that starts on Sunday. English is also supported.

## Screenshots

All screenshots use the invented house in `tests/fixtures`, in English. The cards are Hebrew-first: in Hebrew, the whole layout is right to left.

| Editing a schedule | A new schedule for an air conditioner |
|:-:|:-:|
| <img src="https://raw.githubusercontent.com/yybd/beit-schedule-card/main/docs/editor.png" alt="The editor: name, Shabbat mode, the automations it drives and the week" width="380"> | <img src="https://raw.githubusercontent.com/yybd/beit-schedule-card/main/docs/new-schedule.png" alt="A new schedule: the device, HVAC mode, temperature and turn off at the end" width="380"> |

| Dark theme, fixed height | On a phone |
|:-:|:-:|
| <img src="https://raw.githubusercontent.com/yybd/beit-schedule-card/main/docs/dark-english.png" alt="Both cards with a dark theme and a fixed height" width="440"> | <img src="https://raw.githubusercontent.com/yybd/beit-schedule-card/main/docs/mobile.png" alt="The editor full screen on a phone" width="220"> |

## Why Beit Schedule Card

Home Assistant already has good scheduling tools. This card makes a different trade-off. **It writes Home Assistant's
own objects rather than bringing its own scheduling engine.**

| | **Beit Schedule Card** | Built-in schedule helper editor | [Scheduler card + component](https://github.com/nielsfaber/scheduler-component) | [Weekly Schedule Card](https://community.home-assistant.io/t/weekly-schedule-card-a-visual-weekly-grid-card-for-the-scheduler-component/1012671) | [schedule_state](https://github.com/aneeshd/schedule_state) |
|---|:-:|:-:|:-:|:-:|:-:|
| Stores schedules in HA's native `schedule` helper | ✅ | ✅ | ❌ own storage | ❌ scheduler component | ❌ own sensor |
| Needs a custom integration on the server | **No** | No | Yes | Yes | Yes |
| Schedule and device configured together | ✅ | ❌ automation written by hand | ✅ | ✅ | ❌ |
| Device driven by a standard, editable HA automation | ✅ | ✅ (your own) | ❌ internal engine | ❌ internal engine | ✅ (your own) |
| Keeps working if the card is removed | ✅ | ✅ | ❌ | ❌ | ❌ |
| Shabbat / chag modes | ✅ | ❌ | ❌ | ❌ | ❌ |
| Restart-safe automations | ✅ | Depends on you | ✅ | ✅ | Depends on you |
| Deletes only what it created | ✅ | — | — | — | — |
| Hebrew / right-to-left | ✅ | Partial | Partial | ❌ | ❌ |

**What this means in practice**

1. **Nothing server-side to break.** The card is a single dashboard file. There is no integration to update or to fail
   after a Home Assistant upgrade.
2. **No lock-in.** Everything the card creates is a regular schedule helper and a regular automation. You can see and
   edit them under *Settings → Automations & Scenes* and *Settings → Helpers*, and they keep working without the card.
3. **Built for Shabbat and chag.** Modes are Home Assistant labels, so a mode's automations are visible and filterable
   everywhere in Home Assistant. Automatic Shabbat mode is timed around real schedules, not only candle lighting.
4. **Careful by design.**
   - Automations ignore the brief "unavailable" state after a restart, so devices don't switch on or off on their own.
   - Deleting a schedule removes only the automation the card created. Automations you wrote yourself are left in
     place and listed.
5. **One data model across apps.** The card and the Beit native app for iOS, Android, macOS and Windows read and
   write the same objects.

**Where other tools go further.** The Scheduler card supports arbitrary service calls, conditions and sun-based times.
The Weekly Schedule Card and the built-in editor let you draw ranges by dragging on a grid. Beit Schedule Card focuses
on device schedules and Shabbat/chag modes.

## Requirements

- Home Assistant **2025.1** or newer.
- An **administrator** account to create or edit schedules. Other users see a read-only view (see
  [Permissions](#permissions)).
- For Shabbat and chag times, the core **Jewish Calendar** integration (recommended) or Hebcal. Optional: the modes
  work without it.

## Installation

### HACS (recommended)

[![Open your Home Assistant instance and open this repository in HACS.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=yybd&repository=beit-schedule-card&category=plugin)

Or add it by hand:

1. In Home Assistant, open **HACS**.
2. Open the menu (⋮) → **Custom repositories**.
3. Add `https://github.com/yybd/beit-schedule-card` with type **Dashboard**.
4. Search for **Beit Schedule Card**, open it and select **Download**.
5. Reload the browser.

HACS registers the dashboard resource for you.

### Manual

1. Download `beit-schedule-card.js` from the [latest release](https://github.com/yybd/beit-schedule-card/releases/latest).
2. Copy it to `/config/www/beit-schedule-card.js`.
3. Go to *Settings → Dashboards → ⋮ → Resources → Add resource*.
4. Enter the URL `/local/beit-schedule-card.js` with type **JavaScript module**.
5. Reload the browser.

## Configuration

The package contains two cards. Both can be added from the dashboard's **Add card** dialog and configured in the
visual editor.

### Schedules card

```yaml
type: custom:beit-schedule-card
title: תזמונים            # optional
height: 500px              # optional: fixed height, the list scrolls
mode: שבת                  # optional: show only schedules in this mode (שבת / חג)
entities:                  # optional: show only these schedules
  - schedule.living_room_ac
```

| Option | Type | Default | Description |
|---|---|---|---|
| `title` | string | `תזמונים` | Card title. |
| `mode` | string | — | Show only the schedules in this mode. |
| `entities` | list | all | Show only these schedule helpers. |
| `hide_entities` | list | — | Hide these schedule helpers. |
| `show_add` | boolean | `true` | Show the **New schedule** button. |
| `height` | string | auto | A fixed height, such as `500px` or `60vh`. The title stays put and the list scrolls inside the card. |
| `show_modes` | boolean | `true` | Show Shabbat and chag: the mode chips and the mode choice in the editor. Turn it off if you have no use for them. |

### Shabbat and chag card

```yaml
type: custom:beit-shabbat-card
modes: [שבת, חג]           # optional
show_calendar: true        # optional
```

| Option | Type | Default | Description |
|---|---|---|---|
| `title` | string | `שבת וחג` | Card title. |
| `modes` | list | `[שבת, חג]` | Which modes to show. |
| `height` | string | auto | A fixed height, such as `500px` or `60vh`. The title stays put and the rest scrolls inside the card. |
| `show_calendar` | boolean | `true` | Show candle lighting, havdalah, the parasha and the holiday. |

## Shabbat and chag modes

A mode is a Home Assistant **label**, named `שבת` or `חג`.

- **Membership.** An automation belongs to a mode when it carries the label. The schedules it follows carry the label
  too, so they appear under the mode.
- **Changing membership.** Use **Choose automations** on the card. Membership is stored in Home Assistant, so every
  device, and the Home Assistant UI itself, sees the same list.
- **The mode switch.** It turns every member automation on or off together. The per-automation switches below it stay
  available.
- **Automatic Shabbat mode** (optional, one switch on the card). Creates one automation that:
  1. turns the Shabbat mode on every **Friday at 12:00**, before typical Friday-afternoon schedules begin;
  2. turns it off **after Shabbat ends**, but only once every Shabbat schedule has finished.

## How it works

For every schedule it creates, the card writes two standard Home Assistant objects:

1. **A schedule helper** (`schedule.*`) holding the weekly hours.
2. **An automation** (`Beit · <name>`) that performs the "on" action when the schedule turns on and the "off" action
   when it turns off.
   - It ignores transitions from `unavailable`/`unknown`, so a restart never switches a device.
   - Its description marks it as created by Beit. That is how the card knows which automations it may later edit or
     delete.

The full data model is documented in [docs/contract.md](docs/contract.md).

## Permissions

Home Assistant allows only administrators to create or change helpers, automations and labels. For non-admin users,
the card shows schedules and modes read-only. Switching a mode on or off uses ordinary service calls and works for
every user.

## FAQ

**Can I edit a schedule the card created in Home Assistant's own editor?**
Yes. Both the helper and the automation are standard objects. If you rewrite the automation by hand, the card treats
it as yours and will not delete it.

**What happens to my existing schedules and automations?**
The card lists your existing UI-managed schedule helpers and lets you edit their hours. It never modifies or deletes
automations it did not create. Schedules defined in YAML are shown read-only, since Home Assistant does not allow them
to be edited through its API.

**Does it work in the Home Assistant Companion app?**
Yes. It is a regular dashboard card, so it works wherever your dashboards do.

## Contributing

Issues and pull requests are welcome.

- Run the tests with `node --test 'tests/*.test.mjs'`.
- Preview the card without Home Assistant with `python3 dev/serve.py`, then open http://localhost:8766. The preview
  runs on a fake Home Assistant over the synthetic data in `tests/fixtures`. To look at your own Home Assistant, put
  `{"url": "...", "token": "..."}` in `dev.env.json` (git-ignored) and add `?live=1`. Live mode is read-only unless you
  also add `&writes=1`.

## License

[MIT](LICENSE)
