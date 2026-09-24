// The Craft tab: a profit and loss for one production run, whatever it is.
//
// The farming tab answers "what should I grow"; this one answers the other
// half of the question — "if I buy the materials and make this, what do I
// walk away with". It is the same screen for a stack of potions, a set of
// plate boots and a pile of steel bars, because the game costs all three the
// same way: materials in, focus and a station fee out, and a market or a
// Black Market at the end of it.

import {
  bestCityFor, cityBonus, cityFor, craftPnL, focusEfficiency, mixFor,
  outputOf, QUALITY_LEVELS, specFor,
} from './calc.js';
import {
  DATA, GEAR, bmPriceOf, costOf, loadEquipment, priceOf, qBmPriceOf, qPriceOf,
  state, setSettings,
} from './store.js';
import { esc } from './ui.js';
import {
  ICON, amt, askLine, askStrip, go, heroHTML, moreHTML, note, rowHTML, slimRow, tag, tick,
} from './html.js';
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

/* Craft follows the farm goal until you pick something here. So the tab
 * opens on the potion you are planning with no taps, and picking a sword on
 * it never touches the farm plan. */
export const craftTarget = () => q().recipeId || state.goal.recipeId || '';

/**
 * When the goal changes while Craft is following it, the make/buy choices
 * belong to the old potion. Nothing is written to craftQuery.recipeId here:
 * the fallback stays a fallback.
 */
export function resetMakeIfFollowing() {
  if (!q().recipeId && (q().make || []).length) setQ({ make: [] });
}
export function setCraftTarget(id) {
  // A new target invalidates which intermediates you said you would make:
  // "refine my own bars" means nothing once you are brewing a potion.
  setQ({ recipeId: id, make: [] });
}
export const setCraftQty = (n) => setQ({ qty: Math.min(999999, Math.max(1, Math.round(Number(n) || 1))) });
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
  ['mount', 'Mounts', '\u{1F40E}'],
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

/**
 * What comes off the bench in five grades. Equipment does, and so does a
 * saddled mount \u2014 items.xml gives 26 of the 27 farm mounts maxqualitylevel=5
 * \u2014 but the Black Market takes no mounts (loot.xml has none), so this is a
 * different question from the one above.
 */
export const hasQuality = (recipe) =>
  ['weapon', 'armor', 'gear', 'mount'].includes(groupOf(recipe || {}));

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
    // Quality is a different price per level, on both sides of the market.
    priceAt: where === 'black' ? qBmPriceOf : qPriceOf,
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
  /* Only equipment has quality. A potion, a meal and a stack of bars come off
   * the bench at one grade, so asking for a mix there would spread a run
   * across four prices that do not exist. */
  const graded = hasQuality(recipe);
  const quality = graded ? mixFor(id, state.settings, recipe.maxQuality ?? 5) : null;
  const run = craftPnL(id, {
    recipeOf,
    qty: q().qty || 100,
    make: new Set(q().make || []),
    priceOf,
    costOf,
    sellPriceOf: sell.priceOf,
    sellPriceAt: graded ? sell.priceAt : null,
    sellMix: quality?.mix || null,
    sellInstant: sell.instant,
    settings: state.settings,
    cityId: state.settings.craftCity,
    /* Refining is specialised in a different city from smithing, so a sword
     * made of your own bars is genuinely two cities. Either you accept that
     * and ride between them, or you do the lot in one place and pay for it in
     * materials. The switch is the whole multi-city question in one tap. */
    // No city specialises in saddlery, so a mount step stays where you are
    // rather than being sent to whichever tied city happens to sort first.
    cityOf: state.settings.craftWhere === 'best'
      ? (r) => (r.category === 'mount'
        ? state.settings.craftCity : bestCityFor(r.category, state.settings).id)
      : null,
  });
  return run ? { ...run, sell, quality } : null;
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
  const s = state.settings;
  const city = cityFor(s);
  const bonus = recipe && city ? cityBonus(city, recipe.category, s) : null;
  const farmable = recipe && (DATA?.recipes || []).some((r) => r.id === recipe.id);

  const make = askLine({
    act: 'craft-pick', k: 'Make', state: recipe ? 'set' : 'unset',
    v: recipe ? `${tierText(recipe.tier, recipe.enchant)} ${esc(recipe.name)}` : 'Pick anything craftable',
  });
  const howMany = recipe ? askLine({
    k: 'How many', tagName: 'label', state: q().qty ? 'set' : 'default',
    inner: `<input type="number" inputmode="numeric" min="1" max="999999" value="${qty}" data-craft-qty>`,
  }) + (run && run.qty !== run.asked ? `<div class="hint">Comes ${run.perBatch} at a time, so ${
    run.crafts} ${run.crafts === 1 ? 'batch' : 'batches'} → ${run.qty}.</div>` : '') : '';
  const sellLine = recipe ? askLine({
    k: 'Sell', tagName: 'div', state: q().sellTo ? 'set' : 'default',
    inner: `<div class="seg small">
      <button data-craft-sell="market" aria-pressed="${sell.where === 'market'}">Market</button>
      <button data-craft-sell="black" aria-pressed="${sell.where === 'black'}"
        ${sellsToBlackMarket(recipe) ? '' : 'disabled'}>Black Market</button>
    </div>`,
  }) + (sellsToBlackMarket(recipe) ? '' : '<div class="hint">Black Market: equipment only</div>') : '';
  const where = recipe ? askLine({
    act: 'craft-city', k: 'In', state: s.craftCityPicked ? 'set' : 'default',
    v: s.craftWhere === 'best' ? 'Best city per step'
      : `${esc(city?.name || 'Pick a city')}${bonus?.specialises
        ? ` · ${recipe.category === 'food' ? 'food' : recipe.category === 'potion' ? 'potions' : esc(recipe.category)} +${bonus.specialty}%`
        : bonus ? ` · +${bonus.base} base` : ''}`,
  }) : '';
  const seg = farmable ? `
    <div class="seg two-up">
      <button data-act="grow-instead">Grow the materials</button>
      <button aria-pressed="true">Buy the materials</button>
    </div>` : '';

  return {
    title: 'Craft',
    action: recipe ? { label: '↓ Prices', act: 'craft-prices' } : null,
    html: `
      ${askStrip(make + howMany + sellLine + where, seg, '')}
      ${recipe ? runHTML(run, recipe) : note('Pick anything the game can craft: potions, food, bars, weapons, armour, mounts. Then say how many.', 'centered')}
      ${gearBanner()}`,
  };
}

function gearBanner() {
  if (gearState === 'loading') {
    return `<div class="hint centered">Fetching the weapon and armour list…</div>`;
  }
  if (gearState === 'error') {
    return `<div class="warn-note bad">Could not load the weapon and armour list:
      ${esc(gearError)}. Potions, food and butchering still work.</div>`;
  }
  return '';
}

function runHTML(run, recipe) {
  if (!run) return '';
  const s = state.settings;
  const gaps = run.missing;
  const board = Object.keys(state.nodeLevels || {}).length;
  const nudges = [
    gaps.length ? slimRow({
      act: 'craft-prices', icon: ICON.warn, cls: 'warn',
      title: `${gaps.length} ${gaps.length === 1 ? 'thing has' : 'things have'} no price · Fetch`,
    }) : '',
    ...gaps.map((g) => rowHTML({
      attrs: `data-price="${esc(g)}"`, icon: '❓', cls: 'warn',
      title: `${tierText(tierOf(g), enchantOf(g))} ${esc(nameOf(g))}`,
      meta: 'tap to put a price on it', right: tag('Set price'),
    })),
    !board && run.focus > 0 ? slimRow({
      act: 'board', icon: ICON.board, title: 'Focus costs assume zero mastery · Set your board',
    }) : '',
  ].filter(Boolean).join('');

  return `
    ${heroHTML({
    label: `Profit on ${short(run.qty)} ${esc(recipe.name)}`,
    amount: short(run.profit), tone: toneOf(run.profit),
    sub: `${silver(run.perItem)} each · ${pct(run.margin)} margin`,
    stats: [
      { v: run.silverPerFocus != null ? perFocus(run.silverPerFocus) : 'none', k: 'per focus' },
      { v: short(run.focus), k: 'focus in all' },
      { v: String(run.crafts), k: run.crafts === 1 ? 'batch' : 'batches' },
    ],
  })}
    ${run.sell.where === 'black' ? note(`Black Market: no setup fee, ${
    (s.marketTransactionTax / (s.premium ? 2 : 1)).toFixed(2)}% tax, sells instantly in Caerleon.`, 'centered')
    : run.sell.refused ? note('The Black Market only takes equipment, so this is priced on the open market.', 'centered') : ''}
    ${nudges ? `<section>${nudges}</section>` : ''}
    ${buysHTML(run, recipe)}
    ${stepsSection(run)}
    <section>
      ${moreHTML('craft', 'Details', run.quality ? 'the money · quality' : 'the money', `
        ${moneyHTML(run)}
        ${qualityTable(run)}`)}
    </section>`;
}

/** What one sale of this quality mix is worth, as one row that opens the editor. */
function qualityRow(run) {
  if (!run.quality) return '';
  const { mix, source } = run.quality;
  return rowHTML({
    act: 'quality', icon: ICON.quality,
    title: `Quality · ${pct(mix[1], 0)} plain, ${pct(1 - mix[1], 0)} better`,
    meta: `${run.qualityUplift > 0 ? `+${pct(run.qualityUplift)} on the sale` : 'no uplift'} · ${
      source === 'yours' ? 'your mix' : 'worked out from your board'}`,
    right: run.qualityUplift > 0 ? amt(`+${pct(run.qualityUplift)}`, { tone: 'good' }) : go(),
  });
}

/** The quality table, for the Details block. */
function qualityTable(run) {
  if (!run.quality) return '';
  const { mix, points } = run.quality;
  const names = state.settings.quality?.names || {};
  const priceAt = run.sell.priceAt;
  const rows = QUALITY_LEVELS.filter((q) => (mix[q] || 0) > 0.001);
  return `
    <div class="section-head"><h2>Quality</h2></div>
    <div class="card">
      ${rows.map((q) => {
    const at = priceAt(outputOf(run.recipe), q);
    return `
        <div class="bar-row">
          <span class="n">${esc(names[q] || `Quality ${q}`)} · ${pct(mix[q], 1)}</span>
          <span class="v num ${at ? '' : 'flat'}">${at ? silver(at) : q === 1 ? 'no price' : 'priced as plain'}</span></div>`;
  }).join('')}
      <div class="bar-row total"><span class="n">Average, per item</span>
        <span class="v num good">${silver(run.unitPrice)}</span></div>
      ${note(`${Math.round(points)} quality points from your board and your focus.${
    run.qualityGuessed.length ? ` No price yet for ${run.qualityGuessed.map((q) => esc(names[q] || q)).join(', ')}, so ${
      run.qualityGuessed.length === 1 ? 'it is' : 'they are'} counted at the plain price, which understates this.` : ''}`)}
    </div>`;
}

function moneyHTML(run) {
  const line = (label, value, tone) => `
    <div class="bar-row"><span class="n">${esc(label)}</span>
      <span class="v num ${tone || ''}">${value}</span></div>`;
  return `
    <div class="section-head"><h2>The money</h2></div>
    <div class="card">
      ${line(run.quality
    ? `${short(run.qty)} sold at ${silver(run.unitPrice)} average`
    : `${short(run.qty)} sold at ${silver(run.unitPrice)}`, short(run.gross), 'good')}
      ${line(run.sellInstant
    ? `Tax (${pct(run.tax)}, no setup fee)`
    : `Market tax (${pct(run.tax)})`, short(-run.taxPaid), 'bad')}
      ${line('Materials bought', short(-run.buyCost), 'bad')}
      ${run.fees > 0.5 ? line('Station fees', short(-run.fees), 'bad') : ''}
      <div class="bar-row total"><span class="n">Profit</span>
        <span class="v num ${toneOf(run.profit)}">${short(run.profit)}</span></div>
    </div>`;
}

/**
 * The shopping list, with the make-or-buy choice folded into it: an input
 * that could be made instead shows a tag, and tapping the tag flips it. The
 * row itself still opens the price.
 */
function buysHTML(run, recipe) {
  const make = new Set(q().make || []);
  const opts = makeable(recipe, make);
  // A span, not a button: a button inside a button is not HTML, and the
  // parser splits the row apart. The tap still lands on the tag first.
  const makeTag = (id, chosen) => `<span class="tag ${chosen ? 'on' : ''}" role="button" data-make="${esc(id)}">${
    chosen ? 'make' : 'buy'}</span>`;
  const rows = run.buys.map((b) => {
    /* What you carry to the station and what the run really costs are two
     * numbers. They only pull apart on a short run, where nothing has come
     * back yet to spend on the next batch. */
    const spare = b.qty - b.net;
    const opt = opts.find((o) => o.id === b.id);
    return rowHTML({
      attrs: `data-price="${esc(b.id)}"`, icon: ICON.cart, cls: b.unit ? '' : 'warn',
      title: `${short(b.qty)} × ${esc(nameOf(b.id))}`,
      meta: esc(`${b.unit ? `${silver(b.unit)} each` : 'no price set'} · ${short(b.perCraft)} a batch${
        spare > 0.05 ? ` · ${short(spare)} come back, really ${short(b.net)}` : ''}`),
      right: (opt ? makeTag(b.id, false) : '') + (b.unit ? amt(-b.cost) : tag('Set price')),
    });
  });
  // Things you chose to make: no longer bought, so they get a row of their own.
  const made = opts.filter((o) => o.chosen && !run.buys.some((b) => b.id === o.id)).map((o) => rowHTML({
    attrs: `data-price="${esc(o.id)}"`, icon: ICON.make, cls: o.depth > 0 ? 'nested' : '',
    title: `${tierText(tierOf(o.id), enchantOf(o.id))} ${esc(nameOf(o.id))}`,
    meta: `made from ${o.recipe.inputs.map((i) => esc(nameOf(i.id))).join(' + ')} → see Craft`,
    right: makeTag(o.id, true),
  }));
  if (!rows.length && !made.length) return '';
  return `
    <section>
      <div class="section-head"><h2>Buy · what to have on you</h2>
        <span class="right num ${run.buyCost > 0.5 ? 'bad' : 'flat'}">${run.buyCost > 0.5 ? short(-run.buyCost) : ''}</span></div>
      ${rows.join('')}${made.join('')}
    </section>`;
}

function stepsSection(run) {
  const s = state.settings;
  const cityName = (id) => (s.cities || []).find((c) => c.id === id)?.name || id;
  const steps = run.steps.map((st) => {
    const eff = specFor(s, outputOf(st.recipe));
    const bonus = cityBonus(cityFor(s, st.cityId), st.recipe.category, s);
    /* Where this step actually happens, which with "best city per step" is
     * not the same place for all of them. When it is somewhere that does
     * not specialise in it, the row names the city that does. */
    const here = (s.cities || []).find((c) => c.id === st.cityId);
    const better = !bonus.specialises
      ? (s.cities || []).find((c) => cityBonus(c, st.recipe.category, s).specialises) : null;
    return rowHTML({
      tagName: 'div', icon: groupIcon(groupOf(st.recipe)),
      title: `${short(st.crafts)} ${st.crafts === 1 ? 'craft' : 'crafts'} → ${short(st.made)} ${
        tierText(st.recipe.tier, st.recipe.enchant)} ${esc(st.recipe.name)}`,
      meta: esc([
        `${pct(st.batch.rrr)} of materials come back`,
        bonus.specialises ? "this city's specialty" : '',
        st.focus > 0 ? `${short(st.focus)} focus at ${Math.round(eff)} mastery` : '',
        st.fee > 0.5 ? `${short(st.fee)} in fees` : '',
        s.craftWhere === 'best' && here ? `in ${here.name}` : '',
        better ? `better in ${better.name}` : '',
      ].filter(Boolean).join(' · ')),
      right: st.target ? tick() : '',
    });
  });
  const legs = s.craftWhere === 'best' ? (run.legs || []) : [];
  const carry = legs.map((leg) => rowHTML({
    act: 'craft-city', icon: ICON.carry,
    title: `Carry ${short(leg.weight)} kg · ${esc(cityName(leg.from))} → ${esc(cityName(leg.to))}`,
    meta: leg.trips ? `${leg.trips} ${leg.trips === 1 ? 'trip' : 'trips'}${leg.cost > 0 ? ` · costs ${short(leg.cost)}` : ''}`
      : 'set what you carry on Me to count trips',
    right: go(),
  }));
  return `
    <section>
      <div class="section-head"><h2>Craft · in this order</h2>
        <span class="right num">${short(run.focus)} focus</span></div>
      ${steps.join('')}
      ${qualityRow(run)}
      ${carry.join('')}
    </section>`;
}

/* Which slice of the six thousand to price and rank. You cannot fetch them
 * all — that is 67 batches of market prices and another 67 of Black Market
 * ones — so the scan is one group at one tier, which is 20 to 200 rows and
 * comes back in a couple of seconds. */
export const scan = () => state.settings.craftScan
  || { group: 'weapon', tier: 4, enchant: 0 };
/** "Weapons · T4 · plain", for the filter line on the Best tab. */
export const scanLabel = () => `${groupLabel(scan().group)} · ${tierText(scan().tier, scan().enchant)}`;

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
    // Equipment comes off the bench at five different grades that sell for
    // five different prices, so a ranked list that priced it all as plain
    // would put the wrong things at the top.
    const graded = hasQuality(recipe);
    const quality = graded
      ? mixFor(recipe.id, state.settings, recipe.maxQuality ?? 5).mix : null;
    const market = craftPnL(recipe.id, {
      recipeOf, qty: 1, priceOf, costOf, settings: state.settings,
      sellPriceAt: graded ? qPriceOf : null, sellMix: quality,
      cityId: state.settings.craftCity,
    });
    if (!market) continue;
    const black = sellsToBlackMarket(recipe) && bmPriceOf(recipe.id)
      ? craftPnL(recipe.id, {
        recipeOf, qty: 1, priceOf, costOf, sellPriceOf: bmPriceOf,
        sellPriceAt: qBmPriceOf, sellMix: quality,
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
  const rows = rankCraft();
  const ready = rows.filter((r) => r.ready);
  const top = Math.max(...ready.map((r) => Math.abs(r.best.profit)), 1);

  const row = (r) => {
    const w = (Math.abs(r.best.profit) / top) * 100;
    const perFocusTxt = r.best.silverPerFocus != null
      ? `${perFocus(r.best.silverPerFocus)}/focus` : 'no focus';
    const meta = r.ready
      ? `${perFocusTxt} · ${short(r.best.buyCost)} of materials${
        r.best.qualityUplift > 0.005 ? ` · +${pct(r.best.qualityUplift, 0)} on quality` : ''}${
        r.black && r.where !== 'black' ? ` · Black Market ${short(r.black.profit)}` : ''}`
      : `needs a price for ${r.missing.map(nameOf).slice(0, 2).join(', ')}${
        r.missing.length > 2 ? ` and ${r.missing.length - 2} more` : ''}`;
    return `
      <button class="row rank" data-craft-rank="${esc(r.recipe.id)}">
        <span class="ico">${groupIcon(groupOf(r.recipe))}</span>
        <span class="body">
          <span class="title">${tierText(r.recipe.tier, r.recipe.enchant)} ${esc(r.recipe.name)}</span>
          <span class="meta">${esc(meta)}</span>
          ${r.ready ? `<span class="bar"><i class="${toneOf(r.best.profit)}" style="width:${w.toFixed(1)}%"></i></span>` : ''}
        </span>
        ${r.ready && r.where === 'black' ? tag('BM', true) : ''}
        ${r.ready ? amt(r.best.profit, { unit: '/craft' }) : amt('—', { tone: 'flat' })}
      </button>`;
  };

  const notReady = rows.filter((r) => !r.ready);
  return `
    ${slimRow({
    act: 'scan-filter', icon: groupIcon(scan().group),
    title: `${esc(scanLabel())} · ${rows.length} ${rows.length === 1 ? 'recipe' : 'recipes'}`,
  })}
    ${notReady.length ? `<button class="btn primary fetch" data-act="scan-prices">
      ↓ Fetch prices for these ${rows.length}</button>` : ''}
    ${ready.length ? ready.map(row).join('') : rows.length ? '' : `
      <div class="empty"><span class="e">\u{1F50D}</span>${
        gearReady() ? 'Nothing at that tier.' : 'Still loading the list…'}</div>`}
    ${notReady.length ? moreHTML('rank-needs', `${notReady.length} need prices`, '',
    notReady.map(row).join(''), !ready.length) : ''}
    ${note(`Profit on one craft, materials all bought, in ${esc(cityFor(state.settings)?.name || 'your crafting city')}. Whichever of market and Black Market pays more.`, 'centered')}`;
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
