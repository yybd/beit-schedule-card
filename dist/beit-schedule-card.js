/*
 * Beit Schedule Card — weekly schedules for any device, with Shabbat and chag modes.
 *
 *   type: custom:beit-schedule-card
 *   type: custom:beit-shabbat-card
 *
 * Pure logic sits at the top and is exported, so `node --test` can import this file.
 * Custom elements are registered only where `customElements` exists.
 */

export const VERSION = '0.0.0';

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
