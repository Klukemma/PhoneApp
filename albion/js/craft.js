// The Craft tab: a profit and loss for one production run, whatever it is.
//
// The farming tab answers "what should I grow"; this one answers the other
// half of the question — "if I buy the materials and make this, what do I
// walk away with". It is the same screen for a stack of potions, a set of
// plate boots and a pile of steel bars, because the game costs all three the
// same way: materials in, focus and a station fee out, and a market or a
// Black Market at the end of it.

import { craftPnL, cityBonus, cityFor, focusEfficiency, specFor } from './calc.js';
import {
  DATA, GEAR, bmPriceOf, costOf, loadEquipment, priceOf, state, setSettings,
} from './store.js';
import { esc } from './ui.js';
import {
  enchantOf, pct, short, silver, tierText, toneOf,
} from './util.js';

/* ------------------------------------------------------------- state --- */

/* What the tab is looking at. Kept here rather than in the saved state
 * because it is a question you are asking right now, not a plan you are
 * keeping — except the few bits that are worth remembering, which go to
 * settings. */
let gearState = 'idle';          // idle | loading | ready | error
let gearError = '';
let rerender = () => {};

export const setCraftRerender = (fn) => { rerender = fn; };

const q = () => state.settings.craftQuery || {};
const setQ = (patch) => setSettings({ craftQuery: { ...q(), ...patch } });

export const craftTarget = () => q().recipeId || '';
export function setCraftTarget(id) {
  // A new target invalidates which intermediates you said you would make:
  // "refine my own bars" means nothing once you are brewing a potion.
  setQ({ recipeId: id, make: [] });
}
export const setCraftQty = (n) => setQ({ qty: Math.max(1, Math.round(Number(n) || 1)) });
export const setCraftSellTo = (where) => setQ({ sellTo: where });

export function toggleMake(itemId) {
  const make = new Set(q().make || []);
  if (make.has(itemId)) make.delete(itemId); else make.add(itemId);
  setQ({ make: [...make] });
}

/* ---------------------------------------------------------- the data --- */

/** Every recipe the app knows, from whichever file has it. */
export function allRecipes() {
  const farm = DATA?.recipes || [];
  const gear = GEAR?.recipes || [];
  return farm.concat(gear);
}

export const recipeOf = (id) => allRecipes().find((r) => r.id === id) || null;

export const nameOf = (id) =>
  DATA?.items[id]?.name || GEAR?.items[id]?.name || id;
export const tierOf = (id) => {
  const meta = DATA?.items[id] || GEAR?.items[id];
  if (meta) return meta.tier ?? 0;
  const m = /^T(\d)/.exec(id || '');
  return m ? Number(m[1]) : 0;
};

/**
 * Which list a recipe belongs under.
 *
 * The farming file keys on the crafting category and the equipment file
 * carries a group, so this is the one place the two vocabularies meet.
 */
export function groupOf(r) {
  if (r.group) return r.group;
  if (r.category === 'food') return 'food';
  if ((r.category || '').startsWith('meat_')) return 'butcher';
  return 'potion';
}

export const GROUPS = [
  ['potion', 'Potions', '\u{1F9EA}'],
  ['food', 'Food', '\u{1F35E}'],
  ['butcher', 'Butchering', '\u{1F969}'],
  ['refined', 'Refining', '\u{1F9F1}'],
  ['weapon', 'Weapons', '\u{2694}\u{FE0F}'],
  ['armor', 'Armour', '\u{1F6E1}\u{FE0F}'],
  ['gear', 'Bags, capes and tools', '\u{1F392}'],
];
const GROUP_NAME = Object.fromEntries(GROUPS.map(([k, label]) => [k, label]));
const GROUP_ICON = Object.fromEntries(GROUPS.map(([k, , icon]) => [k, icon]));
export const groupLabel = (k) => GROUP_NAME[k] || k;
export const groupIcon = (k) => GROUP_ICON[k] || '\u{1F4E6}';

/** Kick off the equipment download. Cheap and idempotent once it is here. */
export function ensureGear() {
  if (gearState === 'ready' || gearState === 'loading') return;
  gearState = 'loading';
  loadEquipment().then(() => { gearState = 'ready'; rerender(); },
    (err) => { gearState = 'error'; gearError = err.message; rerender(); });
}

export const gearReady = () => gearState === 'ready';
export const gearStatus = () => gearState;

/* --------------------------------------------------------- the maths --- */

/**
 * The Black Market takes equipment and nothing else \u2014 "Sell Equipment, it
 * becomes part of Albion's loot". A potion, a meal or a stack of bars cannot
 * go there at any price, so asking it for one gets you a zero, which reads as
 * worthless rather than as inadmissible.
 */
export const sellsToBlackMarket = (recipe) =>
  ['weapon', 'armor', 'gear'].includes(groupOf(recipe || {}));

/** Where this run is sold, and for how much a piece. */
function sellSide(recipe) {
  const asked = q().sellTo === 'black' ? 'black' : 'market';
  const allowed = asked !== 'black' || sellsToBlackMarket(recipe);
  const where = allowed ? asked : 'market';
  return {
    where,
    asked,
    // True when you asked for the Black Market and this is not something it
    // will take, so the screen can say so instead of quoting nothing.
    refused: !allowed,
    instant: where === 'black',
    priceOf: where === 'black' ? bmPriceOf : priceOf,
    label: where === 'black' ? 'Black Market' : `${cityFor(state.settings)?.name || 'the market'}`,
  };
}

/** The run the screen is describing, or null when nothing is picked. */
export function currentRun() {
  const id = craftTarget();
  if (!id) return null;
  const recipe = recipeOf(id);
  if (!recipe) return null;
  const sell = sellSide(recipe);
  const run = craftPnL(id, {
    recipeOf,
    qty: q().qty || 100,
    make: new Set(q().make || []),
    priceOf,
    costOf,
    sellPriceOf: sell.priceOf,
    sellInstant: sell.instant,
    settings: state.settings,
    cityId: state.settings.craftCity,
  });
  return run ? { ...run, sell } : null;
}

/**
 * Every input in the run that COULD be made instead of bought, so the screen
 * can offer the choice. Walks the same tree craftPnL does.
 */
export function makeable(recipe, make, depth = 0, out = [], seen = new Set()) {
  if (!recipe || depth > 5) return out;
  for (const i of recipe.inputs) {
    if (seen.has(i.id)) continue;
    const sub = recipeOf(i.id);
    if (!sub) continue;
    const chosen = make.has(i.id);
    if (!out.some((x) => x.id === i.id)) out.push({ id: i.id, recipe: sub, depth, chosen });
    // Only offer what is below something you are already making: you cannot
    // refine your own ore into bars you are not making.
    if (chosen) makeable(sub, make, depth + 1, out, new Set(seen).add(i.id));
  }
  return out;
}

/* Silver per focus is usually single digits, and rounding 8.99 to "9" hides
 * the difference between two recipes that is the whole reason to look. */
const perFocus = (n) => (Math.abs(n) < 100 ? (Number(n) || 0).toFixed(2) : short(n));

/* ------------------------------------------------------------- view ---- */

export function craft() {
  const id = craftTarget();
  const recipe = id ? recipeOf(id) : null;
  const run = currentRun();
  const qty = q().qty || 100;
  const sell = sellSide(recipe);

  return {
    title: 'Craft',
    sub: recipe
      ? `${qty.toLocaleString()} × ${recipe.name} · ${sell.label}`
      : 'What is it worth making?',
    html: `
      <section>
        <button class="goal-line" data-act="craft-pick">
          <span class="k">Make</span>
          <span class="v">${recipe
            ? `${tierText(recipe.tier, recipe.enchant)} ${esc(recipe.name)}`
            : 'pick anything craftable'}</span>
          <span class="amt">›</span>
        </button>
        <div class="two">
          <div class="field"><label>How many</label>
            <input type="number" id="craftQty" inputmode="numeric" min="1" max="999999"
              value="${qty}" data-craft-qty></div>
          <div class="field"><label>Sell it</label>
            <div class="seg">
              <button data-craft-sell="market" aria-pressed="${sell.where === 'market'}"
                >On the market</button>
              <button data-craft-sell="black" aria-pressed="${sell.where === 'black'}"
                ${recipe && !sellsToBlackMarket(recipe) ? 'disabled' : ''}
                >Black Market</button>
            </div></div>
        </div>
        <button class="btn primary" data-act="craft-prices" style="margin-top:4px">
          ↓ Fetch prices for this run</button>
        <div class="hint centered">${esc(state.settings.priceCity)} on
          ${esc(state.settings.server)}${recipe && sellsToBlackMarket(recipe)
            ? ', plus the Black Market' : ''}.
          <button class="linkish" data-act="price-source">change</button></div>
        ${sell.refused ? `<div class="hint">The Black Market only takes
          equipment \u2014 weapons, armour, bags, capes and tools \u2014 so this is
          priced on the open market instead.</div>` : ''}
        ${sell.where === 'black' ? `<div class="hint">The Black Market only buys
          equipment, it never sells, and you are accepting an order that is
          already standing rather than listing one — so there is no setup fee,
          only the ${(state.settings.marketTransactionTax / (state.settings.premium ? 2 : 1)).toFixed(1)}%
          tax. It pays more than the market often enough to be worth the walk
          to Caerleon.</div>` : ''}
      </section>
      ${recipe ? runHTML(run, recipe) : pickPrompt()}
      ${gearBanner()}`,
  };
}

const pickPrompt = () => `
  <div class="empty"><span class="e">⚖️</span>
    Pick a thing and say how many. You get the shopping list, the focus it
    takes at your real mastery, the station's cut, and what is left over.</div>`;

function gearBanner() {
  if (gearState === 'loading') {
    return `<div class="hint centered">Fetching the weapon and armour list…</div>`;
  }
  if (gearState === 'error') {
    return `<div class="warn-note">Could not load the weapon and armour list:
      ${esc(gearError)}. Potions, food and butchering still work.</div>`;
  }
  return '';
}

function runHTML(run, recipe) {
  if (!run) return '';
  const gaps = run.missing;
  return `
    ${gaps.length ? `
      <section>
        <div class="warn-note">${gaps.length === 1 ? 'One thing has' : `${gaps.length} things have`}
          no price, so ${gaps.length === 1 ? 'it reads' : 'they read'} as free coming in and
          worthless going out. The number below is not real until
          ${gaps.length === 1 ? 'it is' : 'they are'} filled in.</div>
        ${gaps.map((g) => `
          <button class="row warn" data-price="${esc(g)}">
            <span class="ico">❓</span>
            <span class="body"><span class="title">${tierText(tierOf(g), enchantOf(g))} ${esc(nameOf(g))}</span>
              <span class="meta">tap to put a price on it</span></span>
            <span class="amt">?</span>
          </button>`).join('')}
      </section>` : ''}

    <section class="hero">
      <div class="label">Profit on ${short(run.qty)} ${esc(recipe.name)}</div>
      <div class="amount ${toneOf(run.profit)}">${short(run.profit)}</div>
      <div class="hero-foot">
        ${silver(run.perItem)} each · ${pct(run.margin)} margin
        ${run.silverPerFocus != null
          ? `<br>${perFocus(run.silverPerFocus)} per focus · ${short(run.focus)} focus in all`
          : '<br>no focus spent'}
      </div>
    </section>

    ${moneyHTML(run)}
    ${makeHTML(run, recipe)}
    ${buysHTML(run)}
    ${stepsHTML(run)}
    ${whereHTML(run, recipe)}`;
}

function moneyHTML(run) {
  const line = (label, value, tone) => `
    <div class="bar-row"><span class="n">${esc(label)}</span>
      <span class="v num ${tone || ''}">${value}</span></div>`;
  return `
    <section>
      <div class="section-head"><h2>The money</h2></div>
      <div class="card">
        ${line(`${short(run.qty)} sold at ${silver(run.unitPrice)}`, short(run.gross), 'good')}
        ${line(run.sellInstant
          ? `Tax (${pct(run.tax)}, no setup fee)`
          : `Market tax (${pct(run.tax)})`, short(-run.taxPaid), 'bad')}
        ${line('Materials bought', short(-run.buyCost), 'bad')}
        ${run.fees > 0.5 ? line('Station fees', short(-run.fees), 'bad') : ''}
        <div class="bar-row total"><span class="n">Profit</span>
          <span class="v num ${toneOf(run.profit)}">${short(run.profit)}</span></div>
      </div>
    </section>`;
}

function makeHTML(run, recipe) {
  const make = new Set(q().make || []);
  const opts = makeable(recipe, make);
  if (!opts.length) return '';
  return `
    <section>
      <div class="section-head"><h2>Buy it or make it</h2></div>
      <p class="muted small">Every one of these you make yourself is one you do
        not buy — cheaper in silver, dearer in focus. Tap to switch.</p>
      ${opts.map((o) => `
        <button class="row" data-make="${esc(o.id)}"
          ${o.chosen ? 'style="border-color:var(--gold)"' : ''}>
          <span class="ico">${o.chosen ? '\u{1F528}' : '\u{1F6D2}'}</span>
          <span class="body">
            <span class="title">${' '.repeat(o.depth * 2)}${tierText(tierOf(o.id), enchantOf(o.id))} ${esc(nameOf(o.id))}</span>
            <span class="meta">${o.chosen
              ? `made from ${o.recipe.inputs.map((i) => esc(nameOf(i.id))).join(' + ')}`
              : `bought at ${costOf(o.id) ? silver(costOf(o.id)) : 'no price yet'}`}</span>
          </span>
          <span class="amt">${o.chosen ? 'make' : 'buy'}</span>
        </button>`).join('')}
    </section>`;
}

function buysHTML(run) {
  if (!run.buys.length) return '';
  return `
    <section>
      <div class="section-head"><h2>Buy · your shopping list</h2>
        <span class="right num bad">${short(-run.buyCost)}</span></div>
      ${run.buys.map((b) => `
        <button class="row ${b.unit ? '' : 'warn'}" data-price="${esc(b.id)}">
          <span class="ico">\u{1F6D2}</span>
          <span class="body">
            <span class="title">${short(b.qty)} × ${esc(nameOf(b.id))}</span>
            <span class="meta">${b.unit
              ? `${silver(b.unit)} each`
              : 'no price set, so this is costing you nothing on paper'}</span>
          </span>
          <span class="amt num ${b.unit ? 'bad' : 'flat'}">${b.unit ? short(-b.cost) : '?'}</span>
        </button>`).join('')}
    </section>`;
}

function stepsHTML(run) {
  return `
    <section>
      <div class="section-head"><h2>Craft · in this order</h2>
        <span class="right">${short(run.focus)} focus</span></div>
      ${run.steps.map((s) => {
        const eff = specFor(state.settings, s.recipe.id);
        const bonus = cityBonus(cityFor(state.settings, state.settings.craftCity),
          s.recipe.category, state.settings);
        /* Every step is costed in the one city you picked, because that is
         * where you are standing. Refining is specialised somewhere other
         * than weaponsmithing, so when a step would do better elsewhere the
         * row says where rather than quietly costing it at the flat base. */
        const better = !bonus.specialises
          ? (state.settings.cities || [])
            .find((c) => cityBonus(c, s.recipe.category, state.settings).specialises)
          : null;
        return `
        <div class="row">
          <span class="ico">${groupIcon(groupOf(s.recipe))}</span>
          <span class="body">
            <span class="title">${short(s.crafts)} ${s.crafts === 1 ? 'craft' : 'crafts'}
              → ${short(s.made)} ${tierText(s.recipe.tier, s.recipe.enchant)} ${esc(s.recipe.name)}</span>
            <span class="meta">${pct(s.batch.rrr)} of materials come back${
              bonus.specialises ? ` · this city's specialty` : ''}${
              s.focus > 0 ? ` · ${short(s.focus)} focus at ${Math.round(eff)} mastery` : ''}${
              s.fee > 0.5 ? ` · ${short(s.fee)} in fees` : ''}${
              better ? ` · better in ${esc(better.name)}` : ''}</span>
          </span>
          <span class="amt">${s.target ? '✓' : ''}</span>
        </div>`;
      }).join('')}
    </section>`;
}

/**
 * Where to stand. The return rate is the single biggest lever on a craft and
 * it is decided by which building you walk into, so the screen says which one
 * rather than leaving you to remember the table.
 */
function whereHTML(run, recipe) {
  const s = state.settings;
  const rows = (s.cities || [])
    .map((c) => ({ c, b: cityBonus(c, recipe.category, s) }))
    .filter((x) => x.b.specialises)
    .sort((a, b) => b.b.total - a.b.total);
  if (!rows.length) return '';
  const here = s.craftCity;
  return `
    <section>
      <div class="section-head"><h2>Where to make it</h2></div>
      ${rows.map(({ c, b }) => `
        <button class="row" data-craft-city="${esc(c.id)}"
          ${c.id === here ? 'style="border-color:var(--gold)"' : ''}>
          <span class="ico">\u{1F3EF}</span>
          <span class="body"><span class="title">${esc(c.name)}</span>
            <span class="meta">+${b.base} base and +${b.specialty} specialty${
              s.useFocus ? `, +${s.focusCraftBonus} focus` : ''} — ${
              pct(1 - 100 / (100 + b.total + (s.useFocus ? s.focusCraftBonus : 0)))
            } comes back</span></span>
          <span class="amt">${c.id === here ? '✓' : '›'}</span>
        </button>`).join('')}
      <div class="hint">${rows.length === 1 ? 'Only this city specialises in it'
        : 'These cities specialise in it'}; anywhere else is the flat
        +${(s.cities || [])[0]?.craftBase ?? 18} base, and your own island is
        worse again. The difference on ${short(run.buyCost)} of materials is
        real money.</div>
    </section>`;
}

/* ------------------------------------------------------------- rank ---- */

/* Which slice of the six thousand to price and rank. You cannot fetch them
 * all — that is 67 batches of market prices and another 67 of Black Market
 * ones — so the scan is one group at one tier, which is 20 to 200 rows and
 * comes back in a couple of seconds. */
export const scan = () => state.settings.craftScan
  || { group: 'weapon', tier: 4, enchant: 0 };
export const setScan = (patch) =>
  setSettings({ craftScan: { ...scan(), ...patch } });

/** Every recipe in the slice the Best tab is looking at. */
export function scanRecipes() {
  const { group, tier, enchant } = scan();
  return allRecipes().filter((r) => groupOf(r) === group
    && r.tier === tier && (r.enchant || 0) === enchant);
}

/**
 * Rank a slice on what one craft of it earns.
 *
 * Every row buys all its materials, because that is the comparison that makes
 * sense across a list: how deep you would refine is a decision per item, and
 * folding it in here would rank the items you happen to have thought about
 * above the ones you have not. Each row is a link into the Craft tab, where
 * the refining choice lives.
 */
export function rankCraft() {
  const rows = [];
  for (const recipe of scanRecipes()) {
    const market = craftPnL(recipe.id, {
      recipeOf, qty: 1, priceOf, costOf, settings: state.settings,
      cityId: state.settings.craftCity,
    });
    if (!market) continue;
    const black = sellsToBlackMarket(recipe) && bmPriceOf(recipe.id)
      ? craftPnL(recipe.id, {
        recipeOf, qty: 1, priceOf, costOf, sellPriceOf: bmPriceOf,
        sellInstant: true, settings: state.settings,
        cityId: state.settings.craftCity,
      })
      : null;
    // Whichever side of the market pays more for the same work.
    const best = black && black.profit > market.profit ? black : market;
    rows.push({
      recipe, market, black, best,
      where: best === black ? 'black' : 'market',
      // A row missing a price is not a zero, it is an unknown, and mixing the
      // two into one sorted list is how a plan built on nothing looks good.
      ready: best.missing.length === 0,
      missing: best.missing,
    });
  }
  rows.sort((a, b) => {
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    return b.best.profit - a.best.profit;
  });
  return rows;
}

export function craftRankHTML() {
  const { group, tier, enchant } = scan();
  const rows = rankCraft();
  const ready = rows.filter((r) => r.ready);
  const top = Math.max(...ready.map((r) => Math.abs(r.best.profit)), 1);

  const row = (r) => {
    const w = (Math.abs(r.best.profit) / top) * 100;
    const perFocusTxt = r.best.silverPerFocus != null
      ? `${perFocus(r.best.silverPerFocus)}/focus` : 'no focus';
    return `
      <button class="row rank" data-craft-rank="${esc(r.recipe.id)}">
        <span class="ico">${groupIcon(groupOf(r.recipe))}</span>
        <span class="body">
          <span class="title">${tierText(r.recipe.tier, r.recipe.enchant)} ${esc(r.recipe.name)}</span>
          <span class="meta">${r.ready
            ? `${perFocusTxt} · ${short(r.best.buyCost)} of materials${
              r.where === 'black' ? ' · best at the Black Market' : ''}${
              r.black && r.where !== 'black'
                ? ` · Black Market ${short(r.black.profit)}` : ''}`
            : `needs a price for ${esc(r.missing.map(nameOf).slice(0, 2).join(', '))}${
              r.missing.length > 2 ? ` and ${r.missing.length - 2} more` : ''}`}</span>
          ${r.ready ? `<span class="bar"><i class="${toneOf(r.best.profit)}"
            style="width:${w.toFixed(1)}%"></i></span>` : ''}
        </span>
        <span class="amt num ${r.ready ? toneOf(r.best.profit) : 'flat'}">${
          r.ready ? short(r.best.profit) : '—'}</span>
      </button>`;
  };

  return `
    <div class="card toggle-card">
      ${GROUPS.map(([k, label]) => `
        <button class="mini" data-scan-group="${esc(k)}"
          aria-pressed="${k === group}">${esc(label)}</button>`).join('')}
    </div>
    <div class="card toggle-card" style="margin-top:8px">
      ${[1, 2, 3, 4, 5, 6, 7, 8].map((t) => `
        <button class="mini" data-scan-tier="${t}" aria-pressed="${t === tier}">T${t}</button>`).join('')}
      ${[0, 1, 2, 3, 4].map((e) => `
        <button class="mini" data-scan-enchant="${e}"
          aria-pressed="${e === enchant}">${e ? `.${e}` : 'plain'}</button>`).join('')}
    </div>
    <button class="btn primary" data-act="scan-prices" style="margin-top:10px">
      ↓ Fetch prices for these ${rows.length}</button>
    <div class="hint centered">Profit on one craft, materials all bought, in
      ${esc(cityFor(state.settings)?.name || 'your crafting city')}. Whichever of
      the market and the Black Market pays more is the one shown. Tap a row to
      open it properly.</div>
    ${rows.length ? rows.map(row).join('') : `
      <div class="empty"><span class="e">\u{1F50D}</span>${
        gearReady() ? 'Nothing at that tier.' : 'Still loading the list…'}</div>`}
    ${ready.length === 0 && rows.length ? `
      <div class="warn-note">None of these have prices yet. Fetch them above —
        it is one request per hundred items, so this slice is quick.</div>` : ''}`;
}

/** The ids this slice needs priced, for the fetch button. */
export function scanIds() {
  const ids = new Set();
  for (const r of scanRecipes()) {
    ids.add(r.id);
    for (const i of r.inputs) ids.add(i.id);
  }
  return [...ids];
}

/** Of those, the ones the Black Market will actually quote. */
export const scanBlackIds = () =>
  scanRecipes().filter(sellsToBlackMarket).map((r) => r.id);
