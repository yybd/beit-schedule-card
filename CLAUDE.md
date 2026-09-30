# Beit Schedule Card

A Home Assistant dashboard plugin (HACS, category *Dashboard*): `dist/beit-schedule-card.js` registers
`beit-schedule-card` and `beit-shabbat-card`. The plan is [PLAN.md](PLAN.md). The data model shared with the Beit app is
[docs/contract.md](docs/contract.md). Read both before changing anything.

## Rules

- **This repo is public.** Never commit data from a real house: entity names, areas, automations, IPs, URLs, tokens.
  - Test fixtures are synthetic.
  - `dev.env.json` (HA url + token for live preview) is git-ignored and stays that way.
- **Testing against a real Home Assistant:** read-only by default.
  - The only allowed write is the probe round trip in PLAN.md §7: a `zz beit probe` schedule whose hours cannot come
    up during the test, created and then deleted.
  - Never toggle devices, never edit or delete existing schedules, automations or labels, and never switch modes.
- **The contract is shared with the Beit app.** Changing a shape (the marker, the automation JSON, label names) means
  changing the app too. Don't do it from here alone.
- **Commits.** One logical change per commit, message in this repo's terms.

## Commands

```bash
node --test 'tests/*.test.mjs'          # unit + fake-hass tests
node dev/ui-test.mjs                    # the cards in headless Chrome, clicked through (starts dev/serve.py)
node dev/screenshots.mjs                # the README screenshots, in English, from the offline preview
python3 dev/serve.py        # preview at http://localhost:8766 (offline fake hass; ?live=1 for a real HA)
```
