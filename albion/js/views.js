// The four screens. Each returns { title, sub, html }.

import {
  animalCycle, cityBonus, cityFor, craftBatch, farmCityFor, feedFor,
  perPeriod, plantCycle, productCycle, rankFarmables, rankRecipes,
  returnRate, simulateCycle, taxRate,
} from './calc.js';
import {
  costOf, DATA, hasOwnCost, itemMeta, landSummary, plotsOwned, pricedItemIds,
  priceOf, scheduleDays, state,
} from './store.js';
import { serverName } from './prices.js';
import {
  craft, craftRankHTML, groupLabel, recipeOf, scan,
} from './craft.js';
import { gatherRun, kitOf, rawId } from './gather.js';
import { resourceExits } from './exits.js';
import { me } from './me.js';
import {
  ICON, addRow, amt, askLine, askStrip, craftIcon, go, heroHTML, iconFor, moreHTML,
  note, rowHTML, slimRow, tag,
} from './html.js';
import { esc } from './ui.js';
import { enchantOf, hours, pct, short, silver, tierText, toneOf } from './util.js';

export let rankTab = 'farm';
export const setRankTab = (t) => { rankTab = t; };
export let priceFilter = 'used';
export const setPriceFilter = (f) => { priceFilter = f; };

/**
 * The last thing the solver worked out, kept for the session so its reasoning
 * stays on screen. It is never the source of any figure — the plan it wrote is
 * simulated like any other, so editing a plot by hand changes the numbers and
 * the recommendation sits above them as what was suggested, not what is true.
 */
export let solution = null;
export const setSolution = (r) => { solution = r; };

/**
 * A fingerprint of everything a solved plan rests on.
 *
 * Levelling the destiny board is not a cosmetic change: cheaper focus buys a
 * far bigger batch, which changes how much of each thing to plant and how many
 * days of the cycle are worth farming at all. A plan worked out before that is
 * the answer to a different question, so the screen has to know when it is
 * showing a stale one.
 */
export function solveStamp() {
  const s = state.settings;
  return {
    mastery: JSON.stringify([state.nodeLevels, state.spec, s.specLevel]),
    prices: JSON.stringify([state.prices, state.buyPrices]),
    setup: JSON.stringify([s.premium, s.useFocus, s.favouriteFood, s.craftCity,
      s.farmCity, s.feedItemIds, s.cadenceHours, s.startFocus, s.stockCap,
      s.focusPerDay, s.focusCap, s.sellSurplus, s.hideMounts,
      s.watered, s.ownInputsAtCost, s.craftWhere,
      JSON.stringify(s.stationFee || {})]),
    goal: JSON.stringify([state.goal.recipeId, state.goal.plots, state.goal.cycleDays,
      // Your calendar is part of the question only while you ask it to be kept.
      state.goal.keepDays ? scheduleDays() : null]),
  };
}

const STAMP_LABEL = {
  mastery: 'your mastery', prices: 'prices',
  setup: 'your setup', goal: 'what you asked for',
};

/** What has moved since a plan was worked out, in words. */
export function changedSince(stamp) {
  if (!stamp) return [];
  const now = solveStamp();
  return Object.keys(STAMP_LABEL)
    .filter((k) => stamp[k] !== undefined && stamp[k] !== now[k])
    .map((k) => STAMP_LABEL[k]);
}

/**
 * Everything the calculator needs, assembled from the current state.
 *
 * `wateredFraction` is the share of the farm the plan can actually afford to
 * water. It matters here because an unwatered tile burns more seed, so what
 * your own crop cost you to grow depends on it.
 */
export function ctx(wateredFraction = 1) {
  return {
    priceOf,
    costOf,
    settings: state.settings,
    inputCostOf: state.settings.ownInputsAtCost
      ? ownCostOf(wateredFraction) : undefined,
    // What is already in the bag goes on the pile before anything is planted.
    stock: state.stock,
  };
}

/**
 * What a crop costs you to grow, for craft lines fed by your own farm.
 *
 * The same basis the ledger books, not a second rule: seeds at costOf, which
 * caps a market listing at the merchant's ask, and watered only as far as the
 * focus actually stretches. Reading it off a fully watered farm at the sell
 * price made your own herbs look cheaper than the cycle ever paid for them.
 */
export const ownCostOf = (wateredFraction = 1) => (id) => {
  const plant = DATA.plants.find((p) => p.cropId === id);
  if (!plant) return priceOf(id);
  return plantCycle(plant, {
    priceOf, costOf, settings: state.settings, wateredFraction,
  }).costPerUnit;
};

const nameOf = (id) => itemMeta(id)?.name || id;
const tierOf = (id) => itemMeta(id)?.tier ?? 0;
const label = (id) => `${tierText(tierOf(id), enchantOf(id))} ${nameOf(id)}`;

const empty = (emoji, text) =>
  `<div class="empty"><span class="e">${emoji}</span>${esc(text)}</div>`;

/**
 * Which prices a row depends on but does not have. An unpriced input reads as
 * free and an unpriced output reads as worthless, so a row missing either is
 * reported as incomplete rather than quietly shown as a number.
 */
export function missingFor(cycle) {
  const need = [];
  const want = (id) => { if (id && !priceOf(id)) need.push(id); };
  const ref = cycle.ref;
  if (cycle.kind === 'plant') { want(ref.seedId); want(ref.cropId); }
  else if (cycle.kind === 'animal') { want(ref.babyId); want(ref.grownId); want(cycle.feedId); }
  else if (cycle.kind === 'product') { want(ref.product.itemId); want(cycle.feedId); }
  else if (cycle.kind === 'craft') {
    want(ref.id);
    for (const i of ref.inputs) want(i.id);
  }
  return need;
}

/* ============================================================== PLAN ==== */

/** The last cycle the Plan screen drew, for sheets that compare against it. */
export let lastSim = null;

/** The fingerprint the plan on screen was worked out against. */
export function planStamp() {
  const goal = state.goal;
  // The fingerprint outlives the session; the reasoning behind the plan does
  // not. Either is enough to know the plan below is answering old numbers.
  return (solution?.ok && solution.target.id === goal.recipeId
    ? solution.stamp : null) || goal.stamp;
}

export function plan() {
  /* Two passes. What your own crops cost depends on how much of the farm gets
   * watered, and that is not known until the cycle has been run. The probe is
   * exact rather than an estimate: inputCostOf reaches only craftBatch's
   * material and margin figures, and the watering share depends on neither. */
  const probe = simulateCycle(state.plan, DATA, ctx(1));
  const c = ctx(probe.wateredFraction);
  const sim = simulateCycle(state.plan, DATA, c);
  lastSim = sim;
  /* A plan is only the answer while it is the answer to this question: pick
   * a different potion and the old plan is not stale, it is somebody else's. */
  const goalId = state.goal.recipeId;
  const belongs = !goalId || !state.plan.crafts.length
    || state.plan.crafts.some((c) => c.recipeId === goalId);
  const solved = (state.plan.plots.length || state.plan.crafts.length) && belongs;
  const moved = solved ? changedSince(planStamp()) : [];

  if (!solved) {
    return {
      title: 'Plan',
      html: `
        ${planStrip(sim, moved, false)}
        ${chainNudge()}
        ${note('Pick a potion and it works out what to plant, what to buy, how many days, and what you earn.', 'centered')}`,
    };
  }

  return {
    title: 'Plan',
    action: moved.length ? { label: 'Redo', act: 'solve', warn: true } : null,
    html: `
      ${planStrip(sim, moved, true)}
      ${planHero(sim, moved)}
      ${nudges(sim)}
      ${plantSection(sim)}
      ${buySection(sim)}
      ${craftSection(sim)}
      ${daysCard(sim)}
      <section>
        ${moreHTML('plan', 'Details', 'why · focus · ledger · leftovers', `
          ${whyCard(sim)}
          ${otherCycles()}
          ${focusCard(sim)}
          ${ledgerCard(sim)}
          ${stockCard(sim)}`)}
      </section>
      ${nextCycleRow(sim)}`,
  };
}

/* --------------------------------------------------------- ask strip --- */

/**
 * The four questions the whole plan hangs on, one line each: what to make,
 * on what land, on which days, crafted where. A hollow dot is the app's
 * default or an instruction; a gold one is something you chose.
 */
function planStrip(sim, moved, solved) {
  const goal = state.goal;
  const s = state.settings;
  const recipe = DATA.recipes.find((r) => r.id === goal.recipeId);
  const bare = !state.farm.length && goal.plots > 0;

  const make = askLine({
    act: 'goal', k: 'Make',
    state: recipe ? 'set' : 'unset',
    v: recipe ? `${tierText(recipe.tier, recipe.enchant)} ${esc(recipe.name)}` : 'Pick what to make',
  });
  const land = landLine();
  const on = askLine({
    act: 'land', k: 'On',
    state: state.farm.length ? 'set' : bare ? 'default' : 'unset',
    v: state.farm.length ? esc(land.v)
      : bare ? `${goal.plots} ${goal.plots === 1 ? 'plot' : 'plots'} $· say which buildings`
        : 'Say what land you own',
    meta: state.farm.length ? esc(land.meta) : '',
  });
  const days = scheduleDays().length;
  const every = askLine({
    act: 'cycle', k: 'Every',
    state: goal.keepDays || goal.cycleDays ? 'set' : 'default',
    v: goal.keepDays ? `${days} days · your calendar`
      : goal.cycleDays ? `${goal.cycleDays} days · pinned`
        : solved ? `${sim.cycleDays} days · picked for you` : 'Let it pick the days',
  });
  const city = cityFor(s);
  const bonus = recipe && city ? cityBonus(city, recipe.category, s) : null;
  const where = askLine({
    act: 'craft-city', k: 'In',
    state: s.craftCityPicked ? 'set' : 'default',
    v: s.craftWhere === 'best' ? 'Best city per step'
      : `${esc(city?.name || 'Pick a city')}${bonus?.specialises ? ` · ${recipeWord(recipe)} +${bonus.specialty}%` : bonus ? ` · +${bonus.base} base` : ''}`,
  });

  const seg = recipe && solved ? `
    <div class="seg two-up">
      <button aria-pressed="true">Grow the materials</button>
      <button data-act="buy-instead">Buy the materials</button>
    </div>` : '';
  const stale = moved.length;
  const button = solved
    ? `<button class="btn primary ${stale ? 'stale' : ''}" data-act="solve">${
      stale ? `Redo — ${esc(sentence(moved))} changed` : 'Work it out again'}</button>`
    : '<button class="btn primary" data-act="solve-first">Work it out</button>';
  return askStrip(make + on + every + where, seg, button);
}

/** "potions", "meals", "cuts": what one recipe category makes, in a word. */
function recipeWord(recipe) {
  const cat = recipe?.category || '';
  return cat === 'food' ? 'meals' : cat.startsWith('meat_') ? 'butchering' : 'potions';
}

/** A picked recipe with no prices behind it yet: offer the fetch, scoped. */
function chainNudge() {
  const id = state.goal.recipeId;
  if (!id) return '';
  const need = chainIdsOf(id).filter((x) => !priceOf(x));
  if (!need.length) return '';
  return `<section>${slimRow({
    act: 'fetch-chain', icon: ICON.warn, cls: 'warn',
    title: `${need.length} ${need.length === 1 ? 'thing' : 'things'} this needs ${
      need.length === 1 ? 'has' : 'have'} no price · Fetch`,
  })}</section>`;
}

/** The recipe, its inputs, and the farm items behind them. */
function chainIdsOf(recipeId) {
  const ids = new Set();
  const walk = (id) => {
    if (!id || ids.has(id)) return;
    ids.add(id);
    const r = DATA.recipes.find((x) => x.id === id);
    if (r) for (const i of r.inputs) walk(i.id);
    const p = DATA.plants.find((x) => x.cropId === id);
    if (p) ids.add(p.seedId);
    const a = DATA.animals.find((x) => x.grownId === id || x.product?.itemId === id);
    if (a) { ids.add(a.babyId); ids.add(feedFor(a, state.settings).id); }
  };
  walk(recipeId);
  return [...ids];
}

/**
 * The land line. Once you have described your farm it says what you actually
 * own, because "12 plots" and "6 Farms and 2 Pastures across two cities" lead
 * to very different plans and only one of them is a real farm.
 */
function landLine() {
  const sum = landSummary();
  const total = plotsOwned();
  const NAMED = [
    ['farm', 'Farm', 'Farms'], ['herbgarden', 'Herb Garden', 'Herb Gardens'],
    ['pasture', 'Pasture', 'Pastures'], ['kennel', 'Kennel', 'Kennels'],
  ];
  const bits = [];
  for (const [key, one, many] of NAMED) {
    if (sum[key] > 0) bits.push(`${sum[key]} ${sum[key] === 1 ? one : many}`);
  }
  // Land carried over from before the buildings were told apart counts as one
  // figure, not as two mysterious halves.
  if (sum.vague) bits.push(`${sum.vague} to sort`);
  if (!bits.length) return { v: `${total} ${total === 1 ? 'plot' : 'plots'}`, meta: '' };
  const cities = [...sum.cities];
  const where = cities.length === 1 ? cityName(cities[0]) : `${cities.length} cities`;
  return { v: bits.join(' · '), meta: where };
}

/** "your mastery and prices", rather than a bare comma-separated list. */
function sentence(list) {
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/* -------------------------------------------------------------- hero --- */

/** What one recipe category makes, for the hero's third stat. */
function madeWord(recipe) {
  const cat = recipe?.category || '';
  return cat === 'potion' ? 'potions' : cat === 'food' ? 'meals'
    : cat.startsWith('meat_') ? 'cuts' : 'made';
}

function planHero(sim, moved) {
  const recipe = DATA.recipes.find((r) => r.id === state.goal.recipeId);
  const terminal = sim.craftLines.filter((l) => l.terminal && l.crafts > 0);
  const target = terminal.find((l) => l.recipe.id === recipe?.id) || terminal[0];
  const made = target ? target.made : 0;

  let focus;
  let meter = null;
  let extra = '';
  if (sim.focusUsed > 0) {
    const idle = sim.focusLeft >= oneCraftOf(sim);
    focus = {
      v: short(sim.focusUsed), cls: idle ? 'bad' : '',
      k: idle ? `focus spent · ${short(sim.focusLeft)} left` : 'focus spent',
    };
    meter = { pct: sim.focusBudget > 0 ? sim.focusUsed / sim.focusBudget : 0 };
  } else if (sim.wateringPaid > 0) {
    focus = { v: short(sim.wateringPaid), k: 'focus on watering' };
    meter = { pct: sim.wateringPaid / Math.max(1, sim.focusBudget + sim.wateringPaid) };
    extra = ' · none on crafting';
  } else {
    focus = { v: 'none', k: 'focus used' };
    if (sim.focusWasted > 0) {
      extra = ` · <span class="warn">${short(sim.focusWasted)} regenerates unused</span>`;
    }
  }

  return heroHTML({
    label: moved.length ? 'Profit per cycle · old numbers' : 'Profit per cycle',
    amount: short(sim.profit),
    tone: toneOf(sim.profit),
    stale: moved.length > 0,
    sub: `${short(sim.perDay)} a day · ${short(sim.perMonth)} per 30 days${
      sim.openingValue > 0 ? ` · starts with ${short(sim.openingValue)} in the bag` : ''}${extra}`,
    stats: [
      focus,
      { v: `${sim.cycleDays} days`, k: 'cycle' },
      { v: made ? short(made) : '—', k: made ? madeWord(target?.recipe || recipe) : 'nothing made' },
    ],
    meter,
  });
}

/** The one or two things worth fixing before believing the number. */
function nudges(sim) {
  const rows = [];
  const unpriced = missingPrices();
  if (unpriced.length) {
    rows.push(slimRow({
      act: 'fetch-plan-prices', icon: ICON.warn, cls: 'warn',
      title: `${unpriced.length} ${unpriced.length === 1 ? 'item has' : 'items have'} no price · Fetch`,
    }));
  }
  if (!Object.keys(state.nodeLevels || {}).length && sim.focusUsed > 0) {
    rows.push(slimRow({
      act: 'board', icon: ICON.board,
      title: 'Focus costs assume zero mastery · Set your board',
    }));
  }
  return rows.length ? `<section>${rows.join('')}</section>` : '';
}

/* --------------------------------------------------------------- plant -- */

function plantSection(sim) {
  const head = `
    <div class="section-head"><h2>Plant${sim.farmLines.length ? ` · ${sim.farmingDays} ${
      sim.farmingDays === 1 ? 'harvest' : 'harvests'}` : ''}</h2>
      <span class="right num ${sim.farmCost > 0.5 ? 'bad' : sim.farmCost < -0.5 ? 'good' : 'flat'}">${
        Math.abs(sim.farmCost) > 0.5 ? short(-sim.farmCost) : ''}</span></div>`;
  const rows = sim.farmLines.map((l) => farmRow(l, sim)).join('');
  const emptyRow = rows ? '' : rowHTML({
    act: 'add-plot', icon: ICON.crop, cls: 'quiet',
    title: 'Nothing planted', meta: 'Add a plot, or pick a potion above and let it choose', right: go(),
  });
  return `<section>${head}${rows}${emptyRow}${landRows()}${addRow('Add a plot', 'add-plot')}</section>`;
}

/**
 * The land the solver looked at and did not plant: a building you lack, a
 * building standing empty, and the best thing the spare plots could earn.
 * Reconciled so two rows never describe the same land.
 */
function landRows() {
  const r = solution;
  if (!r?.ok || r.target.id !== state.goal.recipeId) return '';
  const LOOSE = { plant: ['farm', 'herbgarden'], animal: ['pasture', 'kennel'] };
  const spareBuilding = r.spare?.ref?.plot || null;
  const gapKinds = new Set((r.landGaps || []).map((g) => g.kind));
  const idle = (r.idleLand || []).filter((x) => x.kind !== 'any'
    && x.kind !== spareBuilding
    && !(LOOSE[x.kind] || []).includes(spareBuilding)
    && !gapKinds.has(x.kind));
  const out = [];
  for (const g of r.landGaps || []) {
    const kind = KIND_LABEL[g.kind] || g.kind;
    out.push(rowHTML({
      act: 'land', icon: ICON[g.kind] || ICON.land, cls: 'warn',
      title: `No ${esc(kind)} — ${esc(sentence(g.items.map(nameOf)))} will be bought`,
      meta: 'Build one and this plan changes', right: go(),
    }));
  }
  for (const x of idle) {
    const kind = KIND_LABEL[x.kind] || x.kind;
    out.push(rowHTML({
      act: 'add-plot', icon: ICON.empty,
      title: `${x.plots} ${esc(kind)}${x.plots === 1 ? '' : 's'} in ${esc(cityName(x.city))} · empty`,
      meta: 'Nothing this potion needs grows there', right: amt('—', { tone: 'flat' }),
    }));
  }
  /* The spare offer is only for land its crop can actually stand on, and it
   * goes into the city that has that land free. Once accepted it is a row of
   * its own, so the offer is not repeated under it. */
  const taken = state.plan.plots.some((p) => p.filler);
  if (r.spare && !taken) {
    const fits = (r.idleLand || []).filter((x) => x.kind === spareBuilding
      || (LOOSE[x.kind] || []).includes(spareBuilding) || x.kind === 'any');
    const room = fits.reduce((t, x) => t + x.plots, 0);
    const plots = room > 0 ? Math.min(r.spare.plots, room) : r.spare.plots;
    const city = fits.sort((a, b) => b.plots - a.plots)[0]?.city || '';
    if (plots > 0) {
      out.push(rowHTML({
        attrs: `data-add-spare="1" data-count="${plots}" data-city="${esc(city)}"`, icon: ICON.seed, cls: 'suggest',
        title: `${plots} spare ${plots === 1 ? 'plot' : 'plots'} → ${
          esc(r.spare.ref?.name || nameOf(r.spare.itemId))}`,
        meta: 'Not needed by the chain · the best they could earn',
        right: amt(r.spare.perDay * (plots / Math.max(1, r.spare.plots)), { tone: 'good', unit: '/day', sign: true }) + tag('Add'),
      }));
    }
  }
  return out.join('');
}

function farmRow(line, sim) {
  const { cycle, row, harvests, produced, itemId } = line;
  // Where a row is only matters when you farm in more than one place.
  const spread = new Set(sim.farmLines.map((l) => l.cycle.city?.id)).size > 1;
  const ref = cycle.ref;
  const icon = ICON[cycle.kind === 'product' ? 'product' : ref.kind] || ICON.seed;
  const what = cycle.kind === 'product'
    ? `${nameOf(ref.product.itemId)} from ${ref.name}` : ref.name;
  const meta = [
    cycle.farmBonusPct ? `${cycle.city.name} +${cycle.farmBonusPct}%` : spread ? cycle.city.name : '',
    `${short(produced)} ${nameOf(itemId)} over ${harvests} ${harvests === 1 ? 'harvest' : 'harvests'}`,
    fromBag(line),
    !line.rests && sim.restDays ? 'costs no focus to keep' : '',
  ].filter(Boolean).join(' · ');
  return rowHTML({
    attrs: `data-plot="${esc(row.id)}"`, icon,
    title: `${line.plots} ${line.plots === 1 ? 'plot' : 'plots'} · T${ref.tier} ${esc(what)}`,
    meta: esc(meta),
    right: Math.abs(line.cost) > 0.5
      ? amt(-line.cost, { unit: cycle.kind === 'plant' ? 'seeds' : 'feed' })
      : amt('—', { tone: 'flat' }),
  });
}

/** "120 Foxglove Seeds from your bag": what a row took off the pile, not the market. */
function fromBag(line) {
  const took = Object.entries(line.fromStock || {}).filter(([, q]) => q > 0.5);
  if (!took.length) return '';
  return took.map(([id, q]) => `${short(q)} ${nameOf(id)} from your bag`).join(', ');
}

/* ---------------------------------------------------------------- buy -- */

function buySection(sim) {
  const head = `
    <div class="section-head"><h2>Buy · shopping list</h2>
      <span class="right num ${sim.buyCost > 0.5 ? 'bad' : 'flat'}">${
        sim.buyCost > 0.5 ? short(-sim.buyCost) : ''}</span></div>`;
  const rows = sim.buys.map((b) => buyRow(b, sim)).join('');
  const skip = state.goal.recipeId ? rowHTML({
    act: 'buy-instead', icon: ICON.weapon, cls: 'link',
    title: 'Skip the farm — buy everything and just craft it', right: go(),
  }) : '';
  return `<section>${head}${bagRows(sim)}${rows}${skip}</section>`;
}

/**
 * What you walked in with. Seeds from the last round, calves that came back,
 * a stack of herbs, a crate of potions. Each is either used by the plan, sold
 * at the end, or still held, and the row says which, so it is obvious why the
 * shopping list under it got shorter.
 */
function bagRows(sim) {
  const rows = Object.entries(sim.stockIn || {});
  if (!rows.length) {
    return rowHTML({
      act: 'stock', icon: ICON.bag, cls: 'quiet',
      title: 'Nothing in the bag',
      meta: 'Seeds, calves or potions you already hold come off this list', right: go(),
    });
  }
  // The pile is drawn down as one heap, so what you brought counts as used
  // first: the plan reaches for the bag before it reaches for the market.
  const usedBy = sim.consumed || {};
  const sold = Object.fromEntries(sim.sales.map((x) => [x.id, x.qty]));
  const held = Object.fromEntries(sim.stock.map((x) => [x.id, x.qty]));
  return rows.map(([id, at]) => {
    const used = Math.min(at.qty, usedBy[id] || 0);
    const rest = at.qty - used;
    const fate = used >= at.qty - 0.5 ? 'all used by the plan'
      : used > 0.5 ? `${short(used)} used, ${short(rest)} ${
        sold[id] ? 'sold at the end' : held[id] ? 'still held' : 'left'}`
        : sold[id] ? 'nothing here uses it, so it is sold at the end'
          : held[id] ? 'not needed this cycle, still held' : 'not used';
    const basis = at.cost > 0.5 ? `cost you ${short(at.cost)}` : 'already paid for';
    return rowHTML({
      act: 'stock', icon: ICON.bag,
      title: `${short(at.qty)} × ${esc(nameOf(id))}`,
      meta: `${fate} · ${basis}`,
      right: amt(at.qty * priceOf(id) * (1 - taxRate(state.settings)), { tone: 'good', unit: 'in bag', sign: true }),
    });
  }).join('');
}

/** Which building the plan lacks for this item, if the solver said so. */
function landGapFor(itemId) {
  const r = solution;
  if (!r?.ok || r.target.id !== state.goal.recipeId) return null;
  return (r.landGaps || []).find((g) => g.items.includes(itemId)) || null;
}

function buyRow(b, sim) {
  /* What it actually costs you, not what it is listed at. costOf caps a
   * market listing at the merchant's ask, because you can always walk to
   * the shelf: a T6 seed is 15,000 there however far the market has run. */
  const unit = costOf(b.id);
  const capped = unit > 0 && priceOf(b.id) > unit;
  const held = sim.stockIn?.[b.id]?.qty || 0;
  const grown = sim.farmLines.some((l) => l.itemId === b.id);
  const gap = landGapFor(b.id);
  const why = !unit ? 'tap to put a price on it'
    : `${silver(unit)} each${capped ? ' from the merchant' : ''} · ${
      gap ? `no ${KIND_LABEL[gap.kind] || gap.kind} to grow it — build one and this changes`
        : held ? `after the ${short(held)} you hold`
          : b.forFarm ? 'what the plots burn and do not give back'
            : grown ? 'topping up what you grow'
              : 'nothing in your plan grows these'}`;
  return rowHTML({
    attrs: `data-price="${esc(b.id)}"`, icon: ICON.cart, cls: unit ? '' : 'warn',
    title: `${short(b.qty)} × ${esc(nameOf(b.id))}`,
    meta: esc(why),
    right: unit ? amt(-b.cost) : tag('Set price'),
  });
}

/* -------------------------------------------------------------- craft -- */

function craftSection(sim) {
  const s = state.settings;
  const revenue = sim.craftLines.filter((l) => l.terminal).reduce((t, l) => t + (l.revenue || 0), 0);
  const head = `
    <div class="section-head"><h2>Craft · ${s.craftWhere === 'best'
      ? 'best city per step' : `in ${esc(cityName(s.craftCity))}`}</h2>
      <span class="right num ${revenue > 0.5 ? 'good' : 'flat'}">${revenue > 0.5 ? short(revenue) : ''}</span></div>`;
  const rows = sim.craftLines.map(craftRow).join('');
  const emptyRow = rows ? '' : rowHTML({
    act: 'add-craft', icon: ICON.potion, cls: 'quiet',
    title: 'No craft jobs', meta: 'This is usually where the money is', right: go(),
  });
  return `<section>${head}${rows}${emptyRow}${haulRows(sim)}${addRow('Add a craft job', 'add-craft')}</section>`;
}

/**
 * One craft job.
 *
 * The figure is what this step's output actually sold for, so the farm rows
 * above and the craft rows here add up to the profit at the top of the screen.
 * Whether the step was worth doing is a different question, and it goes in the
 * meta line: the margin there counts your own produce at what it cost you to
 * grow, not at what it would have fetched, because you never sold it. A step
 * that only feeds the next one has no figure at all: nothing of it reaches
 * the market, and its cost simply carries forward.
 */
function craftRow(line, _i, all) {
  const { recipe, crafts, made, limitedBy, job, bottleneck } = line;
  const destroys = crafts > 0 && line.terminal && line.gain < 0;

  // Naming the input that ran out is the difference between "materials run
  // out" and knowing what to go and plant, or which step you forgot to add.
  const why = limitedBy === 'materials'
    ? (bottleneck
      ? (bottleneck.have <= 0
        ? `no ${nameOf(bottleneck.id)} at all`
        : `short on ${nameOf(bottleneck.id)}`)
      : 'materials run out')
    : limitedBy === 'focus'
      ? ((all || []).some((o) => o !== line && o.crafts > 0 && o.batch.focus > 0 && o.payRate > line.payRate)
        ? 'focus runs out — it went to what pays better for it'
        : 'focus runs out')
      : line.bought?.length ? 'topped up from the market'
        : `batch set to ${short(job.perCycle || 0)}`;

  const margin = line.feeds ? ''
    : destroys ? `${short(-line.gain)} less than it cost`
      : `${short(line.gain)} over cost`;

  const right = !crafts ? amt('—', { tone: 'flat' })
    : line.terminal ? amt(line.revenue, { tone: destroys ? 'bad' : 'good' })
      : tag(line.feeds ? `→ ${nameOf(line.feeds.id)}` : '→ next step');
  const feeds = '';

  return rowHTML({
    attrs: `data-craft="${esc(job.id)}"`, icon: craftIcon(recipe.category),
    cls: crafts === 0 ? 'warn' : '',
    title: `×${short(made)} ${tierText(recipe.tier, recipe.enchant)} ${esc(recipe.name)}`,
    meta: esc([`${short(crafts)} crafts`, why, crafts ? (margin || feeds) : ''].filter(Boolean).join(' · ')),
    right,
  }) + missingStepRow(line);
}

/**
 * When a craft makes nothing because an input is simply absent, and some other
 * recipe would produce that input, offer to add that step. Growing potatoes
 * without brewing them into schnapps leaves the potion with nothing to use.
 */
function missingStepRow(line) {
  if (line.crafts > 0 || !line.bottleneck || line.bottleneck.have > 0) return '';
  const id = line.bottleneck.id;
  const maker = DATA.recipes.find((r) => r.id === id);
  const already = state.plan.crafts.some((c) => c.recipeId === id);
  if (!maker || already) return '';
  const from = maker.inputs.map((i) => nameOf(i.id)).join(', ');
  return rowHTML({
    attrs: `data-add-step="${esc(maker.id)}"`, icon: craftIcon(maker.category), cls: 'suggest',
    title: `Add ${esc(maker.name)} to your plan`,
    meta: `Made from ${esc(from)} — without it this craft has none`,
    right: tag('Add'),
  });
}

const haulWeight = (sim) => (sim.legs || []).reduce((t, l) => t + l.weight, 0);

/**
 * What the cycle makes you carry. You farm where the bonus is and you craft
 * where the specialty is, and those are rarely the same city, so the harvest
 * has to travel. Only what the crafting gets through makes the trip.
 */
function haulRows(sim) {
  const legs = sim.legs || [];
  const s = state.settings;
  return legs.map((leg) => {
    const items = leg.items.slice(0, 3).map((i) => `${short(i.qty)} ${nameOf(i.id)}`).join(', ')
      + (leg.items.length > 3 ? ` and ${leg.items.length - 3} more` : '');
    const trips = leg.trips
      ? `${leg.trips} ${leg.trips === 1 ? 'trip' : 'trips'} at ${short(s.carryWeight)} kg`
      : 'set what you carry on Me to count trips';
    const cost = leg.cost > 0 ? ` · costs ${short(leg.cost)}, not in the profit` : '';
    return rowHTML({
      act: 'craft-city', icon: ICON.carry,
      title: `Carry ${short(leg.weight)} kg · ${esc(cityName(leg.from))} → ${esc(cityName(leg.to))}`,
      meta: esc(`${items} · ${trips}${cost}`),
      right: go(),
    });
  }).join('');
}

/* --------------------------------------------------------------- days -- */

const DAY_ICON = { farm: ICON.farm, rest: '\u{1F4A4}', craft: ICON.potion };

/** Consecutive days of the same kind, as one run each. */
function runsOf(days) {
  const out = [];
  days.forEach((mode, i) => {
    const last = out[out.length - 1];
    if (last && last.mode === mode) last.to = i + 1;
    else out.push({ mode, from: i + 1, to: i + 1 });
  });
  return out;
}

/** The calendar, read-only, one tap to edit it, with the routine under it. */
function daysCard(sim) {
  const days = sim.days || [];
  const cells = days.length <= 21
    ? `<div class="days">${days.map((m, i) => `
        <span class="day ${m}"><span class="n">${i + 1}</span><span class="m">${DAY_ICON[m]}</span></span>`).join('')}</div>`
    : `<div class="pills">${runsOf(days).map((r) => `
        <span class="pill ${r.mode}">${r.from === r.to ? `Day ${r.from}` : `Days ${r.from}–${r.to}`} ${DAY_ICON[r.mode]}</span>`).join('')}</div>`;
  const steps = routineSteps(sim).slice(0, 3);
  return `
    <section>
      <div class="section-head"><h2>Your days · ${sim.cycleDays}-day cycle</h2>
        <span class="right flat">tap to change</span></div>
      <div class="card days-card" role="button" tabindex="0" data-act="cycle">
        ${cells}
        ${steps.length ? `<div class="steps">${steps.map((st) => `
          <div class="step">
            <span class="when">${esc(st.when)}</span>
            <span class="body">
              <span class="what">${esc(st.what)}</span>
              <span class="note">${esc(st.note)}</span>
            </span>
          </div>`).join('')}</div>` : ''}
      </div>
    </section>`;
}

/**
 * What to actually do, day by day. Read from the simulation rather than from
 * the solver, so it keeps telling the truth after you move a plot by hand.
 */
function routineSteps(sim) {
  const s = state.settings;
  const steps = [];
  /* The days, as runs: "Days 1–5 farm, day 6 rest, days 7–8 craft". A long
   * alternating pattern would be a step per day, so past a handful of runs it
   * is said once as a pattern instead. */
  const runs = runsOf(sim.days || []);
  const span = (r) => (r.from === r.to ? `Day ${r.from}` : `Days ${r.from}–${r.to}`);
  const perDayFocus = s.focusPerDay || 0;
  const describe = (mode, n) => (mode === 'farm'
    ? { what: 'Harvest and replant', note: `${s.watered ? 'water what you can afford to · ' : ''}${
      n} ${n === 1 ? 'day' : 'days'} out there` }
    : mode === 'rest'
      ? { what: 'Stay away, let focus bank', note: `${short(n * perDayFocus)} banked for the next day you are back` }
      : { what: 'Stop farming, keep crafting', note: 'Nothing to harvest, but every day still brings focus to spend' });
  if (runs.length <= 6) {
    for (const r of runs) {
      if (r.mode === 'farm' && !sim.farmLines.length) continue;
      steps.push({ when: span(r), ...describe(r.mode, r.to - r.from + 1) });
    }
  } else {
    const n = (m) => sim.days.filter((d) => d === m).length;
    steps.push({
      when: `Days 1–${sim.cycleDays}`,
      what: `Farm ${n('farm')}, rest ${n('rest')}, craft ${n('craft')}`,
      note: `In the order on your calendar: ${sim.days.map((d) => d[0].toUpperCase()).join('')}`,
    });
  }
  const made = sim.craftLines.filter((l) => l.crafts > 0);
  if (made.length) {
    steps.push({
      when: `Days 1–${sim.cycleDays}`,
      what: made.map((l) => `${short(l.crafts)}× ${nameOf(l.recipe.id)}`).join(', '),
      note: sim.focusUsed > 0
        ? `${short(sim.focusUsed)} focus over the cycle, about ${short(sim.focusUsed / sim.cycleDays)} a day · ${short(sim.revenue)} on the market`
        : `${short(sim.revenue)} on the market`,
    });
  }
  return steps;
}

/* ------------------------------------------------------------ details -- */

const KIND_LABEL = {
  farm: 'Farm', herbgarden: 'Herb Garden', pasture: 'Pasture', kennel: 'Kennel',
  plant: 'Farm or Herb Garden', animal: 'Pasture or Kennel',
};
const cityName = (id) => (state.settings.cities || [])
  .find((c) => c.id === id)?.name || id;

const LIMIT_NOTE = {
  focus: 'Focus is the wall. More land would only grow produce you cannot brew,'
    + ' so the spare plots are better off earning on their own.',
  plots: 'Land is the wall. Every plot is already feeding the batch, and more'
    + ' of them would turn straight into more potions.',
  materials: 'Neither focus nor land is quite the wall: whole plots do not'
    + ' divide evenly into the recipe, so one ingredient runs out first.',
  nothing: 'Nothing gets made at these prices. Check the ones it is missing.',
};

/** The solver's reasoning, shown until you ask it something else. */
function whyCard() {
  const r = solution;
  if (!r?.ok || r.target.id !== state.goal.recipeId) return '';
  const chain = [...new Set([r.target.id, ...r.steps.map((x) => x.itemId)])];
  const missing = chain.filter((id) => !priceOf(id)).length;
  return `
    <div class="section-head"><h2>Why this plan</h2></div>
    <div class="card">
      ${r.profitable ? '' : `<div class="warn-note">At your prices this loses
        money: every way of making it that was tried came out negative. Check
        the prices, or make something else.</div>`}
      <div class="bar-row"><span class="n">${esc(r.target.name)} a cycle</span>
        <span class="v num">${short(r.made)}</span></div>
      <div class="bar-row"><span class="n">Plots on the chain</span>
        <span class="v num">${r.chainPlots} of ${r.budget}</span></div>
      ${r.pinnedCycle ? `<div class="bar-row"><span class="n">Cycle you set</span>
        <span class="v num">${r.sched.cycleDays} days, farming ${r.sched.farmDays}</span></div>` : ''}
      <div class="bar-row"><span class="n">Focus per craft, which makes ${
        round1(r.targetMade ?? r.target.amount)}</span>
        <span class="v num">${r.targetFocus ? short(r.focusPerTarget) : 'none'}</span></div>
      ${note(esc(LIMIT_NOTE[r.limit] || ''))}
      ${r.pinnedCycle && r.sim.focusWasted > 0 ? `<div class="warn-note">
        A ${r.sched.cycleDays}-day cycle regenerates more focus than this plan
        can use: ${short(r.sim.focusWasted)} of it goes to waste once the
        crafting runs out of materials. More land, or a shorter cycle, would
        put it to work.</div>` : ''}
      ${missing ? `<div class="warn-note">${missing} of the ${chain.length} items in
        this chain have no market price, so the plan is built on incomplete
        numbers. Fetch them and work it out again.</div>`
    : note(`Worked out from ${esc(serverName(state.settings.server))} prices in
        ${esc(state.settings.priceCity)}. Fetch them again before you commit to
        a cycle: a herb doubling in price changes the answer.`)}
      ${!r.targetFocus ? note(`It brews without focus: your land grows more than
        the focus you have could ever process, and a bigger batch at a worse
        return rate beats a small one at a good rate when the herbs cost you
        seeds rather than silver.`) : ''}
    </div>`;
}

function otherCycles() {
  const r = solution;
  if (!r?.ok || r.target.id !== state.goal.recipeId) return '';
  const alt = r.alternatives.filter((a) => a.perDay > 0).slice(0, 3);
  const ties = (r.ties || []).slice(0, 2);
  if (!alt.length && !ties.length) return '';
  const shape = (x) => `${x.cycleDays}-day, farm ${x.farmDays}${
    x.farmEvery > 1 ? ` every ${x.farmEvery}` : ''}`;
  return `
    <div class="section-head"><h2>Other cycles</h2></div>
    <div class="card">
      ${alt.map((a) => `
        <div class="bar-row">
          <span class="n">${esc(shape(a.sched))}</span>
          <span class="v num flat">${short(a.perDay)}/d</span></div>`).join('')}
      <div class="bar-row total"><span class="n">This plan · ${esc(shape(r.sched))}</span>
        <span class="v num good">${short(r.perDay)}/d</span></div>
      ${ties.length ? note(`${ties.map((t) => esc(shape(t.sched))).join(' and a ')} ${
        ties.length === 1 ? 'earns' : 'earn'} the same. Take whichever suits how
        often you can log in: this one is just the shortest.`) : ''}
    </div>`;
}

/** What one craft of the cheapest job costs, or infinity if none use focus. */
function oneCraftOf(sim) {
  return Math.min(...sim.craftLines
    .filter((l) => l.batch.focus > 0).map((l) => l.batch.focus), Infinity);
}

/**
 * Focus across the cycle: how much of each day's regeneration went into
 * watering and crafting, which days it did not, and what that costs.
 */
function focusCard(sim) {
  const s = state.settings;
  const l = sim.ledger;
  if (!l.days.some((d) => d.spent + d.craft > 0)) {
    return `<div class="section-head"><h2>Focus</h2></div>${note('No focus is spent in this plan.')}`;
  }
  const perDay = Math.max(1, s.focusPerDay || 1);
  let wasted = false;
  const bars = l.days.map((d) => {
    const used = d.spent + d.craft;
    const h = Math.max(4, Math.min(100, (used / perDay) * 100));
    // A rest day is drawn as a rest day: nothing spent is the point of it.
    const cls = d.resting ? 'rest' : d.wasted > 0 && used <= 0 ? 'over' : d.farming ? 'today' : 'crafting';
    if (cls === 'over') wasted = true;
    const what = [
      d.farming ? 'farming' : d.resting ? 'resting' : 'at the station',
      used > 0 ? `${Math.round(used)} focus used` : d.resting ? 'banking focus' : 'nothing to spend it on',
    ].join(', ');
    return `<i class="${cls}" style="height:${h}%" title="day ${d.day}, ${what}"></i>`;
  }).join('');

  const warn = [];
  if (sim.focusWasted > 0) {
    warn.push(`${short(sim.focusWasted)} focus goes to waste: the crafting runs
      out of materials before the bar stops filling. More land, or a shorter
      cycle, would use it.`);
  }
  if (sim.wateringShortfall > 0) {
    const pct = Math.round(sim.wateredFraction * 100);
    warn.push(`Watering every plot would cost ${short(sim.wateringPerDay)} focus a
      farming day, and you regenerate ${short(s.focusPerDay)}. Only about
      <b>${pct}%</b> of your plots actually get watered, so only that share earns
      the extra seeds: the figures above already account for it. Fewer plots,
      or farming less often, would water more of them.`);
  }
  // A few focus left over is the remainder of a division, not money on the
  // table. A whole craft's worth of it is.
  if (sim.focusLeft >= oneCraftOf(sim) && sim.craftLines.length) {
    warn.push(`${short(sim.focusLeft)} focus is left unspent: your crafting ran
      out of materials first.`);
  }
  const banking = sim.focusWasted > 0 ? ''
    : sim.focusUsed <= 0 ? `No focus goes to crafting in this plan${
      sim.focusCarried > 0 ? `; ${short(sim.focusCarried)} is carried into the next cycle` : ''}.`
    : `${short(sim.focusBudget)} of focus across ${sim.cycleDays} days, spent as it
       arrives rather than saved up: each craft hands most of its materials
       back, so the same pile keeps brewing with tomorrow's focus.${
      sim.focusCarried > 0 ? ` You end holding ${short(sim.focusCarried)}, which
      starts the next cycle off.` : ''}`;

  return `
    <div class="section-head"><h2>Focus</h2></div>
    <div class="card">
      <div class="spark">${bars}</div>
      <div class="axis"><span>day 1</span><span>day ${sim.cycleDays}</span></div>
      <div class="legend">
        <span><i class="sw farm"></i>farming ${sim.farmingDays}</span>
        ${sim.restDays ? `<span><i class="sw rest"></i>resting ${sim.restDays}</span>` : ''}
        ${sim.craftDays ? `<span><i class="sw craft"></i>crafting ${sim.craftDays}</span>` : ''}
        ${wasted ? '<span><i class="sw waste"></i>wasted</span>' : ''}
      </div>
      <div class="bar-row" style="margin-top:8px">
        <span class="n">Focus this cycle regenerates</span>
        <span class="v num">${short(sim.focusBudget + sim.wateringPaid)}</span></div>
      ${sim.wateringPaid > 0 ? `<div class="bar-row"><span class="n">Of which watering takes</span>
        <span class="v num">${short(sim.wateringPaid)}</span></div>` : ''}
      <div class="bar-row"><span class="n">Spent crafting</span>
        <span class="v num">${short(sim.focusUsed)}</span></div>
      ${sim.focusCarried > 0 ? `<div class="bar-row">
        <span class="n">Carried into the next cycle</span>
        <span class="v num">${short(sim.focusCarried)}</span></div>` : ''}
      ${banking ? note(banking) : ''}
      ${warn.map((w) => `<div class="warn-note">${w}</div>`).join('')}
    </div>`;
}

/**
 * The costs, itemised. One "Costs" line cannot be checked against anything;
 * three that add up to it can.
 */
function costLines(sim) {
  const parts = [
    ['Stock brought in, at what it cost', sim.openingBasis],
    ['Seeds, feed and goslings', sim.farmCost],
    ['Bought from the market', sim.buyCost],
    ['Station fees', sim.feeCost],
  ].filter(([, v]) => Math.abs(v) > 0.5);

  if (!parts.length) return '';
  const rows = parts.map(([label, v]) => `
    <div class="bar-row"><span class="n">${esc(label)}</span>
      <span class="v num ${v > 0 ? 'bad' : 'good'}">${short(-v)}</span></div>`).join('');

  /* What you grew and did not brew is still yours. Its cost comes back out of
   * the bill rather than being written off, because you are holding the goods,
   * not losing them. Otherwise a cycle that got ahead of its crafting reads
   * as a disaster. */
  const held = sim.heldBasis > 0.5 && sim.heldBasis > sim.revenue * 0.01 ? `
    <div class="bar-row"><span class="n">Less what is kept back, at cost</span>
      <span class="v num good">${short(sim.heldBasis)}</span></div>` : '';

  const sum = (parts.length > 1 || held) ? `
    <div class="bar-row"><span class="n">${sim.cost >= 0 ? 'Costs in all'
      : 'Seed surplus, beyond what the farm cost'}</span>
      <span class="v num ${sim.cost >= 0 ? 'bad' : 'good'}">${short(-sim.cost)}</span></div>` : '';
  return rows + held + sum;
}

function ledgerCard(sim) {
  if (!sim.sales.length && !sim.craftLines.length) return '';
  const sales = sim.sales.filter((x) => x.qty >= 1).slice(0, 10);
  return `
    <div class="section-head"><h2>Ledger</h2>
      <span class="right num flat">${short(sim.revenue)} sold</span></div>
    <div class="card">
      ${sales.map((x) => `
        <div class="bar-row"><span class="n">${round1(x.qty)} × ${esc(nameOf(x.id))}</span>
          <span class="v num ${x.value ? 'good' : ''}">${short(x.value)}</span></div>`).join('')}
      ${costLines(sim)}
      <div class="bar-row total"><span class="n">Profit for the cycle</span>
        <span class="v num ${toneOf(sim.profit)}">${short(sim.profit)}</span></div>
      ${note(`Plant and Buy above are the seeds-and-feed and shopping lines here.
        Fees, anything sold straight from the farm, and what is kept back at
        cost only show here, which is why the sections do not add up to the
        number on their own.`)}
    </div>`;
}

/** The last row of the screen: roll this cycle's leftovers into the next. */
function nextCycleRow(sim) {
  if (!sim.stock.length && !(sim.focusCarried > 0)) return '';
  const n = sim.stock.filter((x) => x.qty >= 1).length;
  return `<section>${rowHTML({
    act: 'carry-stock', icon: ICON.next,
    title: 'Start the next cycle from here',
    meta: n
      ? `Puts ${n} ${n === 1 ? 'leftover' : 'leftovers'}${
        sim.focusCarried > 0 ? ` and ${short(sim.focusCarried)} focus` : ''} into the bag at what they cost`
      : `Carries ${short(sim.focusCarried)} focus into the next cycle`,
    right: go(),
  })}</section>`;
}

export function missingPrices() {
  const need = new Set();
  const add = (id) => { if (id && !priceOf(id)) need.add(id); };
  for (const row of state.plan.plots) {
    const p = DATA.plants.find((x) => x.id === row.itemId);
    if (p) { add(p.seedId); add(p.cropId); continue; }
    const a = DATA.animals.find((x) => x.id === row.itemId);
    if (!a) continue;
    add(a.babyId);
    if (row.mode === 'product' && a.product) add(a.product.itemId);
    else add(a.grownId);
    add(feedFor(a, state.settings).id);
  }
  for (const job of state.plan.crafts) {
    const r = DATA.recipes.find((x) => x.id === job.recipeId);
    if (!r) continue;
    add(r.id);
    for (const i of r.inputs) add(i.id);
  }
  return [...need];
}

/**
 * What each city would earn crafting this plan, for the craft-city sheet.
 *
 * The return rate is the biggest lever on a batch and it is decided by which
 * building you walk into, so this re-runs the whole cycle in every city and
 * shows the difference rather than making you take one on trust. Eleven runs
 * of the simulator is about ten milliseconds. Cities that pay alike collapse
 * to the one you would carry least to, which is all that separates them.
 */
export function cityDeltas(sim) {
  const s = state.settings;
  const cities = s.cities || [];
  if (!sim?.craftLines.length || cities.length < 2) return [];
  const rows = cities.map((city) => {
    if (city.id === s.craftCity) {
      return { city, profit: sim.profit, weight: haulWeight(sim), here: true };
    }
    /* The same two passes plan() itself does, and with the jobs moved as
     * well as the setting, because a job's own city wins over the setting
     * and would otherwise quote the same number for all eleven. */
    const at = (f) => ({ ...ctx(f), settings: { ...s, craftCity: city.id } });
    const moved = { ...state.plan, crafts: state.plan.crafts.map(({ cityId, ...job }) => job) };
    const probe = simulateCycle(moved, DATA, at(1));
    const run = simulateCycle(moved, DATA, at(probe.wateredFraction));
    return { city, profit: run.profit, weight: haulWeight(run), here: false };
  });
  const groups = new Map();
  for (const r of rows) {
    const key = Math.round(r.profit);
    const at = groups.get(key) || { profit: r.profit, all: [] };
    at.all.push(r);
    if (!at.pick || r.weight < at.pick.weight) at.pick = r;
    if (r.here) { at.pick = r; at.here = true; }
    groups.set(key, at);
  }
  const shown = [...groups.values()].sort((a, b) => b.profit - a.profit);
  const best = shown[0]?.profit;
  return shown.map((g) => ({
    city: g.pick.city, profit: g.profit, weight: g.pick.weight, here: !!g.here,
    others: g.all.length - 1, best: g.profit === best, delta: g.profit - sim.profit,
  }));
}

/* ============================================================== RANK ==== */

export function rank() {
  const c = ctx();
  const s = state.settings;
  const assumptions = rankTab === 'gear'
    ? `In ${cityFor(s)?.name || '—'} · ${s.useFocus ? 'with focus' : 'no focus'} · ${s.premium ? 'premium' : 'no premium'}`
    : rankTab === 'farm'
      // One row at a time, so there is no plan to say how far the focus
      // stretches: every plot is taken as watered.
      ? `${farmCityFor(s)?.name || '—'} · ${s.watered ? 'every plot watered' : 'unwatered'} · ${
        s.premium ? 'premium' : 'no premium'}${s.hideMounts ? ' · mounts hidden' : ''}`
      : `In ${cityFor(s)?.name || '—'} · ${s.useFocus ? 'with focus' : 'no focus'} · ${
        s.ownInputsAtCost ? 'my own inputs at cost' : 'inputs at market'}`;
  const missing = ['gear', 'gather'].includes(rankTab) ? [] : rankMissingIds();
  const kit = kitOf(s);
  const gatherWords = `${kit.toolTier ? `T${kit.toolTier} tool` : 'no tool set'} · ${
    (s.gathering?.kindLabels?.[kit.kind] || kit.kind).toLowerCase()} · ${
    kit.zone === 'royal' ? 'royal cluster' : 'Outlands cluster'} · ${
    cityFor(s)?.name || '—'}`;
  return {
    title: 'Best',
    action: rankTab === 'gear' ? { label: '↓ Prices', act: 'scan-prices' }
      : rankTab === 'gather' ? { label: '↓ Prices', act: 'gather-prices' }
        : missing.length ? { label: '↓ Prices', act: 'rank-prices' } : null,
    html: `
      <div class="tabs">
        <button data-rank="farm" aria-pressed="${rankTab === 'farm'}">Farm</button>
        <button data-rank="craft" aria-pressed="${rankTab === 'craft'}">Brew</button>
        <button data-rank="gear" aria-pressed="${rankTab === 'gear'}">Gear</button>
        <button data-rank="gather" aria-pressed="${rankTab === 'gather'}">Gather</button>
      </div>
      <section>
        ${slimRow({
    act: rankTab === 'gather' ? 'gather-setup' : 'assumptions',
    icon: rankTab === 'gather' ? ICON.raw : ICON.assume,
    title: esc(rankTab === 'gather' ? gatherWords : assumptions),
  })}
        ${rankTab === 'gear' ? craftRankHTML()
    : rankTab === 'gather' ? gatherRankHTML()
      : rankTab === 'farm' ? farmRank(c, missing) : craftRank(c, missing)}
      </section>`,
  };
}

/* ------------------------------------------------------------- gather -- */

/** Which tier the gathering ranking is looking at. A question, not a plan. */
export let gatherTier = 0;
export const setGatherTier = (t) => { gatherTier = Number(t) || 0; };

/* The tier to rank if you have not said. Your tool's own tier: a node above it
 * is half again as long a swing and a node two above it the game refuses, so
 * the tier the tool was made for is the one to open on. */
const defaultGatherTier = () => kitOf(state.settings).toolTier || 4;

const gatherCtx = () => ({
  recipeOf,
  priceOf,
  costOf,
  sellPriceOf: priceOf,
  settings: state.settings,
  cityId: state.settings.craftCity,
});

/**
 * Every resource at one tier, and the best thing to do with each.
 *
 * Ranked on silver per second of actual swinging, because that is the one
 * measure available whether or not you have ever timed a run: the swing floor
 * comes straight out of the game's tables. Silver an hour is shown too, and
 * only once you have measured, since travel and respawn are in no dump.
 *
 * The comparison is the point. Selling logs, refining them into planks and
 * transmuting them a grade up are three completely different businesses off
 * the same tree, and which of them wins moves with the market week to week.
 */
export function gatherRank() {
  const tier = gatherTier || defaultGatherTier();
  const ctxNow = gatherCtx();
  const rows = [];
  for (const family of state.settings.gathering?.families || []) {
    const id = rawId(family, tier, 0);
    /* Ask whether it can be gathered at all before asking what to do with it.
     * A tool two tiers under the node, or a sort of node that does not exist
     * at this tier, is a row with a reason on it rather than a row missing. */
    const run = gatherRun(id, { qty: 999, settings: state.settings });
    if (!run) continue;
    if (run.impossible) {
      rows.push({ family, id, tier, exits: [], best: null, blocked: run, missing: [] });
      continue;
    }
    const exits = resourceExits(id, ctxNow, { qty: 999 });
    if (!exits.length) continue;
    const ready = exits.filter((e) => !e.missing.length);
    rows.push({
      family, id, tier, exits,
      best: ready[0] || null,
      blocked: null,
      missing: [...new Set(exits.flatMap((e) => e.missing))],
    });
  }
  rows.sort((a, b) => (b.best?.silverPerSwingSecond ?? -Infinity)
    - (a.best?.silverPerSwingSecond ?? -Infinity));
  return { tier, rows };
}

/** Every id the gathering ranking needs priced, for one scoped fetch. */
export function gatherMissingIds() {
  return [...new Set(gatherRank().rows.flatMap((r) => r.missing))];
}

function gatherRankHTML() {
  const { tier, rows } = gatherRank();
  const ready = rows.filter((r) => r.best);
  const top = Math.max(...ready.map((r) => Math.abs(r.best.silverPerSwingSecond)), 0.01);
  const blocked = rows.find((r) => r.blocked);
  /* With no tool set every row is blocked, and five identical refusals is a
   * screen that looks broken rather than a screen asking a question. */
  const noTool = !kitOf(state.settings).toolTier;

  const row = (r) => {
    const b = r.best;
    if (!b) {
      return rowHTML({
        act: 'gather-setup', icon: ICON.raw, cls: 'warn',
        title: `${esc(nameOf(r.id))}`,
        meta: r.blocked ? esc(r.blocked.why)
          : `needs a price for ${r.missing.slice(0, 2).map(nameOf).map(esc).join(', ')}${
            r.missing.length > 2 ? ` and ${r.missing.length - 2} more` : ''}`,
        right: amt('—', { tone: 'flat' }),
      });
    }
    const w = (Math.abs(b.silverPerSwingSecond) / top) * 100;
    return `
      <button class="row rank wrap" data-gather-row="${esc(r.id)}">
        <span class="ico">${ICON.raw}</span>
        <span class="body">
          <span class="title">${esc(nameOf(r.id))} → ${esc(b.label.toLowerCase())}</span>
          <span class="meta">${esc([
    `${short(b.profit)} off 999`,
    b.hours ? `${short(b.profit / b.hours)} an hour` : `${hours(b.swingSeconds / 3600)} swinging`,
    b.focus > 0 ? `${short(b.focus)} focus` : 'no focus',
    r.exits.length > 1 && r.exits[1].silverPerSwingSecond != null
      ? `next best ${esc(r.exits[1].label.toLowerCase())}` : '',
  ].filter(Boolean).join(' · '))}</span>
          <span class="bar"><i class="${toneOf(b.profit)}" style="width:${w.toFixed(1)}%"></i></span>
        </span>
        ${amt(b.silverPerSwingSecond, { unit: '/swing-s' })}
      </button>`;
  };

  return `
    <div class="seg small" style="margin-bottom:10px">
      ${[2, 3, 4, 5, 6, 7, 8].map((t) => `
        <button data-gather-tier="${t}" aria-pressed="${t === tier}">T${t}</button>`).join('')}
    </div>
    ${noTool ? slimRow({
    act: 'gather-setup', icon: ICON.raw, cls: 'suggest',
    title: 'Say which tool you swing and this whole screen comes alive',
  }) : ''}
    ${!noTool && rows.some((r) => r.missing.length) ? `<button class="btn primary fetch" data-act="gather-prices">
      ↓ Fetch the prices these need</button>` : ''}
    ${rows.length ? rows.map(row).join('') : empty('\u26CF\uFE0F', 'No node of that sort at this tier.')}
    ${blocked && !noTool ? `<div class="warn-note">${esc(blocked.why)}. A tool one tier
      under the node is half again as long a swing, and two under and the game
      refuses. <b>Me → Your gathering</b> sets it.</div>` : ''}
    ${note(`Profit on a 999 pile, every route costed off the same swings, best
      first. Silver a swing-second is the game's own floor and is exact; silver
      an hour appears once you have timed a run, because travel and respawn are
      in no game file. Tap a row to see every route side by side.`, 'centered')}`;
}

/** Every id the Farm or Brew ranking is missing a price for, for one scoped fetch. */
export function rankMissingIds() {
  const c = ctx();
  const ids = new Set();
  if (rankTab === 'farm') {
    for (const r of rankFarmables(DATA, c)) for (const id of missingFor(r.cycle)) ids.add(id);
  } else if (rankTab === 'craft') {
    for (const b of rankRecipes(DATA, c)) for (const id of missingFor(b)) ids.add(id);
  }
  return [...ids];
}

function farmRank(c, missing = []) {
  const rows = rankFarmables(DATA, c).map((r) => ({ ...r, missing: missingFor(r.cycle) }));
  const ready = rows.filter((r) => !r.missing.length);
  const notReady = rows.filter((r) => r.missing.length);
  const best = Math.max(...ready.map((r) => Math.abs(r.rate.perDay)), 1);

  const render = ({ cycle, rate, missing: miss }) => {
    const ref = cycle.ref;
    const icon = ICON[cycle.kind === 'product' ? 'product' : ref.kind] || ICON.seed;
    const what = cycle.kind === 'product'
      ? `${nameOf(ref.product.itemId)} (${ref.name})` : ref.name;
    const w = (Math.abs(rate.perDay) / best) * 100;
    return `
      <button class="row rank" data-add-plot="${esc(ref.id)}"
        data-mode="${cycle.kind === 'product' ? 'product' : 'grow'}">
        <span class="ico">${icon}</span>
        <span class="body">
          <span class="title">T${ref.tier} ${esc(what)}</span>
          ${miss.length
    ? `<span class="meta">needs a price for ${esc(miss.map(nameOf).join(', '))}</span>`
    : `<span class="bar"><i class="${toneOf(rate.perDay)}" style="width:${w}%"></i></span>`}
        </span>
        ${miss.length ? amt('—', { tone: 'flat' }) : amt(rate.perDay, { unit: '/plot/day' })}
      </button>`;
  };

  if (!rows.length) return empty('\u{1F4CA}', 'No data.');
  return `
    ${missing.length ? `<button class="btn primary fetch" data-act="rank-prices">
      ↓ Fetch prices for these ${missing.length}</button>` : ''}
    ${ready.map(render).join('')}
    ${notReady.length ? moreHTML('rank-needs', `${notReady.length} need prices`, '', notReady.map(render).join(''), !ready.length) : ''}`;
}

function craftRank(c, missing = []) {
  const all = rankRecipes(DATA, c).map((b) => ({ b, missing: missingFor(b) }));
  const ready = all.filter((r) => !r.missing.length).slice(0, 40);
  const notReady = all.filter((r) => r.missing.length).slice(0, 30);
  const useFocus = state.settings.useFocus;

  const render = ({ b, missing: miss }) => `
    <button class="row rank" data-add-craft="${esc(b.ref.id)}">
      <span class="ico">${craftIcon(b.ref.category)}</span>
      <span class="body">
        <span class="title">${tierText(b.ref.tier, b.ref.enchant)} ${esc(b.ref.name)}</span>
        <span class="meta">${miss.length
    ? `needs a price for ${esc(miss.map(nameOf).join(', '))}`
    : `makes ${round1(b.made)} · ${pct(b.rrr)} ${b.ref.returnProduct ? 'extra meat' : 'returned'}${
      useFocus ? ` · ${Math.round(b.focus)} focus` : ''}`}</span>
      </span>
      ${miss.length ? amt('—', { tone: 'flat' })
    : useFocus && b.silverPerFocus != null
      ? amt(b.silverPerFocus, { unit: '/focus' })
      : amt(b.profit, { unit: '/craft' })}
    </button>`;

  if (!all.length) return empty('\u{1F9EA}', 'No recipes.');
  return `
    ${missing.length ? `<button class="btn primary fetch" data-act="rank-prices">
      ↓ Fetch prices for these ${missing.length}</button>` : ''}
    ${ready.map(render).join('') || note('Set some prices and the best recipes rank here.', 'centered')}
    ${notReady.length ? moreHTML('rank-needs', `${notReady.length} need prices`, '', notReady.map(render).join(''), !ready.length) : ''}`;
}

/* ============================================================ PRICES ==== */

export let priceQuery = '';
export const setPriceQuery = (v) => { priceQuery = v; };

/** The rows of the Market list, on their own so a search can redraw just them. */
export function priceListHTML() {
  const all = pricedIds();
  const used = new Set(planItemIds());
  let ids = all;
  if (priceFilter === 'used') ids = all.filter((id) => used.has(id));
  if (priceFilter === 'missing') ids = all.filter((id) => !priceOf(id));
  const q = priceQuery.trim().toLowerCase();
  if (q) ids = ids.filter((id) => nameOf(id).toLowerCase().includes(q) || id.toLowerCase().includes(q));

  const groups = new Map();
  for (const id of ids) {
    const cat = itemMeta(id)?.cat || 'other';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(id);
  }
  const ORDER = ['crop', 'herb', 'seed', 'product', 'baby', 'animal',
    'raw', 'refined', 'journal', 'potion', 'food', 'material', 'other'];
  const sorted = [...groups.entries()]
    .sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));

  const setCount = all.filter((id) => priceOf(id)).length;
  if (!setCount && priceFilter !== 'all') return '';
  return sorted.map(([cat, list]) => `
    <section>
      <div class="section-head"><h2>${esc(catLabel(cat))}</h2>
        ${priceFilter === 'all' ? `<span class="right flat">${list.filter(priceOf).length} of ${list.length} set</span>` : ''}</div>
      ${list.sort((a, b) => tierOf(a) - tierOf(b) || nameOf(a).localeCompare(nameOf(b)))
    .map((id) => rowHTML({
      attrs: `data-price="${esc(id)}"`, icon: iconFor(itemMeta(id)?.cat),
      title: esc(label(id)),
      meta: `${esc(catLabel(cat).replace(/s$/, ''))} · ${tierText(tierOf(id), enchantOf(id))}${hasOwnCost(id) ? ` · you pay ${silver(costOf(id))}` : ''}`,
      right: priceOf(id) ? amt(silver(priceOf(id)), { tone: '' }) : tag('Set price'),
    })).join('')}
    </section>`).join('')
    || empty('\u{1F4B0}', q ? 'Nothing by that name.' : priceFilter === 'missing'
      ? 'Every item in view has a price.'
      : priceFilter === 'used' ? 'Pick something to make on Plan and its prices show here.'
        : 'Nothing to price yet.');
}

export function prices() {
  const all = pricedIds();
  const setCount = all.filter((id) => priceOf(id)).length;
  const s = state.settings;
  return {
    title: 'Market',
    action: { label: '↓ Fetch', act: 'fetch-prices' },
    html: `
      <section>
        ${slimRow({
    act: 'price-source', icon: ICON.prices,
    title: `${esc(s.priceCity)} · ${esc(serverName(s.server))}`,
    right: amt(`${setCount}/${all.length}`, { tone: 'flat' }) + go(),
  })}
        <div class="field" style="margin-top:8px">
          <input type="search" placeholder="Find an item…" data-price-search value="${esc(priceQuery)}" autocomplete="off">
        </div>
        <div class="tabs">
          <button data-price-filter="used" aria-pressed="${priceFilter === 'used'}">In my plan</button>
          <button data-price-filter="missing" aria-pressed="${priceFilter === 'missing'}">Missing</button>
          <button data-price-filter="all" aria-pressed="${priceFilter === 'all'}">All</button>
        </div>
      </section>
      ${setCount === 0 ? `
        <div class="empty"><span class="e">\u{1F3EA}</span>No prices yet.<br>Fetch the cheapest
          sell orders in ${esc(s.priceCity)}, then every screen has real numbers.
          <button class="btn primary" data-act="fetch-prices">↓ Fetch live market prices</button></div>` : ''}
      <div id="priceList">${priceListHTML()}</div>`,
    mount(root) {
      const box = root.querySelector('[data-price-search]');
      if (!box) return;
      box.oninput = () => {
        setPriceQuery(box.value);
        root.querySelector('#priceList').innerHTML = priceListHTML();
      };
    },
  };
}

const CAT_LABELS = {
  crop: 'Crops', herb: 'Herbs', seed: 'Seeds', product: 'Eggs & milk',
  baby: 'Baby animals', animal: 'Grown animals', potion: 'Potions',
  food: 'Food', raw: 'Gathered resources', refined: 'Refined materials',
  journal: 'Journals', material: 'Other materials', other: 'Other',
};
const catLabel = (c) => CAT_LABELS[c] || c;

const pricedIds = () => pricedItemIds(DATA);

function planItemIds() {
  const ids = new Set();
  for (const row of state.plan.plots) {
    const p = DATA.plants.find((x) => x.id === row.itemId);
    if (p) { ids.add(p.seedId); ids.add(p.cropId); continue; }
    const a = DATA.animals.find((x) => x.id === row.itemId);
    if (!a) continue;
    ids.add(a.babyId); ids.add(a.grownId);
    if (a.product) ids.add(a.product.itemId);
    ids.add(feedFor(a, state.settings).id);
  }
  for (const job of state.plan.crafts) {
    const r = DATA.recipes.find((x) => x.id === job.recipeId);
    if (!r) continue;
    ids.add(r.id);
    for (const i of r.inputs) ids.add(i.id);
  }
  return [...ids];
}

export { pricedIds, planItemIds };

/* ============================================================= MATHS ==== */

/** A breakdown screen so no number in this app is a black box. */
export function detailHTML(cycle, rate) {
  const s = state.settings;
  const rows = [];
  const line = (k, v, cls = '') => rows.push(
    `<div class="bar-row"><span class="n">${esc(k)}</span>
      <span class="v num ${cls}">${v}</span></div>`);

  if (cycle.kind === 'plant') {
    const p = cycle.ref;
    line('Per tile, per harvest', `${round1(cycle.yieldPerTile)} ${nameOf(p.cropId)}`);
    line('Per 3\u00d73 plot', `${round1(cycle.yieldPerTile * 9)} ${nameOf(p.cropId)}`);
    if (cycle.farmBonusPct) {
      line(`${cycle.city.name} farming bonus`, `+${cycle.farmBonusPct}% yield`, 'good');
    }
    line('Sale after tax', short(cycle.revenue), 'good');
    line(`Seeds back (${s.watered ? 'watered' : 'dry'})`, pct(cycle.seedsBack, 0));
    if (cycle.seedsBought > 0) {
      line('Seeds to buy per tile', `${round1(cycle.seedsBought)} \u00d7 ${nameOf(p.seedId)}`, 'bad');
    } else {
      line('Spare seeds per tile', `${round1(cycle.seedSurplus)} \u00d7 ${nameOf(p.seedId)}`, 'good');
    }
    if (cycle.focus) line('Focus to water', short(cycle.focus));
    line('Cost per unit grown', short(cycle.costPerUnit));
  } else if (cycle.kind === 'animal') {
    const a = cycle.ref;
    line('Feed needed', `${round1(cycle.plantsNeeded)} × ${nameOf(cycle.feedId)}`);
    line('Feed cost', short(-cycle.feedCost), 'bad');
    line(`Babies back (${s.watered ? 'nurtured' : 'not nurtured'})`, pct(cycle.babiesBack, 0));
    line(cycle.babyCost >= 0 ? 'Baby cost' : 'Spare babies',
      short(-cycle.babyCost), cycle.babyCost >= 0 ? 'bad' : 'good');
    line('Sale after tax', short(cycle.revenue), 'good');
    if (cycle.focus) line('Focus to nurture', short(cycle.focus));
  } else if (cycle.kind === 'product') {
    line('Per harvest', `${round1(cycle.perCycle)} × ${nameOf(cycle.ref.product.itemId)}`);
    if (cycle.farmBonusPct) {
      line(`${cycle.city.name} farming bonus`, `+${cycle.farmBonusPct}% yield`, 'good');
    }
    line('Sale after tax', short(cycle.revenue), 'good');
    line('Upkeep feed', `${round1(cycle.plantsNeeded)} × ${nameOf(cycle.feedId)}`);
    line('Feed cost', short(-cycle.feedCost), 'bad');
  } else if (cycle.kind === 'craft') {
    for (const i of cycle.inputs) {
      line(`${i.count} × ${nameOf(i.id)}`, short(-i.total), 'bad');
    }
    line('Materials', short(-cycle.materials), 'bad');
    if (cycle.city) {
      line(`In ${cycle.city.name}`, cycle.bonus.specialises
        ? `+${cycle.bonus.base} base, +${cycle.bonus.specialty} specialty`
        : `+${cycle.bonus.base} base, no specialty`);
    }
    if (cycle.focus) line('Focus bonus', `+${s.focusCraftBonus}`);
    if (cycle.ref.returnProduct) {
      // The animal is never handed back, so the rate is paid in extra meat.
      line(`Product yield (+${pct(cycle.rrr)})`,
        `${round1(cycle.made)} not ${cycle.ref.amount}`, 'good');
    } else {
      line(`Returned (${pct(cycle.rrr)})`, short(cycle.materials - cycle.materialsAfterReturn), 'good');
    }
    line('Net materials', short(-cycle.materialsAfterReturn), 'bad');
    if (cycle.fees) line('Fees', short(-cycle.fees), 'bad');
    line(`Sale of ${round1(cycle.made)} after tax`, short(cycle.revenue), 'good');
    if (cycle.focus) line(`Focus at ${cycle.spec} mastery`, short(cycle.focus));
    if (cycle.silverPerFocus != null) line('Silver per focus', short(cycle.silverPerFocus), 'good');
  }

  const profit = cycle.profit;
  return `
    <div class="card">${rows.join('')}
      <div class="bar-row total"><span class="n">Profit${cycle.kind === 'craft' ? ' per craft' : ' per cycle'}</span>
        <span class="v num ${toneOf(profit)}">${short(profit)}</span></div>
      ${rate ? `<div class="bar-row"><span class="n">Per month</span>
        <span class="v num ${toneOf(rate.perMonth)}">${short(rate.perMonth)}</span></div>` : ''}
    </div>`;
}

export function cycleFor(itemId, mode, cityId) {
  const c = { ...ctx(), cityId };
  const p = DATA.plants.find((x) => x.id === itemId);
  if (p) return plantCycle(p, c);
  const a = DATA.animals.find((x) => x.id === itemId);
  if (!a) return null;
  return mode === 'product' ? productCycle(a, c) : animalCycle(a, c);
}

/* ------------------------------------------------------------- earn ---- */

/* Three questions, one screen. They were three tabs, which made you decide
 * which of them you were asking before you could ask it — and they all answer
 * the same thing, which is where the money is. */
export const views = { plan, craft, rank, prices, me };

const round1 = (n) => String(Math.round(n * 10) / 10);


/**
 * What the farm grew and the crafting could not get through.
 *
 * These are not sold: you hold them and work through them over the cycles that
 * follow. The useful figure is the ratio, because a farm running well ahead of
 * its crafting is one you will eventually have to stop and let drain.
 */
function stockCard(sim) {
  if (!sim.stock.length && !sim.balance.length) return '';
  const over = sim.balance
    .filter((b) => Number.isFinite(b.ratio) && b.ratio > 1.15)
    .sort((a, b) => b.ratio - a.ratio);
  const unused = sim.balance.filter((b) => !Number.isFinite(b.ratio));
  const held = sim.stock.filter((x) => x.qty >= 1).slice(0, 8);

  return `
    <div class="section-head"><h2>Leftovers</h2>
      <span class="right num flat">${short(sim.stockValue)} held</span></div>
    <div class="card">
      ${held.length
        ? held.map((x) => `
          <div class="bar-row"><span class="n">${round1(x.qty)} \u00d7 ${esc(nameOf(x.id))}</span>
            <span class="v num">${short(x.value)}</span></div>`).join('')
        : '<div class="bar-row"><span class="n">Nothing left over, the crafting kept up.</span></div>'}
      ${note('Held, not sold. What they cost is already taken out above.')}
    </div>
      ${over.length || unused.length ? `
        <div class="card" style="margin-top:10px">
          ${sim.balance.map((b) => {
            const label = Number.isFinite(b.ratio)
              ? `${b.ratio.toFixed(1)}\u00d7 what you use`
              : 'nothing uses it';
            const cls = !Number.isFinite(b.ratio) || b.ratio > 1.15 ? 'bad'
              : b.ratio < 0.85 ? '' : 'good';
            return `
              <div class="bar-row">
                <span class="n">${esc(nameOf(b.itemId))}</span>
                <span class="v num ${cls}">${label}</span>
              </div>`;
          }).join('')}
          ${over.map((b) => `
            <div class="warn-note">${esc(nameOf(b.itemId))}: ${short(b.made)} grown,
              ${short(b.used)} used, <b>${short(b.leftover)} left over a cycle</b>.
              ${b.balancedPlots >= 0.5
                ? `About <b>${b.balancedPlots.toFixed(1)} plots</b> would match your
                   crafting, against the ${b.plots} you run.`
                : `Less than half a plot would match your crafting, against the
                   ${b.plots} you run.`}
              ${b.cyclesToCap
                ? `At that rate you pass ${short(sim.stockCap)} spare
                   ${b.cyclesToCap === 1 ? 'within one cycle' : `after ${b.cyclesToCap} cycles`},
                   which is when you would pause it.`
                : ''}</div>`).join('')}
          ${unused.map((b) => `
            <div class="warn-note">Nothing in your plan uses ${esc(nameOf(b.itemId))},
              so all ${short(b.made)} of it just accumulates. Sell it, craft with it,
              or grow less.</div>`).join('')}
        </div>` : ''}`;
}
