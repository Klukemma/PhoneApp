// The four screens. Each returns { title, sub, html }.

import {
  animalCycle, cityFor, craftBatch, farmCityFor, perPeriod, plantCycle,
  productCycle, rankFarmables, rankRecipes, returnRate, simulateCycle,
} from './calc.js';
import { DATA, priceOf, state } from './store.js';
import { serverName } from './prices.js';
import { esc } from './ui.js';
import { hours, pct, short, silver, toneOf } from './util.js';

export let rankTab = 'farm';
export const setRankTab = (t) => { rankTab = t; };
export let priceFilter = 'used';
export const setPriceFilter = (f) => { priceFilter = f; };

/** Everything the calculator needs, assembled from the current state. */
export function ctx() {
  return {
    priceOf,
    settings: state.settings,
    inputCostOf: state.settings.ownInputsAtCost ? ownCostOf : undefined,
  };
}

/** What a crop costs you to grow, for craft lines fed by your own farm. */
export function ownCostOf(id) {
  const plant = DATA.plants.find((p) => p.cropId === id);
  if (!plant) return priceOf(id);
  return plantCycle(plant, { priceOf, settings: state.settings }).costPerUnit;
}

const nameOf = (id) => DATA.items[id]?.name || id;
const tierOf = (id) => DATA.items[id]?.tier ?? 0;
const label = (id) => `T${tierOf(id)} ${nameOf(id)}`;

const EMOJI = {
  crop: '\u{1F33E}', herb: '\u{1F33F}', livestock: '\u{1F414}', mount: '\u{1F40E}',
  potion: '\u{1F9EA}', food: '\u{1F35E}', product: '\u{1F95A}',
};

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

export function plan() {
  const c = ctx();
  const sim = simulateCycle(state.plan, DATA, c);
  const s = state.settings;
  const unpriced = missingPrices();

  const focusPct = sim.ledger.cap > 0
    ? Math.min(1, sim.focusUsed / sim.ledger.cap) : 0;

  return {
    title: 'Plan',
    sub: `${sim.cycleDays}-day cycle · ${sim.farmingDays} ${
      sim.farmingDays === 1 ? 'harvest' : 'harvests'}${
      sim.farmEvery > 1 ? ` every ${sim.farmEvery} days` : ''}, ${sim.idleDays} idle`,
    html: `
      <section>
        <div class="card hero">
          <div class="label">Profit per cycle</div>
          <div class="amount ${toneOf(sim.profit)} num">${short(sim.profit)}</div>
          <div class="note">${short(sim.perDay)} a day · ${short(sim.perMonth)} per 30 days</div>
          <div class="meter"><i class="spent" style="width:${focusPct * 100}%"></i></div>
          <div class="hero-foot">
            <span class="num">${short(sim.focusUsed)} of ${short(sim.focusAtCraft)} focus spent</span>
            <span class="num ${sim.focusLeft > 0 ? 'bad' : ''}">${sim.focusLeft > 0
              ? `${short(sim.focusLeft)} left over` : 'all used'}</span>
          </div>
        </div>
      </section>

      ${cycleCard(sim)}

      ${unpriced.length ? `
        <section>
          <button class="row warn" data-act="prices">
            <span class="ico">\u26A0\uFE0F</span>
            <span class="body">
              <span class="title">${unpriced.length} item${unpriced.length === 1 ? '' : 's'} in your plan have no price</span>
              <span class="meta">Profit is understated until you set them</span>
            </span>
            <span class="amt">\u203A</span>
          </button>
        </section>` : ''}

      <section>
        <div class="section-head"><h2>Farm · ${sim.farmingDays} ${
          sim.farmingDays === 1 ? 'harvest' : 'harvests'}</h2>
          <button class="right" data-act="add-plot">+ Add</button></div>
        ${sim.farmLines.map((l) => farmRow(l, sim)).join('')
          || empty(EMOJI.crop, 'No plots yet. Add what you are growing.')}
      </section>

      <section>
        <div class="section-head"><h2>Craft · end of cycle</h2>
          <button class="right" data-act="add-craft">+ Add</button></div>
        ${sim.craftLines.map(craftRow).join('')
          || empty(EMOJI.potion, 'No craft jobs. This is usually where the money is.')}
      </section>

      ${sim.sales.length ? `
      <section>
        <div class="section-head"><h2>Sold at the end</h2>
          <span class="right num" style="color:var(--dim)">${short(sim.revenue)}</span></div>
        <div class="card">
          ${sim.sales.slice(0, 10).map((x) => `
            <div class="bar-row"><span class="n">${round1(x.qty)} \u00d7 ${esc(nameOf(x.id))}</span>
              <span class="v num ${x.value ? 'good' : ''}">${short(x.value)}</span></div>`).join('')}
          <div class="bar-row total">
            <span class="n">${sim.cost >= 0 ? 'Costs'
              : 'Seed surplus, beyond what seeds and feed cost'}</span>
            <span class="v num ${sim.cost >= 0 ? 'bad' : 'good'}">${short(-sim.cost)}</span></div>
          <div class="bar-row"><span class="n">Profit for the cycle</span>
            <span class="v num ${toneOf(sim.profit)}">${short(sim.profit)}</span></div>
        </div>
      </section>` : ''}

      ${stockCard(sim)}`,
  };
}

/**
 * The cycle itself: how focus builds, when it caps, and what it is spent on.
 * The warnings are the point — capped focus and unwaterable plots are both
 * silent losses otherwise.
 */
function cycleCard(sim) {
  const s = state.settings;
  const l = sim.ledger;
  const max = Math.max(l.cap, 1);
  const bars = l.days.map((d) => {
    const h = Math.max(3, (d.focus / max) * 100);
    const cls = d.focus >= l.cap ? 'over'
      : d.farming ? 'today' : d.resting ? 'rest' : '';
    const what = d.farming ? 'farming' : d.resting ? 'resting' : 'idle';
    return `<i class="${cls}" style="height:${h}%"
      title="day ${d.day}, ${what}"></i>`;
  }).join('');

  const warn = [];
  if (l.wasted > 0) {
    warn.push(`Focus hits the ${short(l.cap)} cap on day ${l.cappedOn}, so
      ${short(l.wasted)} of regeneration is thrown away. A shorter cycle, or
      watering more plots, would use it.`);
  }
  if (sim.restDays > 0) {
    const free = sim.farmLines.filter((l) => !l.rests).length;
    warn.push(`You skip ${sim.restDays} ${sim.restDays === 1 ? 'day' : 'days'} of
      farming to bank focus, worth ${short(sim.restDays * s.focusPerDay)} more to
      water and craft with.${free
        ? ` ${free} of your rows cost no focus, so they keep producing through
            the rest days anyway.` : ''}`);
  }
  if (sim.wateringShortfall > 0) {
    const pct = Math.round(sim.wateredFraction * 100);
    warn.push(`Watering every plot would cost ${short(sim.wateringPerDay)} focus a
      farming day, and you regenerate ${short(s.focusPerDay)}. Only about
      <b>${pct}%</b> of your plots actually get watered, so only that share earns
      the extra seeds \u2014 the figures above already account for it. Fewer plots,
      or farming less often, would water more of them.`);
  }
  if (sim.focusLeft > 0 && sim.craftLines.length) {
    warn.push(`${short(sim.focusLeft)} focus is left unspent \u2014 your crafting
      ran out of materials first.`);
  }

  return `
    <section>
      <div class="section-head"><h2>The cycle</h2>
        <button class="right" data-act="cycle">Edit</button></div>
      <div class="card">
        <div class="spark">${bars}</div>
        <div class="legend">
          <span>day 1</span>
          <span>green = farming${sim.restDays ? ', teal = resting' : ''}, amber = at the ${short(l.cap)} cap</span>
          <span>day ${sim.cycleDays}</span></div>
        <div class="bar-row" style="margin-top:8px">
          <span class="n">Focus banked by craft day</span>
          <span class="v num">${short(sim.focusAtCraft)}</span></div>
        <div class="bar-row"><span class="n">Spent crafting</span>
          <span class="v num">${short(sim.focusUsed)}</span></div>
        ${warn.map((w) => `<div class="warn-note">${w}</div>`).join('')}
      </div>
    </section>`;
}

function farmRow(line, sim) {
  const { cycle, row, harvests, produced, itemId } = line;
  const ref = cycle.ref;
  const emoji = EMOJI[cycle.kind === 'product' ? 'product' : ref.kind] || '\u{1F331}';
  const what = cycle.kind === 'product'
    ? `${nameOf(ref.product.itemId)} from ${ref.name}` : ref.name;
  return `
    <button class="row" data-plot="${esc(row.id)}">
      <span class="ico">${emoji}</span>
      <span class="body">
        <span class="title">T${ref.tier} ${esc(what)} \u00d7${line.plots} ${
          line.plots === 1 ? 'plot' : 'plots'}</span>
        <span class="meta">${line.tiles} tiles \u2192 ${short(produced)} ${esc(nameOf(itemId))}
          over ${harvests} ${harvests === 1 ? 'harvest' : 'harvests'}${
          !line.rests && sim.restDays ? ' · no focus, so no rest days' : ''}${
          cycle.farmBonusPct ? ` · ${cycle.city.name} +${cycle.farmBonusPct}%` : ''}</span>
      </span>
      <span class="amt num ${line.cost > 0 ? 'bad' : 'good'}">${short(-line.cost)}</span>
    </button>`;
}

function craftRow(line) {
  const { batch, recipe, crafts, made, limitedBy, job, useFocus, bottleneck } = line;
  const destroys = crafts > 0 && batch.profit < 0;

  // Naming the input that ran out is the difference between "materials run
  // out" and knowing what to go and plant, or which step you forgot to add.
  const why = limitedBy === 'materials'
    ? (bottleneck
      ? (bottleneck.have <= 0
        ? `no ${nameOf(bottleneck.id)} at all`
        : `short on ${nameOf(bottleneck.id)}`)
      : 'materials run out')
    : limitedBy === 'focus' ? 'focus runs out' : 'you set the number';

  return `
    <button class="row ${crafts === 0 ? 'warn' : ''}" data-craft="${esc(job.id)}">
      <span class="ico">${EMOJI[recipe.category] || EMOJI.potion}</span>
      <span class="body">
        <span class="title">T${recipe.tier} ${esc(recipe.name)} \u00d7${short(made)}</span>
        <span class="meta">${destroys
          ? 'inputs sell for more than the output'
          : `${short(crafts)} crafts · ${esc(why)} · ${useFocus
            ? `${short(line.focusUsed)} focus` : 'no focus'}`}</span>
      </span>
      <span class="amt num ${crafts ? '' : 'flat'}">${crafts
        ? `${short(batch.profit * crafts)}` : '\u2014'}</span>
    </button>
    ${missingStepRow(line)}`;
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
  return `
    <button class="row" data-add-step="${esc(maker.id)}"
      style="margin-top:6px;border-color:var(--gold)">
      <span class="ico">\u2795</span>
      <span class="body">
        <span class="title">Add ${esc(maker.name)} to your plan</span>
        <span class="meta">Made from ${esc(from)} \u2014 without it this craft has none</span>
      </span>
      <span class="amt" style="color:var(--gold)">Add</span>
    </button>`;
}

function missingPrices() {
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
    add(state.settings.favouriteFood ? a.favouriteFood : state.settings.feedItemId);
  }
  for (const job of state.plan.crafts) {
    const r = DATA.recipes.find((x) => x.id === job.recipeId);
    if (!r) continue;
    add(r.id);
    for (const i of r.inputs) add(i.id);
  }
  return [...need];
}

/* ============================================================== RANK ==== */

export function rank() {
  const c = ctx();
  const s = state.settings;
  return {
    title: 'Best',
    sub: rankTab === 'farm'
      ? `${farmCityFor(s)?.name || '\u2014'} · ${s.watered ? 'watered' : 'unwatered'}`
      : `In ${cityFor(s)?.name || '\u2014'} · ${s.useFocus ? 'with focus' : 'no focus'}`,
    html: `
      <section>
        <div class="seg">
          <button data-rank="farm" aria-pressed="${rankTab === 'farm'}">Farm</button>
          <button data-rank="craft" aria-pressed="${rankTab === 'craft'}">Craft</button>
        </div>
      </section>
      <section>
        <div class="card toggle-card">
          ${rankTab === 'farm' ? `
            <button class="mini" data-toggle="watered" aria-pressed="${s.watered}">
              Water with focus</button>
            <button class="mini" data-toggle="premium" aria-pressed="${s.premium}">
              Premium</button>
            <button class="mini" data-toggle="hideMounts" aria-pressed="${s.hideMounts}">
              Hide mounts</button>
            <button class="mini" data-act="farm-city">
              ${esc(farmCityFor(s)?.name || 'Pick a city')} ▾</button>`
          : `
            <button class="mini" data-toggle="useFocus" aria-pressed="${s.useFocus}">
              Use focus</button>
            <button class="mini" data-act="craft-city">
              ${esc(cityFor(s)?.name || 'Pick a city')} ▾</button>
            <button class="mini" data-toggle="ownInputsAtCost" aria-pressed="${!!s.ownInputsAtCost}">
              Inputs from my farm</button>`}
        </div>
      </section>
      <section>${rankTab === 'farm' ? farmRank(c) : craftRank(c)}</section>`,
  };
}

function farmRank(c) {
  const rows = rankFarmables(DATA, c).map((r) => ({ ...r, missing: missingFor(r.cycle) }));
  const ready = rows.filter((r) => !r.missing.length);
  const notReady = rows.filter((r) => r.missing.length);
  const best = Math.max(...ready.map((r) => Math.abs(r.rate.perDay)), 1);

  const render = ({ cycle, rate, missing }) => {
    const ref = cycle.ref;
    const emoji = EMOJI[cycle.kind === 'product' ? 'product' : ref.kind] || '\u{1F331}';
    const what = cycle.kind === 'product'
      ? `${nameOf(ref.product.itemId)} (${ref.name})` : ref.name;
    const w = (Math.abs(rate.perDay) / best) * 100;
    return `
      <button class="row rank" data-add-plot="${esc(ref.id)}"
        data-mode="${cycle.kind === 'product' ? 'product' : 'grow'}">
        <span class="ico">${emoji}</span>
        <span class="body">
          <span class="title">T${ref.tier} ${esc(what)}</span>
          ${missing.length
            ? `<span class="meta">needs a price for ${esc(missing.map(nameOf).join(', '))}</span>`
            : `<span class="bar"><i class="${toneOf(rate.perDay)}" style="width:${w}%"></i></span>`}
        </span>
        <span class="amt num ${missing.length ? 'flat' : toneOf(rate.perDay)}">
          ${missing.length ? '\u2014' : `${short(rate.perDay)}<small>/plot/day</small>`}</span>
      </button>`;
  };

  if (!rows.length) return empty('\u{1F4CA}', 'No data.');
  return ready.map(render).join('') + (notReady.length ? `
    <div class="section-head" style="margin-top:16px"><h2>Needs prices</h2></div>
    ${notReady.map(render).join('')}` : '');
}

function craftRank(c) {
  const all = rankRecipes(DATA, c).map((b) => ({ b, missing: missingFor(b) }));
  const ready = all.filter((r) => !r.missing.length).slice(0, 40);
  const notReady = all.filter((r) => r.missing.length).slice(0, 30);
  const useFocus = state.settings.useFocus;

  const render = ({ b, missing }) => `
    <button class="row rank" data-add-craft="${esc(b.ref.id)}">
      <span class="ico">${EMOJI[b.ref.category] || EMOJI.potion}</span>
      <span class="body">
        <span class="title">T${b.ref.tier} ${esc(b.ref.name)}</span>
        <span class="meta">${missing.length
          ? `needs a price for ${esc(missing.map(nameOf).join(', '))}`
          : `makes ${b.ref.amount} · ${pct(b.rrr)} returned${useFocus ? ` · ${Math.round(b.focus)} focus` : ''}`}</span>
      </span>
      <span class="amt num ${missing.length ? 'flat' : toneOf(b.profit)}">
        ${missing.length ? '\u2014'
          : useFocus && b.silverPerFocus != null
            ? `${short(b.silverPerFocus)}<small>/focus</small>`
            : `${short(b.profit)}<small>/craft</small>`}
      </span>
    </button>`;

  if (!all.length) return empty('\u{1F9EA}', 'No recipes.');
  return (ready.map(render).join('')
      || '<div class="empty">Set some prices and the best recipes rank here.</div>') +
    (notReady.length ? `
      <div class="section-head" style="margin-top:16px"><h2>Needs prices</h2></div>
      ${notReady.map(render).join('')}` : '');
}

/* ============================================================ PRICES ==== */

export function prices() {
  const all = pricedIds();
  const used = new Set(planItemIds());
  let ids = all;
  if (priceFilter === 'used') ids = all.filter((id) => used.has(id));
  if (priceFilter === 'missing') ids = all.filter((id) => !priceOf(id));

  const groups = new Map();
  for (const id of ids) {
    const cat = DATA.items[id]?.cat || 'other';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(id);
  }
  const ORDER = ['crop', 'herb', 'seed', 'product', 'baby', 'animal', 'potion', 'food', 'material', 'other'];
  const sorted = [...groups.entries()]
    .sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));

  const setCount = all.filter((id) => priceOf(id)).length;

  return {
    title: 'Prices',
    sub: `${setCount} of ${all.length} set · ${state.settings.priceCity}`,
    html: `
      <section>
        <button class="btn primary" data-act="fetch-prices">
          ↓ Fetch live market prices</button>
        <div class="hint centered">From the Albion Online Data Project ·
          ${esc(serverName(state.settings.server))} · ${esc(state.settings.priceCity)}
          · <button class="linkish" data-act="price-source">change</button></div>
      </section>
      <section>
        <div class="seg">
          <button data-price-filter="used" aria-pressed="${priceFilter === 'used'}">In my plan</button>
          <button data-price-filter="missing" aria-pressed="${priceFilter === 'missing'}">Missing</button>
          <button data-price-filter="all" aria-pressed="${priceFilter === 'all'}">All</button>
        </div>
      </section>
      ${sorted.map(([cat, list]) => `
        <section>
          <div class="section-head"><h2>${esc(catLabel(cat))}</h2></div>
          ${list.sort((a, b) => tierOf(a) - tierOf(b) || nameOf(a).localeCompare(nameOf(b)))
            .map((id) => `
              <button class="row price" data-price="${esc(id)}">
                <span class="ico">${EMOJI[DATA.items[id]?.cat] || '\u{1F4E6}'}</span>
                <span class="body">
                  <span class="title">${esc(label(id))}</span>
                  <span class="meta">${esc(id)}</span>
                </span>
                <span class="amt num ${priceOf(id) ? '' : 'flat'}">
                  ${priceOf(id) ? silver(priceOf(id)) : 'set'}</span>
              </button>`).join('')}
        </section>`).join('')
        || empty('\u{1F4B0}', priceFilter === 'missing'
          ? 'Every item in view has a price.' : 'Nothing to price yet.')}`,
  };
}

const CAT_LABELS = {
  crop: 'Crops', herb: 'Herbs', seed: 'Seeds', product: 'Eggs & milk',
  baby: 'Baby animals', animal: 'Grown animals', potion: 'Potions',
  food: 'Food', material: 'Other materials', other: 'Other',
};
const catLabel = (c) => CAT_LABELS[c] || c;

function pricedIds() {
  const ids = new Set();
  for (const p of DATA.plants) { ids.add(p.seedId); ids.add(p.cropId); }
  for (const a of DATA.animals) {
    ids.add(a.babyId); ids.add(a.grownId);
    if (a.product) ids.add(a.product.itemId);
  }
  for (const r of DATA.recipes) {
    ids.add(r.id);
    for (const i of r.inputs) ids.add(i.id);
  }
  return [...ids];
}

function planItemIds() {
  const ids = new Set();
  for (const row of state.plan.plots) {
    const p = DATA.plants.find((x) => x.id === row.itemId);
    if (p) { ids.add(p.seedId); ids.add(p.cropId); continue; }
    const a = DATA.animals.find((x) => x.id === row.itemId);
    if (!a) continue;
    ids.add(a.babyId); ids.add(a.grownId);
    if (a.product) ids.add(a.product.itemId);
    if (a.favouriteFood) ids.add(a.favouriteFood);
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
    line('Feed needed', `${cycle.plantsNeeded} × ${nameOf(cycle.feedId)}`);
    line('Feed cost', short(-cycle.feedCost), 'bad');
    line(`Babies back (${s.watered ? 'watered' : 'dry'})`, pct(cycle.babiesBack, 0));
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
    line('Upkeep feed', `${cycle.plantsNeeded} × ${nameOf(cycle.feedId)}`);
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
    line(`Returned (${pct(cycle.rrr)})`, short(cycle.materials - cycle.materialsAfterReturn), 'good');
    line('Net materials', short(-cycle.materialsAfterReturn), 'bad');
    if (cycle.fees) line('Fees', short(-cycle.fees), 'bad');
    line(`Sale of ${cycle.ref.amount} after tax`, short(cycle.revenue), 'good');
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

export const views = { plan, rank, prices };

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

  return `
    <section>
      <div class="section-head"><h2>Kept for next cycle</h2>
        <span class="right num" style="color:var(--dim)">${short(sim.stockValue)} held</span></div>
      <div class="card">
        ${sim.stock.length
          ? sim.stock.slice(0, 8).map((x) => `
            <div class="bar-row"><span class="n">${round1(x.qty)} \u00d7 ${esc(nameOf(x.id))}</span>
              <span class="v num">${short(x.value)}</span></div>`).join('')
          : '<div class="bar-row"><span class="n">Nothing left over, the crafting kept up.</span></div>'}
        <div style="font-size:11.5px;color:var(--faint);margin-top:8px">
          Ingredients your own crafting uses are not sold. They stay on the pile
          and get worked through later, so they are held here rather than
          counted as profit.
        </div>
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
        </div>` : ''}
    </section>`;
}
