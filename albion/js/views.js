// The four screens. Each returns { title, sub, html }.

import {
  animalCycle, cityFor, craftBatch, perPeriod, planTotals, plantCycle,
  productCycle, rankFarmables, rankRecipes, returnRate,
} from './calc.js';
import { DATA, priceOf, state } from './store.js';
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
  const totals = planTotals(state.plan, DATA, c);
  const unpriced = missingPrices();

  const focusPct = totals.focusBudget > 0
    ? Math.min(1, totals.focusPerDay / totals.focusBudget) : 0;

  return {
    title: 'Plan',
    sub: state.plan.plots.length || state.plan.crafts.length
      ? `${state.plan.plots.length} farm ${state.plan.plots.length === 1 ? 'line' : 'lines'}, ${state.plan.crafts.length} craft`
      : 'Build your farm',
    html: `
      <section>
        <div class="card hero">
          <div class="label">Profit per month</div>
          <div class="amount ${toneOf(totals.perMonth)} num">${short(totals.perMonth)}</div>
          <div class="note">${short(totals.perDay)} a day · ${silver(totals.perMonth)} silver</div>
          <div class="meter"><i class="${totals.focusOver ? 'over' : 'spent'}"
            style="width:${focusPct * 100}%"></i></div>
          <div class="hero-foot">
            <span class="num">${short(totals.focusPerDay)} focus/day</span>
            <span class="num ${totals.focusOver ? 'bad' : ''}">
              ${totals.focusOver ? 'over budget' : `of ${short(totals.focusBudget)}`}</span>
          </div>
          ${totals.focusOver ? `
            <div class="warn-note">You are planning ${short(totals.focusPerDay - totals.focusBudget)}
              more focus a day than you regenerate. Water fewer plots, or craft without focus.</div>` : ''}
        </div>
      </section>

      ${unpriced.length ? `
        <section>
          <button class="row warn" data-act="prices">
            <span class="ico">⚠️</span>
            <span class="body">
              <span class="title">${unpriced.length} item${unpriced.length === 1 ? '' : 's'} in your plan have no price</span>
              <span class="meta">Profit is understated until you set them</span>
            </span>
            <span class="amt">›</span>
          </button>
        </section>` : ''}

      <section>
        <div class="section-head"><h2>Farm</h2>
          <button class="right" data-act="add-plot">+ Add</button></div>
        ${totals.lines.filter((l) => l.cycle.kind !== 'craft').map(planLine).join('')
          || empty(EMOJI.crop, 'No plots yet. Add what you are growing.')}
      </section>

      <section>
        <div class="section-head"><h2>Crafting</h2>
          <button class="right" data-act="add-craft">+ Add</button></div>
        ${totals.lines.filter((l) => l.cycle.kind === 'craft').map(craftLine).join('')
          || empty(EMOJI.potion, 'No craft jobs. This is usually where the money is.')}
      </section>`,
  };
}

function planLine(line) {
  const { cycle, rate, row } = line;
  const ref = cycle.ref;
  const emoji = EMOJI[cycle.kind === 'product' ? 'product' : ref.kind] || '\u{1F331}';
  const what = cycle.kind === 'product'
    ? `${nameOf(ref.product.itemId)} from ${ref.name}`
    : ref.name;
  return `
    <button class="row" data-plot="${esc(row.id)}">
      <span class="ico">${emoji}</span>
      <span class="body">
        <span class="title">T${ref.tier} ${esc(what)} ×${row.count}</span>
        <span class="meta">${short(rate.perCycle)} per ${hours(rate.every)}
          ${cycle.focus ? `· ${short(rate.focusPerDay)} focus/day` : ''}</span>
      </span>
      <span class="amt num ${toneOf(rate.perMonth)}">${short(rate.perMonth)}</span>
    </button>`;
}

function craftLine(line) {
  const { cycle, rate, row } = line;
  const where = cycle.city
    ? `${cycle.city.name}${cycle.bonus.specialises ? ' +bonus' : ''}` : '';
  return `
    <button class="row" data-craft="${esc(row.id)}">
      <span class="ico">${EMOJI[cycle.ref.category] || EMOJI.potion}</span>
      <span class="body">
        <span class="title">T${cycle.ref.tier} ${esc(cycle.ref.name)} ×${row.craftsPerDay}/day</span>
        <span class="meta">${esc(where)} · ${pct(cycle.rrr)} returned${cycle.focus
          ? ` · ${Math.round(cycle.focus)} focus at ${cycle.spec} mastery` : ''}</span>
      </span>
      <span class="amt num ${toneOf(rate.perMonth)}">${short(rate.perMonth)}</span>
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
      ? `Per plot per day · ${s.watered ? 'watered' : 'unwatered'}`
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
              Hide mounts</button>`
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
          ${esc(state.settings.server)} · ${esc(state.settings.priceCity)}
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
    line('Harvest per plot', `${cycle.yieldPerPlot} ${nameOf(p.cropId)}`);
    line('Sale after tax', short(cycle.revenue), 'good');
    line(`Seeds back (${s.watered ? 'watered' : 'dry'})`, pct(cycle.seedsBack, 0));
    line(cycle.seedCost >= 0 ? 'Seed cost' : 'Spare seeds',
      short(-cycle.seedCost), cycle.seedCost >= 0 ? 'bad' : 'good');
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
    line('Per harvest', `${cycle.perCycle} × ${nameOf(cycle.ref.product.itemId)}`);
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

export function cycleFor(itemId, mode) {
  const c = ctx();
  const p = DATA.plants.find((x) => x.id === itemId);
  if (p) return plantCycle(p, c);
  const a = DATA.animals.find((x) => x.id === itemId);
  if (!a) return null;
  return mode === 'product' ? productCycle(a, c) : animalCycle(a, c);
}

export const views = { plan, rank, prices };
