// Everything about you, in one place.
//
// This used to be a gear icon over a sheet with twenty-odd controls in it,
// plus four more sheets you could only reach from inside that one. The
// machine behind it is complicated; the front of it should be a short list of
// things you actually know about yourself, in the order they matter, and
// nothing should be somewhere you have to remember.

import {
  cityFor, farmCityFor, focusPerDayOf, mixFor, qualityPoints,
} from './calc.js';
import { landSummary, plotsOwned, state } from './store.js';
import { serverName } from './prices.js';
import { esc } from './ui.js';
import { pct, short } from './util.js';

/* A row that opens a sheet. The whole screen is made of these, because every
 * one of them is a question with a real answer rather than a field. */
const row = (act, icon, title, meta, value = '›') => `
  <button class="row" data-act="${esc(act)}">
    <span class="ico">${icon}</span>
    <span class="body"><span class="title">${title}</span>
      <span class="meta">${meta}</span></span>
    <span class="amt">${value}</span>
  </button>`;

const toggle = (key, title, desc) => {
  const on = !!state.settings[key];
  return `
    <div class="toggle">
      <div class="body"><div class="t">${esc(title)}</div>
        <div class="d">${esc(desc)}</div></div>
      <button class="switch" data-toggle="${key}" aria-pressed="${on}"></button>
    </div>`;
};

/** How much of your setup is actually filled in, as a nudge rather than a nag. */
export function setupGaps() {
  const s = state.settings;
  const gaps = [];
  /* plotsOwned() falls back to the bare number on the goal, which starts at
   * nine, so "do you have land" has to ask the land list itself. */
  if (!state.farm.length) gaps.push({ act: 'land', what: 'what land you have' });
  if (!Object.keys(state.nodeLevels || {}).length) {
    gaps.push({ act: 'board', what: 'your destiny board' });
  }
  if (!Object.keys(state.prices || {}).length) {
    gaps.push({ act: 'prices', what: 'some prices' });
  }
  return gaps;
}

export function me() {
  const s = state.settings;
  const land = landSummary();
  const nodes = Object.keys(state.nodeLevels || {}).length;
  const sample = 'T4_MAIN_SWORD';
  const { mix, source, points } = mixFor(sample, s);
  const NAMED = [
    ['farm', 'Farm', 'Farms'], ['herbgarden', 'Herb Garden', 'Herb Gardens'],
    ['pasture', 'Pasture', 'Pastures'], ['kennel', 'Kennel', 'Kennels'],
  ];
  const landBits = NAMED
    .filter(([k]) => land[k] > 0)
    .map(([k, one, many]) => `${land[k]} ${land[k] === 1 ? one : many}`);

  return {
    title: 'Me',
    sub: `${s.premium ? 'Premium' : 'No premium'} · ${
      nodes || 'no'} board ${nodes === 1 ? 'node' : 'nodes'} · ${
      state.farm.length ? `${plotsOwned()} ${plotsOwned() === 1 ? 'plot' : 'plots'}`
        : 'no land set'}`,
    html: `
      <section>
        <div class="section-head"><h2>Your account</h2></div>
        <div class="card">
          ${toggle('premium', 'Premium',
            'Double crop yield, double animal growth, and the focus a day.')}
          ${toggle('useFocus', 'Craft with focus',
            `+${s.focusCraftBonus}% return rate, and better quality.`)}
        </div>
        ${s.premium ? '' : `
          <div class="field" style="margin-top:10px">
            <label>Focus you regenerate a day</label>
            <input type="number" data-num="focusPerDayNoPremium" inputmode="numeric"
              min="0" value="${s.focusPerDayNoPremium || 0}">
            <div class="hint">The game publishes the ${short(s.focusPerDay)} a day
              as a Premium benefit and says nothing about what a free account
              gets, so put in what your own screen shows — until you do, the
              plans assume none.</div>
          </div>`}
      </section>

      <section>
        <div class="section-head"><h2>Where you play</h2></div>
        ${row('farm-city', '\u{1F33E}', `Farm in ${esc(farmCityFor(s)?.name || 'a city')}`,
          "+10% on that city's crops, herbs and produce")}
        ${row('craft-city', '\u{1F3EF}', `Craft in ${esc(cityFor(s)?.name || 'a city')}`,
          'Its specialty is worth +15% return, or +40% on refining')}
        ${row('land', '\u{1F5FA}\u{FE0F}', landBits.length ? esc(landBits.join(' · ')) : 'No land yet',
          landBits.length
            ? `Across ${land.cities.size} ${land.cities.size === 1 ? 'city' : 'cities'}`
            : 'Say what you own and the plans stop guessing')}
      </section>

      <section>
        <div class="section-head"><h2>What you are good at</h2></div>
        ${row('board', '\u{1F31F}', 'Destiny board',
          nodes ? `${nodes} ${nodes === 1 ? 'node' : 'nodes'} set · drives focus cost and quality`
            : 'Not set — every focus cost is quoted at zero mastery')}
        ${row('quality', '✨', 'Quality of what you make',
          source === 'yours'
            ? `Yours: ${pct(mix[1], 0)} plain, ${pct(1 - mix[1], 0)} better`
            : `Worked out: ${pct(mix[1], 0)} plain, ${pct(1 - mix[1], 0)} better`)}
        ${row('mastery', '\u{1F4DA}', 'Per-recipe overrides',
          `${Object.keys(state.spec || {}).length || 'None'} set · only if you would
            rather type the number than use the board`)}
      </section>

      <section>
        <div class="section-head"><h2>How you play</h2></div>
        ${row('cycle', '\u{1F504}', `${s.cycleDays}-day cycle`,
          `${s.farmDays} farming, ${s.cycleDays - s.farmDays} idle, then craft`)}
        <div class="two" style="margin:8px 0">
          <div class="field"><label>What you can carry</label>
            <input type="number" data-num="carryWeight" inputmode="numeric" min="0"
              step="50" value="${s.carryWeight || ''}" placeholder="0">
            <div class="hint">Kilos a trip, mount and bags included.</div></div>
          <div class="field"><label>What a kilo costs to move</label>
            <input type="number" data-num="haulSilverPerWeight" inputmode="decimal"
              min="0" step="1" value="${s.haulSilverPerWeight || ''}" placeholder="0">
            <div class="hint">Silver. Zero if you ride it yourself.</div></div>
        </div>
        <div class="hint" style="margin:-4px 0 10px">Weight is the game's
          number and it is already in here. What you can carry and what a ride
          is worth to you are published nowhere, so they are yours — left at
          zero the plans still tell you the load, they just do not put a price
          on it.</div>
        ${row('price-source', '\u{1F4E1}', `Prices from ${esc(s.priceCity)}`,
          `On ${esc(serverName(s.server))} · tap to change server or city`)}
        <div class="card" style="margin-top:8px">
          ${toggle('watered', 'Water and nurture with focus',
            'More seed back from a plant, more offspring from an animal.')}
          ${toggle('favouriteFood', 'Feed animals their favourite',
            'Worth double nutrition, where an animal has one.')}
          ${toggle('sellSurplus', 'Sell leftover ingredients',
            'Off means they are kept on the pile for the next batch.')}
          ${toggle('ownInputsAtCost', 'Value my own produce at what it cost me',
            'Rather than at what it would have sold for.')}
          ${toggle('hideMounts', 'Hide mounts',
            'Only show livestock and plants in the farming lists.')}
        </div>
      </section>

      <section>
        <div class="section-head"><h2>Rarely</h2></div>
        ${row('advanced', '\u{1F527}', 'Station fees and game numbers',
          'The posted rate per city, and the constants from the game files')}
        ${row('data', '\u{1F4BE}', 'Backup and restore',
          'Everything here is on this phone only')}
      </section>

      <div class="hint centered" style="margin:14px 0 4px">
        Quality points on a T4 sword right now: ${Math.round(points)}.
      </div>`,
  };
}
