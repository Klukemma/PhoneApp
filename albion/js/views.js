// The four screens. Each returns { title, sub, html }.

import {
  animalCycle, cityFor, craftBatch, farmCityFor, perPeriod, plantCycle,
  productCycle, rankFarmables, rankRecipes, returnRate, simulateCycle,
} from './calc.js';
import {
  costOf, DATA, hasOwnCost, landSummary, plotsOwned, priceOf, state,
} from './store.js';
import { serverName } from './prices.js';
import { esc } from './ui.js';
import { hours, pct, short, silver, toneOf } from './util.js';

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
      s.farmCity, s.feedItemId, s.cadenceHours, s.startFocus, s.stockCap,
      s.focusPerDay, s.focusCap, s.sellSurplus, s.hideMounts, s.stationFeePerCraft]),
    goal: JSON.stringify([state.goal.recipeId, state.goal.plots, state.goal.cycleDays]),
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

/** Everything the calculator needs, assembled from the current state. */
export function ctx() {
  return {
    priceOf,
    costOf,
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
  const goal = state.goal;

  const focusPct = sim.focusAtCraft > 0
    ? Math.min(1, sim.focusUsed / sim.focusAtCraft) : 0;
  const idleFocus = sim.focusLeft >= oneCraftOf(sim);

  return {
    title: 'Plan',
    sub: goal.recipeId
      ? `${goal.plots} ${goal.plots === 1 ? 'plot' : 'plots'} · ${
        esc(DATA.recipes.find((r) => r.id === goal.recipeId)?.name || 'pick a potion')}`
      : `${sim.cycleDays}-day cycle · ${sim.farmingDays} ${
        sim.farmingDays === 1 ? 'harvest' : 'harvests'}${
        sim.farmEvery > 1 ? ` every ${sim.farmEvery} days` : ''}, ${sim.idleDays} idle`,
    html: `
      ${goalCard()}

      ${state.plan.plots.length || state.plan.crafts.length ? `
      <section>
        <div class="card hero">
          <div class="label">Profit per cycle</div>
          <div class="amount ${toneOf(sim.profit)} num">${short(sim.profit)}</div>
          <div class="note">${short(sim.perDay)} a day · ${short(sim.perMonth)} per 30 days</div>
          <div class="meter"><i class="spent" style="width:${focusPct * 100}%"></i></div>
          <div class="hero-foot">
            <span class="num">${short(sim.focusUsed)} of ${short(sim.focusAtCraft)} focus spent</span>
            <span class="num ${idleFocus ? 'bad' : ''}">${idleFocus
              ? `${short(sim.focusLeft)} left over` : 'all used'}</span>
          </div>
        </div>
      </section>

      ${routineCard(sim)}
      ${answerCard(sim)}
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

      ${buyCard(sim)}

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
          ${costLines(sim)}
          <div class="bar-row total"><span class="n">Profit for the cycle</span>
            <span class="v num ${toneOf(sim.profit)}">${short(sim.profit)}</span></div>
        </div>
      </section>` : ''}

      ${stockCard(sim)}` : empty(EMOJI.potion,
        'Tell it what you are making and how much land you have, then let it work the rest out.')}`,
  };
}

/* ---------------------------------------------------------- the goal --- */

/** What you are making, with how much land. The front door of the whole app. */
function goalCard() {
  const goal = state.goal;
  const recipe = DATA.recipes.find((r) => r.id === goal.recipeId);
  // The fingerprint outlives the session; the reasoning behind the plan does
  // not. Either is enough to know the plan below is answering old numbers.
  const stamp = (solution?.ok && solution.target.id === goal.recipeId
    ? solution.stamp : null) || goal.stamp;
  const moved = state.plan.plots.length ? changedSince(stamp) : [];
  const line = (key, value) => `
    <button class="goal-line" data-act="goal">
      <span class="k">${key}</span>
      <span class="v${key === 'Make' ? '' : ' num'}">${value}</span>
      <span class="go">\u203A</span>
    </button>`;
  return `
    <section>
      <div class="card goal">
        ${line('Make', recipe ? `T${recipe.tier} ${esc(recipe.name)}` : 'pick a potion')}
        ${landLine()}
        ${line('Every', goal.cycleDays
          ? `${goal.cycleDays} days` : 'as long as it takes')}
        <button class="btn primary" data-act="solve" ${recipe ? '' : 'disabled'}>
          ${state.plan.plots.length ? 'Work it out again' : 'Work it out'}</button>
      </div>
      ${moved.length ? `
        <button class="row warn" data-act="solve" style="margin-top:10px">
          <span class="ico">\u{1F504}</span>
          <span class="body">
            <span class="title">${esc(sentence(moved))} changed since this plan</span>
            <span class="meta">What is below answers the old numbers</span>
          </span>
          <span class="amt" style="color:var(--warn)">Redo</span>
        </button>` : ''}
    </section>`;
}

/**
 * The land line. Once you have described your farm it says what you actually
 * own, because "12 plots" and "6 Farms and 2 Pastures across two cities" lead
 * to very different plans and only one of them is a real farm.
 */
function landLine() {
  const sum = landSummary();
  const total = plotsOwned();
  const bits = [];
  if (sum.farm) bits.push(`${sum.farm} ${sum.farm === 1 ? 'Farm' : 'Farms'}`);
  if (sum.pasture) bits.push(`${sum.pasture} ${sum.pasture === 1 ? 'Pasture' : 'Pastures'}`);
  const what = bits.length
    ? `${bits.join(' · ')}${sum.cities.size > 1 ? `, ${sum.cities.size} cities` : ''}`
    : `${total} ${total === 1 ? 'plot' : 'plots'}`;
  return `
    <button class="goal-line" data-act="land">
      <span class="k">On</span>
      <span class="v num">${esc(what)}</span>
      <span class="go">\u203A</span>
    </button>`;
}

/** "your mastery and prices", rather than a bare comma-separated list. */
function sentence(list) {
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}


/* ------------------------------------------------------- the routine --- */

/**
 * What to actually do, day by day.
 *
 * Read from the simulation rather than from the solver, so it keeps telling
 * the truth after you have moved a plot around by hand.
 */
function routineCard(sim) {
  if (!sim.farmLines.length && !sim.craftLines.length) return '';
  const s = state.settings;
  const steps = [];

  if (sim.farmDays > 0 && sim.farmLines.length) {
    const days = sim.ledger.days.filter((d) => d.farming).map((d) => d.day);
    const when = sim.farmEvery > 1
      ? `days ${days.slice(0, 4).join(', ')}${days.length > 4 ? '…' : ''}`
      : `every day`;
    steps.push({
      when: sim.farmDays === 1 ? 'Day 1' : `Days 1–${sim.farmDays}`,
      what: `Harvest and replant, ${when}`,
      note: `${sim.farmingDays} ${sim.farmingDays === 1 ? 'harvest' : 'harvests'}${
        sim.restDays > 0 ? `, resting the other ${sim.restDays}` : ''}${
        s.watered ? ` · water what you can afford to` : ''}`,
    });
  }

  if (sim.idleDays > 0) {
    steps.push({
      when: sim.idleDays === 1 ? `Day ${sim.cycleDays}`
        : `Days ${sim.farmDays + 1}–${sim.cycleDays}`,
      what: 'Stop farming and let focus bank',
      note: `Focus reaches ${short(sim.focusAtCraft)} by craft day${
        sim.ledger.cappedOn ? `, capping on day ${sim.ledger.cappedOn}` : ''}`,
    });
  }

  // Buying is a thing you have to go and do, so it belongs in the routine and
  // not only in the costs.
  if (sim.buys.length) {
    const list = sim.buys.slice(0, 3)
      .map((b) => `${short(b.qty)} \u00d7 ${nameOf(b.id)}`).join(', ');
    const more = sim.buys.length > 3 ? ` and ${sim.buys.length - 3} more` : '';
    const bill = sim.buys.reduce((t, b) => t + b.cost, 0);
    steps.push({
      when: `Day ${sim.cycleDays}`,
      what: `Buy ${list}${more}`,
      note: `${short(bill)} at the market \u2014 your plots do not grow enough of these`,
    });
  }

  const made = sim.craftLines.filter((l) => l.crafts > 0);
  if (made.length) {
    steps.push({
      when: `Day ${sim.cycleDays}`,
      what: made.map((l) => `${short(l.crafts)}× ${nameOf(l.recipe.id)}`).join(', '),
      note: `${short(sim.focusUsed)} focus · ${short(sim.revenue)} on the market`,
    });
  }

  if (!steps.length) return '';

  /* The question everybody asks: how long should I sit on my focus?
   *
   * Whether the cycle wastes any is what decides the answer, not whether it
   * has idle days in it. A cycle that farms every day and crafts once at the
   * end is still sitting on its focus, and a long one throws most of it away
   * whatever it does with the land. */
  const gap = Math.max(1, sim.ledger.cappedOn
    || Math.round((s.focusCap || 0) / Math.max(1, s.focusPerDay || 1)));
  const banking = sim.ledger.wasted > 0
    ? `Focus fills up on day ${sim.ledger.cappedOn} and then stops:
       ${short(sim.ledger.wasted)} of regeneration is thrown away over this cycle.
       Crafting every ${gap} days instead would use all of it.`
    : sim.idleDays > 0
      ? `Those ${sim.idleDays} idle ${sim.idleDays === 1 ? 'day is' : 'days are'} what
         pays for the batch: focus climbs to ${short(sim.focusAtCraft)} while the farm
         stands still.`
      : `No waiting: focus regenerates ${short(s.focusPerDay)} a day and stops dead at
         ${short(s.focusCap)}, so ${gap} days is the most that is ever worth banking.
         This cycle spends it as fast as it arrives.`;

  return `
    <section>
      <div class="section-head"><h2>Your routine</h2>
        <span class="right num" style="color:var(--dim)">${sim.cycleDays}-day cycle</span></div>
      <div class="card">
        ${steps.map((st) => `
          <div class="step">
            <span class="when">${esc(st.when)}</span>
            <span class="body">
              <span class="what">${esc(st.what)}</span>
              <span class="note">${esc(st.note)}</span>
            </span>
          </div>`).join('')}
        <div class="warn-note" style="color:var(--dim)">${banking}</div>
      </div>
    </section>`;
}

/* -------------------------------------------------- what it worked out - */

const KIND_LABEL = { farm: 'Farm', pasture: 'Pasture' };
const cityName = (id) => (state.settings.cities || [])
  .find((c) => c.id === id)?.name || id;

const LIMIT_NOTE = {
  focus: 'Focus is the wall. More land would only grow produce you cannot brew,'
    + ' so the spare plots are better off earning on their own.',
  plots: 'Land is the wall. Every plot is already feeding the batch, and more'
    + ' of them would turn straight into more potions.',
  materials: 'Neither focus nor land is quite the wall — whole plots do not'
    + ' divide evenly into the recipe, so one ingredient runs out first.',
  nothing: 'Nothing gets made at these prices. Check the ones it is missing.',
};

/** The solver's reasoning, shown until you ask it something else. */
function answerCard(sim) {
  const r = solution;
  if (!r?.ok || r.target.id !== state.goal.recipeId) return '';

  const buys = r.buys.filter((b) => b.perTarget > 0);
  const alt = r.alternatives.filter((a) => a.perDay > 0).slice(0, 3);
  const ties = (r.ties || []).slice(0, 2);
  const gaps = r.landGaps || [];
  const idle = (r.idleLand || []).filter((x) => x.kind !== 'any');
  // The plan is only worth what its prices are worth, so say how complete they are.
  const chainIds = [...new Set([r.target.id, ...r.steps.map((x) => x.itemId)])];
  const priced = {
    total: chainIds.length,
    missing: chainIds.filter((id) => !priceOf(id)).length,
  };
  const shape = (x) => `${x.cycleDays}-day, farm ${x.farmDays}${
    x.farmEvery > 1 ? ` every ${x.farmEvery}` : ''}`;

  return `
    <section>
      <div class="section-head"><h2>Why this plan</h2></div>
      <div class="card">
        ${r.profitable ? '' : `<div class="warn-note">At your prices this loses
          money \u2014 every way of making it that was tried came out
          negative. Check the prices, or make something else.</div>`}
        <div class="bar-row"><span class="n">Potions a cycle</span>
          <span class="v num">${short(r.made)}</span></div>
        <div class="bar-row"><span class="n">Plots on the chain</span>
          <span class="v num">${r.chainPlots} of ${r.budget}</span></div>
        ${r.pinnedCycle ? `<div class="bar-row"><span class="n">Cycle you set</span>
          <span class="v num">${r.sched.cycleDays} days, farming ${r.sched.farmDays}
            </span></div>` : ''}
        <div class="bar-row"><span class="n">Focus per craft, which makes ${r.target.amount}</span>
          <span class="v num">${r.targetFocus ? short(r.focusPerTarget) : 'none'}</span></div>
        <div class="warn-note" style="color:var(--dim)">${esc(LIMIT_NOTE[r.limit] || '')}</div>
        ${r.pinnedCycle && r.sim.ledger.wasted > 0 ? `<div class="warn-note">
          A ${r.sched.cycleDays}-day cycle banks focus it cannot hold: it caps on
          day ${r.sim.ledger.cappedOn} and throws away
          ${short(r.sim.ledger.wasted)} of regeneration. Crafting every
          ${Math.max(1, r.sim.ledger.cappedOn || 1)} days instead would use all of
          it. The plan below is the best this length can do \u2014 it is not the
          best you can do.</div>` : ''}
        ${priced.missing ? `<div class="warn-note">${priced.missing} of the
          ${priced.total} items in this chain have no market price, so the plan
          is built on incomplete numbers. Fetch them and work it out again.</div>`
          : `<div class="warn-note" style="color:var(--dim)">Worked out from
            ${esc(serverName(state.settings.server))} prices in
            ${esc(state.settings.priceCity)}. Fetch them again before you commit
            to a cycle \u2014 a herb doubling in price changes the answer.</div>`}
        ${!r.targetFocus ? `<div class="warn-note" style="color:var(--dim)">
          It brews without focus: your land grows more than the focus you have
          could ever process, and a bigger batch at a worse return rate beats a
          small one at a good rate when the herbs cost you seeds rather than
          silver.</div>` : ''}
        ${gaps.length ? gaps.map((g) => `<div class="warn-note">
          You own no ${esc(KIND_LABEL[g.kind] || g.kind)} plots, so
          ${esc(sentence(g.items.map(nameOf)))} ${g.items.length === 1 ? 'has' : 'have'}
          to be bought however cheap ${g.items.length === 1 ? 'it is' : 'they are'} to grow.
          Building ${g.kind === 'pasture' ? 'a Pasture' : 'a Farm'} would change this plan.
          </div>`).join('') : ''}
        ${buys.length && !gaps.length ? `<div class="warn-note" style="color:var(--dim)">
          Buy rather than grow: ${buys.map((b) => esc(nameOf(b.itemId))).join(', ')}.
          The land pays better under something else.</div>` : ''}
        ${idle.length ? `<div class="warn-note" style="color:var(--dim)">
          Standing empty: ${esc(sentence(idle.map((x) =>
            `${x.plots} ${(KIND_LABEL[x.kind] || x.kind)}${x.plots === 1 ? '' : 's'} in ${
              cityName(x.city)}`)))}. Nothing this potion needs will grow there.</div>` : ''}
      </div>
    </section>

    ${r.spare ? `
    <section>
      <button class="row" data-add-spare="1" style="border-color:var(--gold)">
        <span class="ico">\u{1F331}</span>
        <span class="body">
          <span class="title">${r.spare.plots} spare ${r.spare.plots === 1 ? 'plot' : 'plots'}
            → ${esc(r.spare.ref?.name || nameOf(r.spare.itemId))}</span>
          <span class="meta">The chain does not need them. This is the best they could earn.</span>
        </span>
        <span class="amt good num">+${short(r.spare.perDay)}/d</span>
      </button>
    </section>` : ''}

    ${alt.length || ties.length ? `
    <section>
      <div class="section-head"><h2>Other cycles</h2></div>
      <div class="card">
        ${alt.map((a) => `
          <div class="bar-row">
            <span class="n">${esc(shape(a.sched))}</span>
            <span class="v num" style="color:var(--dim)">${short(a.perDay)}/d</span></div>`).join('')}
        <div class="bar-row total"><span class="n">This plan · ${esc(shape(r.sched))}</span>
          <span class="v num good">${short(r.perDay)}/d</span></div>
        ${ties.length ? `<div class="warn-note" style="color:var(--dim)">
          ${ties.map((t) => esc(shape(t.sched))).join(' and a ')} ${
            ties.length === 1 ? 'earns' : 'earn'} the same. Take whichever suits how
          often you can log in \u2014 this one is just the shortest.</div>` : ''}
      </div>
    </section>` : ''}`;
}

/**
 * The cycle itself: how focus builds, when it caps, and what it is spent on.
 * The warnings are the point — capped focus and unwaterable plots are both
 * silent losses otherwise.
 */
/** What one craft of the cheapest job costs, or infinity if none use focus. */
function oneCraftOf(sim) {
  return Math.min(...sim.craftLines
    .filter((l) => l.batch.focus > 0).map((l) => l.batch.focus), Infinity);
}

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
  // A few focus left over is the remainder of a division, not money on the
  // table. A whole craft's worth of it is.
  if (sim.focusLeft >= oneCraftOf(sim) && sim.craftLines.length) {
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
  // Where a row is only matters when you farm in more than one place.
  const spread = new Set(sim.farmLines.map((l) => l.cycle.city?.id)).size > 1;
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
          cycle.farmBonusPct ? ` · ${cycle.city.name} +${cycle.farmBonusPct}%`
            : spread ? ` · ${cycle.city.name}` : ''}</span>
      </span>
      <span class="amt num ${line.cost > 0 ? 'bad' : 'good'}">${short(-line.cost)}</span>
    </button>`;
}

/**
 * One craft job.
 *
 * The figure is what this step's output actually sold for, so the farm rows
 * above and the craft rows here add up to the profit at the top of the screen.
 * Whether the step was worth doing is a different question, and it goes in the
 * meta line: the margin there counts your own produce at what it cost you to
 * grow, not at what it would have fetched, because you never sold it. A step
 * that only feeds the next one has no figure at all — nothing of it reaches
 * the market, and its cost simply carries forward.
 */
function craftRow(line) {
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
    : limitedBy === 'focus' ? 'focus runs out'
      : line.bought?.length ? 'topped up from the market'
        : `batch set to ${short(job.perCycle || 0)}`;

  const margin = line.feeds
    ? `feeds ${nameOf(line.feeds.id)}`
    : destroys ? `${short(-line.gain)} less than it cost`
      : `${short(line.gain)} over cost`;

  return `
    <button class="row ${crafts === 0 ? 'warn' : ''}" data-craft="${esc(job.id)}">
      <span class="ico">${EMOJI[recipe.category] || EMOJI.potion}</span>
      <span class="body">
        <span class="title">T${recipe.tier} ${esc(recipe.name)} ×${short(made)}</span>
        <span class="meta">${short(crafts)} crafts · ${esc(why)}${
          crafts ? ` · ${esc(margin)}` : ''}</span>
      </span>
      <span class="amt num ${!crafts || !line.terminal ? 'flat'
        : destroys ? 'bad' : 'good'}">${
        !crafts ? '—' : line.terminal ? short(line.revenue) : '→'}</span>
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

/**
 * The costs, itemised. One "Costs" line cannot be checked against anything;
 * three that add up to it can.
 */
function costLines(sim) {
  const parts = [
    ['Seeds, feed and goslings', sim.farmCost],
    ['Bought from the market', sim.buyCost],
    ['Station fees', sim.feeCost],
  ].filter(([, v]) => Math.abs(v) > 0.5);

  if (!parts.length) return '';
  const rows = parts.map(([label, v]) => `
    <div class="bar-row"><span class="n">${esc(label)}</span>
      <span class="v num ${v > 0 ? 'bad' : 'good'}">${short(-v)}</span></div>`).join('');
  // A subtotal only earns its place when there is more than one thing in it.
  const sum = parts.length > 1 ? `
    <div class="bar-row"><span class="n">${sim.cost >= 0 ? 'Costs in all'
      : 'Seed surplus, beyond what the farm cost'}</span>
      <span class="v num ${sim.cost >= 0 ? 'bad' : 'good'}">${short(-sim.cost)}</span></div>` : '';
  return rows + sum;
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

/**
 * What the plan has to go to market for.
 *
 * Without this the only trace of a bought ingredient is a lump in the costs
 * line, which tells you nothing about where it is supposed to come from. Every
 * row is tappable, because a bought ingredient with no price is the fastest
 * way to get a plan that looks better than it is.
 */
function buyCard(sim) {
  if (!sim.buys.length) return '';
  const total = sim.buys.reduce((t, b) => t + b.cost, 0);
  const grown = new Set(sim.farmLines.map((l) => l.itemId));
  return `
    <section>
      <div class="section-head"><h2>Buy · before you craft</h2>
        <span class="right num bad">${short(-total)}</span></div>
      ${sim.buys.map((b) => {
        const unit = priceOf(b.id);
        const why = !unit ? 'no price set, so this is costing you nothing on paper'
          : grown.has(b.id) ? `${silver(unit)} each, topping up what your plots grew`
            : `${silver(unit)} each \u00b7 nothing in your plan grows these`;
        return `
        <button class="row ${unit ? '' : 'warn'}" data-price="${esc(b.id)}">
          <span class="ico">\u{1F6D2}</span>
          <span class="body">
            <span class="title">${short(b.qty)} \u00d7 ${esc(nameOf(b.id))}</span>
            <span class="meta">${why}</span>
          </span>
          <span class="amt num ${unit ? 'bad' : 'flat'}">${
            unit ? short(-b.cost) : '?'}</span>
        </button>`;
      }).join('')}
    </section>`;
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
  const splitCount = all.filter((id) => hasOwnCost(id)).length;

  return {
    title: 'Prices',
    sub: `${setCount} of ${all.length} set · ${state.settings.priceCity}${
      splitCount ? `, ${splitCount} bought in cheaper` : ''}`,
    html: `
      <section>
        <button class="btn primary" data-act="fetch-prices">
          ↓ Fetch live market prices</button>
        <div class="hint centered">The cheapest sell order in
          ${esc(state.settings.priceCity)} on ${esc(serverName(state.settings.server))}
          · <button class="linkish" data-act="price-source">change</button><br>
          Tap any item to set what you pay for it, or to see which city is
          cheapest and which pays best.</div>
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
                  ${priceOf(id) ? silver(priceOf(id)) : 'set'}${hasOwnCost(id)
                    ? `<small style="color:var(--dim);font-weight:500">
                        pay ${silver(costOf(id))}</small>` : ''}</span>
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
