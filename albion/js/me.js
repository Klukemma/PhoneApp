// Everything about you, in one place.
//
// This used to be a gear icon over a sheet with twenty-odd controls in it,
// plus four more sheets you could only reach from inside that one. The
// machine behind it is complicated; the front of it should be a short list of
// things you actually know about yourself, in the order they matter, and
// nothing should be somewhere you have to remember.

import { cityFor, farmCityFor, mixFor } from './calc.js';
import {
  DATA, landSummary, plotsOwned, scheduleDays, state,
} from './store.js';
import { serverName } from './prices.js';
import { esc } from './ui.js';
import { pct } from './util.js';

/* A row that opens a sheet. The whole screen is made of these, because every
 * one of them is a question with a real answer rather than a field. */
export const row = (act, icon, title, meta, value = '\u203A') => `
  <button class="row" data-act="${esc(act)}">
    <span class="ico">${icon}</span>
    <span class="body"><span class="title">${title}</span>
      <span class="meta">${meta}</span></span>
    <span class="go">${value}</span>
  </button>`;

const cycleWords = () => {
  const days = scheduleDays();
  const n = (m) => days.filter((d) => d === m).length;
  return [[n('farm'), 'farming'], [n('rest'), 'resting'], [n('craft'), 'crafting']]
    .filter(([c]) => c > 0).map(([c, w]) => `${c} ${w}`).join(', ') + ' · tap to set the days';
};

const bagTitle = () => {
  const n = Object.keys(state.stock || {}).length;
  return n ? `${n} ${n === 1 ? 'thing' : 'things'} in the bag` : 'Nothing in the bag';
};

export const toggle = (key, title, desc) => {
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
  const { mix, source } = mixFor(sample, s);
  const NAMED = [
    ['farm', 'Farm', 'Farms'], ['herbgarden', 'Herb Garden', 'Herb Gardens'],
    ['pasture', 'Pasture', 'Pastures'], ['kennel', 'Kennel', 'Kennels'],
  ];
  const landBits = NAMED
    .filter(([k]) => land[k] > 0)
    .map(([k, one, many]) => `${land[k]} ${land[k] === 1 ? one : many}`);
  const cityName = (id) => (s.cities || []).find((c) => c.id === id)?.name || id;
  const landWhere = land.cities.size === 1 ? cityName([...land.cities][0])
    : `${land.cities.size} cities`;
  const priced = Object.keys(state.prices || {}).filter((id) => state.prices[id]).length;

  return {
    title: 'Me',
    html: `
      <section>
        <div class="section-head"><h2>You</h2></div>
        <div class="card tight">
          ${toggle('premium', 'Premium', 'Double yield, double growth, the focus a day.')}
          ${toggle('useFocus', 'Craft with focus', `+${s.focusCraftBonus}% return rate, and better quality.`)}
        </div>
        ${s.premium ? '' : `
          <div class="field" style="margin-top:10px">
            <label>Focus you regenerate a day</label>
            <input type="number" data-num="focusPerDayNoPremium" inputmode="numeric"
              min="0" value="${s.focusPerDayNoPremium || 0}">
            <div class="hint">What your own screen shows; until set, plans assume none.</div>
          </div>`}
      </section>

      <section>
        <div class="section-head"><h2>Your farm</h2></div>
        ${row('land', '\u{1F5FA}\u{FE0F}', landBits.length ? esc(landBits.join(' · ')) : 'No land yet',
    landBits.length ? `${esc(landWhere)} · tap to change` : 'Say what you own and the plans stop guessing')}
        ${row('farm-city', '\u{1F33E}', `Farm in ${esc(farmCityFor(s)?.name || 'a city')}`,
    "+10% on its crops, herbs and produce")}
        ${row('craft-city', '\u{1F3EF}', s.craftWhere === 'best' ? 'Craft in the best city per step'
    : `Craft in ${esc(cityFor(s)?.name || 'a city')}`,
  s.craftWhere === 'best' ? 'Ride between them' : 'Every job, unless a job says otherwise')}
        ${row('cycle', '\u{1F504}', `${scheduleDays().length}-day cycle`, cycleWords())}
        ${row('stock', '\u{1F392}', bagTitle(), 'Seeds, calves and potions you already hold')}
      </section>

      <section>
        <div class="section-head"><h2>Your skill</h2></div>
        ${row('board', '\u{1F31F}', 'Destiny board',
    nodes ? `${nodes} ${nodes === 1 ? 'node' : 'nodes'} set · drives focus cost and quality`
      : 'Not set — every focus cost is at zero mastery')}
        ${row('quality', '✨', 'Quality of what you make',
    source === 'yours'
      ? `Yours: ${pct(mix[1], 0)} plain, ${pct(1 - mix[1], 0)} better`
      : `Worked out: ${pct(mix[1], 0)} plain, ${pct(1 - mix[1], 0)} better`)}
        ${row('mastery', '\u{1F4DA}', 'Per-recipe overrides',
    `${Object.keys(state.spec || {}).length || 'None'} set`)}
      </section>

      <section>
        <div class="section-head"><h2>Prices</h2></div>
        ${row('price-source', '\u{1F4E1}', `Prices from ${esc(s.priceCity)}`,
    `${esc(serverName(s.server))} · ${priced} set`)}
      </section>

      <section>
        <div class="section-head"><h2>Hauling</h2></div>
        <div class="card">
          <div class="two">
            <div class="field" style="margin:0"><label>What you can carry</label>
              <input type="number" data-num="carryWeight" inputmode="numeric" min="0"
                step="50" value="${s.carryWeight || ''}" placeholder="0">
              <div class="hint">Kilos a trip, mount and bags included.</div></div>
            <div class="field" style="margin:0"><label>What a kilo costs to move</label>
              <input type="number" data-num="haulSilverPerWeight" inputmode="decimal"
                min="0" step="1" value="${s.haulSilverPerWeight || ''}" placeholder="0">
              <div class="hint">Silver. Zero if you ride it yourself.</div></div>
          </div>
        </div>
      </section>

      <section>
        <div class="section-head"><h2>How you play</h2></div>
        <div class="card tight">
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
    'Posted rates per city, constants from the game files')}
        ${row('data', '\u{1F4BE}', 'Backup and restore',
    `Game data ${esc(DATA?.generated || '')} · stored on this phone only`)}
      </section>`,
  };
}
