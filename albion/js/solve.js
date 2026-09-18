// The solver. You say which potion you want and how many plots you have; this
// works out what to plant, how often to go out, when to stop farming and let
// focus bank, and how much to brew at the end of it.
//
// Pure, like calc.js: game data + prices + settings in, a plan out. It leans
// on simulateCycle for every judgement so the recommendation and the figures
// on the Plan screen can never disagree — the solver only ever proposes, the
// simulator always scores.

import {
  TILES_PER_PLOT, cityBonus, cityFor, focusCostAt, focusLedger, harvestsFor,
  returnRate, rowCycle, rowOutput, simulateCycle, specFor,
} from './calc.js';
import { uid } from './util.js';

/* ------------------------------------------------------------- chain --- */

/** Every way the game gives you one item: grow it, keep an animal, or craft it. */
export function sourcesFor(itemId, data) {
  const out = [];
  for (const p of data.plants) {
    if (p.cropId === itemId) out.push({ kind: 'plant', itemId: p.id, mode: 'grow', ref: p });
  }
  for (const a of data.animals) {
    if (a.product?.itemId === itemId) out.push({ kind: 'product', itemId: a.id, mode: 'product', ref: a });
    if (a.grownId === itemId) out.push({ kind: 'animal', itemId: a.id, mode: 'grow', ref: a });
  }
  const recipe = data.recipes.find((r) => r.id === itemId);
  if (recipe) out.push({ kind: 'craft', itemId: recipe.id, ref: recipe });
  return out;
}

/**
 * The tree behind one recipe: what it eats, and for anything you could make
 * yourself, what that eats in turn. Two levels covers every potion in the
 * game; the depth cap is there so a recipe that somehow feeds itself cannot
 * spin forever.
 */
export function chainFor(recipeId, data, depth = 0, maxDepth = 3) {
  const recipe = data.recipes.find((r) => r.id === recipeId);
  if (!recipe) return null;
  const inputs = recipe.inputs.map((i) => {
    const srcs = sourcesFor(i.id, data);
    const farm = srcs.find((s) => s.kind !== 'craft') || null;
    const make = depth < maxDepth ? srcs.find((s) => s.kind === 'craft') : null;
    return {
      itemId: i.id, count: i.count, farm, make,
      sub: make ? chainFor(make.itemId, data, depth + 1, maxDepth) : null,
    };
  });
  return { recipe, inputs };
}

/** Flatten the tree to the items you have to decide about. */
export function decisionsOf(chain, out = []) {
  for (const inp of chain.inputs) {
    const choices = [];
    if (inp.farm) choices.push('farm');
    if (inp.make) choices.push('craft', 'craftNoFocus');
    choices.push('buy');
    out.push({ itemId: inp.itemId, choices, node: inp });
    if (inp.sub) decisionsOf(inp.sub, out);
  }
  return out;
}

/**
 * The obvious plan: grow what you can grow, and make intermediates without
 * spending focus on them. Focus is the scarce thing, and it is worth far more
 * on the potion than on the schnapps that goes into it.
 */
export function preferredAssign(chain, assign = {}) {
  for (const inp of chain.inputs) {
    if (inp.make) {
      assign[inp.itemId] = 'craftNoFocus';
      preferredAssign(inp.sub, assign);
    } else {
      assign[inp.itemId] = inp.farm ? 'farm' : 'buy';
    }
  }
  return assign;
}

/** Every combination of those decisions, so the search can price each one. */
export function assignments(chain, cap = 96) {
  let combos = [{}];
  const walk = (node) => {
    for (const inp of node.inputs) {
      const choices = [];
      if (inp.farm) choices.push('farm');
      if (inp.make) choices.push('craft', 'craftNoFocus');
      choices.push('buy');
      const next = [];
      for (const base of combos) {
        for (const ch of choices) next.push({ ...base, [inp.itemId]: ch });
      }
      combos = next.length > cap ? next.slice(0, cap) : next;
      if (inp.sub) walk(inp.sub);
    }
  };
  walk(chain);
  return combos;
}

/* ------------------------------------------------------ requirements --- */

const rrrFor = (recipe, useFocus, settings) => returnRate(
  cityBonus(cityFor(settings), recipe.category, settings).total
  + (useFocus ? settings.focusCraftBonus : 0));

const focusFor = (recipe, settings) =>
  focusCostAt(recipe.focus, specFor(settings, recipe.id), settings.focusCostConstant);

/**
 * What one craft of the target costs you, in raw materials and in focus.
 *
 * The return rate hands part of every input straight back, so the real draw on
 * your farm is count x (1 - RRR). An intermediate you make yourself multiplies
 * its own inputs through the same way, and only adds focus if you chose to
 * spend focus on it.
 */
export function requirements(chain, assign, settings) {
  const raw = new Map();       // itemId -> { need, node }
  const jobs = [];
  let focusPer = 0;

  const walk = (node, multiplier, useFocusHere) => {
    const r = node.recipe;
    const rrr = rrrFor(r, useFocusHere, settings);
    if (useFocusHere) focusPer += multiplier * focusFor(r, settings);
    const already = jobs.find((j) => j.recipeId === r.id);
    if (already) already.multiplier += multiplier;
    else jobs.push({ recipeId: r.id, useFocus: useFocusHere, multiplier });
    for (const inp of node.inputs) {
      const need = multiplier * inp.count * (1 - rrr);
      const mode = assign[inp.itemId] || 'buy';
      if ((mode === 'craft' || mode === 'craftNoFocus') && inp.sub) {
        walk(inp.sub, need / inp.sub.recipe.amount, mode === 'craft');
      } else {
        const at = raw.get(inp.itemId) || { need: 0, node: inp };
        at.need += need;
        raw.set(inp.itemId, at);
      }
    }
  };
  walk(chain, 1, assign.__target !== false);
  return { raw, jobs, focusPer };
}

/* -------------------------------------------------------- allocation --- */

/**
 * Whole plots, handed out one at a time to whichever ingredient is currently
 * furthest behind.
 *
 * A batch is only as big as its scarcest ingredient, so the plot that helps
 * most is always the one going to the current bottleneck. Rounding each row
 * separately gets this badly wrong when the ratios are lopsided: with twelve
 * plots and foxglove wanting seven times the land of the eggs, a rounded-down
 * egg row caps the whole batch while the surplus foxglove just piles up.
 *
 * `wants` is the plots each row needs per craft of the target. `targetCrafts`
 * stops the handout early when focus, not land, is the real limit — those
 * spare plots are better off growing something else entirely.
 */
export function allocateByBottleneck(wants, budget, targetCrafts = Infinity) {
  const counts = wants.map(() => 0);
  if (!wants.length || budget <= 0) return counts;
  const supported = (i) => (wants[i] > 0 ? counts[i] / wants[i] : Infinity);

  for (let n = 0; n < budget; n++) {
    if (wants.every((_, i) => supported(i) >= targetCrafts)) break;
    let worst = -1;
    for (let i = 0; i < wants.length; i++) {
      if (wants[i] <= 0) continue;
      if (worst < 0 || supported(i) < supported(worst)) worst = i;
    }
    if (worst < 0) break;
    counts[worst] += 1;
  }
  return counts;
}

/** The best thing to do with plots the chain does not need. */
export function bestCashCrop(data, ctx, sched, exclude = new Set()) {
  const s = ctx.settings;
  const tiles = s.tilesPerPlot || TILES_PER_PLOT;
  const rows = [];
  for (const p of data.plants) rows.push({ itemId: p.id, mode: 'grow' });
  for (const a of data.animals) {
    if (s.hideMounts && a.kind === 'mount') continue;
    rows.push({ itemId: a.id, mode: 'grow' });
    if (a.product) rows.push({ itemId: a.id, mode: 'product' });
  }
  let best = null;
  for (const row of rows) {
    if (exclude.has(`${row.itemId}:${row.mode}`)) continue;
    const at = { ...row, cityId: s.farmCity };
    const cycle = rowCycle(at, data, ctx, 1);
    if (!cycle) continue;
    const out = rowOutput(at, cycle, data);
    // A crop nobody has priced looks free and worthless at the same time;
    // never recommend one on the strength of a missing number.
    if (!out || !ctx.priceOf(out.itemId)) continue;
    const perPlot = cycle.profit * tiles * harvestsFor(cycle, sched);
    if (!Number.isFinite(perPlot)) continue;
    if (!best || perPlot > best.perPlot) best = { ...at, perPlot, cycle };
  }
  return best && best.perPlot > 0 ? best : null;
}

/**
 * Build a whole plan for one set of choices and one shape of cycle.
 *
 * Focus decides how many crafts you get, crafts decide how much material you
 * need, material decides how many plots — except when the plots run out first,
 * and then it reads the other way round and the plots decide the crafts.
 * Watering muddies it because it spends the same focus, so the focus budget is
 * worked out twice: once ignoring watering, then again once the farm it implies
 * is known.
 */
export function buildPlan(chain, assign, data, ctx, sched, budget, withFiller = false) {
  const s = ctx.settings;
  const { raw, jobs, focusPer } = requirements(chain, assign, s);
  const tiles = s.tilesPerPlot || TILES_PER_PLOT;

  // Every leaf we grow ourselves, with what one plot of it yields per cycle.
  const farmed = [];
  const bought = [];
  for (const [itemId, at] of raw) {
    const mode = assign[itemId] || 'buy';
    if (mode !== 'farm' || !at.node.farm) { bought.push({ itemId, need: at.need }); continue; }
    const src = at.node.farm;
    const row = { itemId: src.itemId, mode: src.mode, cityId: s.farmCity };
    const cycle = rowCycle(row, data, ctx, 1);
    const out = cycle ? rowOutput(row, cycle, data) : null;
    if (!out) { bought.push({ itemId, need: at.need }); continue; }
    const perPlot = out.perTile * tiles * harvestsFor(cycle, sched);
    if (!(perPlot > 0)) { bought.push({ itemId, need: at.need }); continue; }
    farmed.push({ itemId, need: at.need, row, cycle, perPlot, unit: at.need / perPlot });
  }

  const ledgerAt = (wateringPerDay) => focusLedger({
    cycleDays: sched.cycleDays, farmDays: sched.farmDays, farmEvery: sched.farmEvery,
    perDay: s.focusPerDay, cap: s.focusCap, start: s.startFocus || 0, wateringPerDay,
  }).atCraft;

  const units = farmed.map((f) => f.unit);
  const craftsFrom = (focusAvail) => (focusPer > 0 ? focusAvail / focusPer : Infinity);
  const counts = (focusAvail) => allocateByBottleneck(units, budget, craftsFrom(focusAvail));

  // Watering spends the same focus the crafting wants, so the budget has to be
  // worked out twice: once ignoring it, then again once the farm it implies is
  // known.
  let focusAvail = ledgerAt(0);
  let plots = counts(focusAvail);
  if (s.watered && plots.length) {
    const wateringPerDay = farmed.reduce(
      (t, f, i) => t + (f.cycle.focus || 0) * plots[i] * tiles, 0);
    focusAvail = ledgerAt(wateringPerDay);
    plots = counts(focusAvail);
  }

  const rows = farmed
    .map((f, i) => ({ id: uid(), ...f.row, count: plots[i] || 0 }))
    .filter((r) => r.count > 0);

  // Anything the chain does not need is idle land. The cash crop that could use
  // it is worked out separately and only added once the calendar is settled:
  // letting it into the search would tune the cycle to the filler rather than
  // to the potion you actually asked about.
  const used = rows.reduce((t, r) => t + r.count, 0);
  const spare = Math.max(0, budget - used);
  let filler = null;
  if (withFiller && spare > 0) {
    const exclude = new Set(rows.map((r) => `${r.itemId}:${r.mode}`));
    filler = bestCashCrop(data, ctx, sched, exclude);
    if (filler) {
      rows.push({
        id: uid(), itemId: filler.itemId, mode: filler.mode,
        cityId: filler.cityId, count: spare, filler: true,
      });
    }
  }

  /* How many crafts of the target this shape of plan is actually good for.
   * Land and focus each cap it; an ingredient you buy caps nothing, which is
   * the whole reason buying one can beat growing it. */
  const byLand = farmed.length
    ? Math.min(...farmed.map((f, i) => (plots[i] * f.perPlot) / f.need))
    : Infinity;
  const targetCrafts = Math.floor(Math.min(byLand, craftsFrom(focusAvail)));

  // Nothing bounds a plan that grows nothing and spends no focus, so there is
  // no honest number to put on it. Say so rather than invent one.
  if (bought.length && !Number.isFinite(targetCrafts)) return null;

  // With every ingredient grown, leave the jobs on auto so the plan still
  // follows along when you edit a plot count by hand. Once something is bought
  // the batch size has to be stated, because the simulator only tops up a
  // shortfall for a job that says how much it wants.
  const buying = bought.length > 0;
  const crafts = jobs.map((j) => ({
    id: uid(), recipeId: j.recipeId,
    mode: buying ? 'fixed' : 'auto',
    perCycle: buying ? Math.max(0, Math.ceil(targetCrafts * j.multiplier)) : 0,
    cityId: s.craftCity, useFocus: j.useFocus,
  }));

  return {
    plan: { plots: rows, crafts },
    farmed, bought, focusPer, filler, targetCrafts,
    chainPlots: used, plotsSpare: spare,
  };
}

/* ------------------------------------------------------------ search --- */

const withSched = (ctx, sched) => ({
  ...ctx,
  settings: {
    ...ctx.settings,
    cycleDays: sched.cycleDays,
    farmDays: sched.farmDays,
    farmEvery: sched.farmEvery,
    watered: sched.watered,
  },
});

const REJECTED = { score: -Infinity, rank: -Infinity };

/**
 * A plan has to earn its complications.
 *
 * Watering and skipping days both make a routine you have to keep to, and both
 * turn up as winners by a fraction of a percent when the real difference is
 * rounding. Charge them half a percent of the take: anything that clears that
 * is worth doing, anything that does not was noise.
 */
const FUSS_MARGIN = 0.005;
const fuss = (sched) => (sched.watered ? 1 : 0) + (sched.farmEvery > 1 ? 1 : 0);
const rankOf = (perDay, sched) =>
  perDay - fuss(sched) * Math.abs(perDay) * FUSS_MARGIN;

function attempt(chain, assign, sched, data, ctx, budget, withFiller = false) {
  const c = withSched(ctx, sched);
  const built = buildPlan(chain, assign, data, c, sched, budget, withFiller);
  if (!built) return REJECTED;
  const sim = simulateCycle(built.plan, data, c);
  return {
    assign, sched, built, plan: built.plan, sim,
    score: sim.perDay, rank: rankOf(sim.perDay, sched),
  };
}

function rescore(cand, plan, data, ctx) {
  const c = withSched(ctx, cand.sched);
  const sim = simulateCycle(plan, data, c);
  return { ...cand, plan, sim, score: sim.perDay, rank: rankOf(sim.perDay, cand.sched) };
}

/** Shuffle a plot between rows, or off the plan entirely, while it helps. */
function movePlots(cur, data, ctx, budget) {
  let best = cur;
  const n = cur.plan.plots.length;
  const used = cur.plan.plots.reduce((t, p) => t + (p.count || 0), 0);
  const shift = (i, j, d) => cur.plan.plots.map((p, k) => ({
    ...p, count: (p.count || 0) + (k === i ? -d : 0) + (k === j ? d : 0),
  })).filter((p) => p.count > 0);

  for (let i = 0; i < n; i++) {
    if ((cur.plan.plots[i].count || 0) < 1) continue;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const cand = rescore(best, { ...cur.plan, plots: shift(i, j, 1) }, data, ctx);
      if (cand.rank > best.rank + 1e-9) best = cand;
    }
    // Give this row one more plot, or take one away and farm less.
    for (const d of [1, -1]) {
      if (d === 1 && used >= budget) continue;
      const plots = cur.plan.plots
        .map((p, k) => ({ ...p, count: (p.count || 0) + (k === i ? d : 0) }))
        .filter((p) => p.count > 0);
      const cand = rescore(best, { ...cur.plan, plots }, data, ctx);
      if (cand.rank > best.rank + 1e-9) best = cand;
    }
  }
  return best;
}

/** Nudge the calendar and the plot counts until nothing helps any more. */
function refine(start, chain, data, ctx, budget, rounds = 10) {
  let cur = start;
  for (let round = 0; round < rounds; round++) {
    let next = cur;
    const tries = [];
    for (const d of [-1, 1]) {
      tries.push({ ...cur.sched, cycleDays: cur.sched.cycleDays + d });
      tries.push({ ...cur.sched, farmDays: cur.sched.farmDays + d });
    }
    for (const sched of tries) {
      if (sched.cycleDays < 1 || sched.farmDays < 1) continue;
      if (sched.farmDays > sched.cycleDays) continue;
      const cand = attempt(chain, cur.assign, sched, data, ctx, budget);
      if (cand.rank > next.rank + 1e-9) next = cand;
    }
    const moved = movePlots(next, data, ctx, budget);
    if (moved.rank > next.rank + 1e-9) next = moved;
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/**
 * Where the answer actually comes from.
 *
 * Three passes, so the expensive part only runs on plans worth the time:
 * sweep the calendar with the obvious choices, then try every way of sourcing
 * the ingredients on the few calendars that looked best, then fine-tune the
 * finalists a plot and a day at a time.
 *
 * Every pass judges the same thing: what the potion operation earns per day.
 * Land the chain does not need is left out of that entirely and reported
 * separately, because you asked how best to farm this potion, not which crop
 * pays best overall \u2014 letting a cash crop into the score would quietly retune
 * the whole calendar around it.
 */
export function solve(recipeId, plotBudget, data, ctx, opts = {}) {
  const chain = chainFor(recipeId, data);
  if (!chain) return { ok: false, reason: 'unknown-recipe' };

  const budget = Math.max(0, Math.round(Number(plotBudget)) || 0);
  const s = ctx.settings;
  if (!ctx.priceOf(chain.recipe.id)) {
    return { ok: false, reason: 'no-price', target: chain.recipe };
  }

  const minCycle = Math.max(1, opts.minCycleDays || 2);
  const maxCycle = opts.maxCycleDays || 21;
  // Idling past the focus cap earns nothing, so a cycle never wants more idle
  // days than it takes to fill the bar. One spare day for rounding.
  const idleMax = Math.ceil((s.focusCap || 30000) / Math.max(1, s.focusPerDay || 10000)) + 1;
  const everies = opts.farmEvery || [1, 2, 3];

  const grid = { minCycle, maxCycle, idleMax, everies };

  /* Pass one: the calendar, with the obvious way of sourcing everything. */
  const swept = sweepCalendar(chain, preferredAssign(chain), data, ctx, budget, grid);
  if (!swept.length || !Number.isFinite(swept[0].rank)) {
    return { ok: false, reason: 'no-plan', target: chain.recipe };
  }

  /* Pass two: every way of getting the ingredients, on a handful of calendars.
   * They are picked one per cycle length: the top few by score alone all come
   * out within a day of each other, and a two-week batch loses to them for
   * reasons a one-day nudge can never uncover. */
  const combos = assignments(chain);
  const finalists = [];
  const seen = new Set();
  for (const cand of swept) {
    if (seen.has(cand.sched.cycleDays)) continue;
    seen.add(cand.sched.cycleDays);
    let bestHere = cand;
    for (const assign of combos) {
      for (const targetFocus of [true, false]) {
        const r = attempt(chain, { ...assign, __target: targetFocus }, cand.sched,
          data, ctx, budget);
        if (r.rank > bestHere.rank + 1e-9) bestHere = r;
      }
    }
    finalists.push(bestHere);
    if (finalists.length >= (opts.shortlist || 3)) break;
  }

  /* Pass three: tune each finalist, then walk the whole calendar again with
   * the sourcing that won — buying an ingredient instead of growing it frees
   * land, and that can move the best cycle by a week. Repeat until it settles. */
  let best = null;
  for (const cand of finalists) {
    const tuned = refine(cand, chain, data, ctx, budget);
    if (!best || tuned.rank > best.rank) best = tuned;
  }
  for (let round = 0; round < 3; round++) {
    const again = sweepCalendar(chain, best.assign, data, ctx, budget, grid);
    if (!again.length || again[0].rank <= best.rank + 1e-9) break;
    const tuned = refine(again[0], chain, data, ctx, budget);
    if (tuned.rank <= best.rank + 1e-9) break;
    best = tuned;
  }
  if (opts.fillSpare) best = withFiller(best, chain, data, ctx, budget);

  return describe(best, chain, data, ctx, budget, opts, grid);
}

const schedKey = (x) => `${x.cycleDays}/${x.farmDays}/${x.farmEvery}/${x.watered}`;

/** Score one way of sourcing the chain across every shape of cycle worth trying. */
function sweepCalendar(chain, assign, data, ctx, budget, grid) {
  const out = [];
  for (const cycleDays of range(grid.minCycle, grid.maxCycle)) {
    for (const farmDays of range(Math.max(1, cycleDays - grid.idleMax), cycleDays)) {
      for (const farmEvery of grid.everies) {
        if (farmEvery > 1 && farmEvery > farmDays) continue;
        for (const watered of [false, true]) {
          const r = attempt(chain, assign, { cycleDays, farmDays, farmEvery, watered },
            data, ctx, budget);
          if (Number.isFinite(r.score)) out.push(r);
        }
      }
    }
  }
  return out.sort((a, b) => b.rank - a.rank);
}

/** Plant whatever the chain left idle, if doing so actually pays. */
function withFiller(cand, chain, data, ctx, budget) {
  if (!cand.built || cand.built.plotsSpare <= 0) return cand;
  const withIt = attempt(chain, cand.assign, cand.sched, data, ctx, budget, true);
  return withIt.score > cand.score + 1e-9 ? withIt : cand;
}

/**
 * What the plots the chain does not need are worth, if you planted the best
 * cash crop on them. Kept out of the plan and out of the score: it answers a
 * different question, and it only gets added if you ask for it.
 */
function spareAdvice(cand, chain, data, ctx, budget) {
  if (!cand.built || cand.built.plotsSpare <= 0) return null;
  const withIt = attempt(chain, cand.assign, cand.sched, data, ctx, budget, true);
  const row = withIt.built?.filler;
  if (!row || !(withIt.score > cand.score + 1e-9)) return null;
  return {
    itemId: row.itemId, mode: row.mode, ref: row.cycle?.ref || null,
    plots: cand.built.plotsSpare,
    perDay: withIt.score - cand.score,
    plan: withIt.plan,
  };
}

const range = (lo, hi) => {
  const out = [];
  for (let n = Math.max(1, lo); n <= hi; n++) out.push(n);
  return out;
};

/* ------------------------------------------------------------ answer --- */

/** Put the winning plan into words the screen can show without re-deriving it. */
function describe(best, chain, data, ctx, budget, opts = {}, grid = null) {
  const { sim, plan, sched, built } = best;
  const target = chain.recipe;
  const line = sim.craftLines.find((l) => l.recipe.id === target.id) || null;
  const chainPlots = built.chainPlots;
  const fillerPlots = plan.plots
    .filter((p) => p.filler).reduce((t, p) => t + (p.count || 0), 0);

  // What is actually holding the batch back. Land only counts as the wall when
  // the chain has taken the whole budget and still wants more.
  const limit = !line || line.crafts === 0 ? 'nothing'
    : line.limitedBy === 'focus' ? 'focus'
      : chainPlots >= budget ? 'plots' : 'materials';

  const req = requirements(chain, best.assign, ctx.settings);
  const steps = [];
  for (const [itemId, at] of req.raw) {
    steps.push({ itemId, mode: best.assign[itemId] || 'buy', perTarget: at.need });
  }
  for (const job of req.jobs) {
    if (job.recipeId === target.id) continue;
    steps.push({
      itemId: job.recipeId,
      mode: job.useFocus ? 'craft' : 'craftNoFocus',
      perTarget: job.multiplier,
    });
  }

  // What the same farm would earn on other calendars, scored the same way the
  // winner was, so the comparison means something.
  const alternatives = [];
  const inGrid = (cycleDays, farmDays) => !grid
    || (cycleDays >= grid.minCycle && cycleDays <= grid.maxCycle
      && farmDays >= Math.max(1, cycleDays - grid.idleMax) && farmDays <= cycleDays);
  for (const cycleDays of spread(sched.cycleDays)) {
    for (const farmEvery of [1, 2, 3]) {
      const farmDays = Math.max(1, Math.min(cycleDays, sched.farmDays + (cycleDays - sched.cycleDays)));
      if (farmEvery > farmDays) continue;
      // Never offer a calendar the search itself never weighed up. Idling far
      // past the focus cap only ever looks good when the plan is losing money,
      // where the real advice is not to run it at all.
      if (!inGrid(cycleDays, farmDays)) continue;
      const alt = { cycleDays, farmDays, farmEvery, watered: sched.watered };
      if (schedKey(alt) === schedKey(sched)) continue;
      // Only calendars no more demanding than the one recommended. A plan that
      // asks more of you has to clear a margin to win, so listing one here
      // unadjusted would have it appear to beat the very plan it lost to.
      if (fuss(alt) > fuss(sched)) continue;
      const r = attempt(chain, best.assign, alt, data, ctx, budget);
      if (Number.isFinite(r.score)) alternatives.push({ sched: alt, perDay: r.score });
    }
  }
  alternatives.sort((a, b) => b.perDay - a.perDay);
  // Several calendars usually land on the same figure. Keep one of each, so
  // the list offers real choices rather than the same answer three times.
  const distinct = [];
  const bucket = (n) => Math.round(n / Math.max(1, Math.abs(sim.perDay) * 0.01));
  const takenBuckets = new Set([bucket(sim.perDay)]);
  const ties = [];
  for (const a of alternatives) {
    const b = bucket(a.perDay);
    if (b === bucket(sim.perDay)) { if (ties.length < 3) ties.push(a); continue; }
    if (takenBuckets.has(b)) continue;
    takenBuckets.add(b);
    distinct.push(a);
  }

  return {
    ok: true,
    target,
    plan,
    sim,
    sched,
    settingsPatch: {
      cycleDays: sched.cycleDays,
      farmDays: sched.farmDays,
      farmEvery: sched.farmEvery,
      watered: sched.watered,
    },
    assign: best.assign,
    budget,
    chainPlots,
    fillerPlots,
    plotsIdle: Math.max(0, budget - chainPlots - fillerPlots),
    filler: plan.plots.find((p) => p.filler) || null,
    spare: spareAdvice(best, chain, data, ctx, budget),
    focusPerTarget: built.focusPer || 0,
    targetCrafts: line?.crafts || 0,
    made: line?.made || 0,
    targetFocus: best.assign.__target !== false,
    limit,
    bottleneck: line?.bottleneck?.id || null,
    buys: built.bought.map((b) => ({ itemId: b.itemId, perTarget: b.need })),
    steps,
    perCycle: sim.profit,
    perDay: sim.perDay,
    perMonth: sim.perMonth,
    // At these prices the whole operation is a loss. Worth saying outright
    // rather than dressing up the least bad version of it as a plan.
    profitable: sim.perDay > 0,
    // Calendars that earn the same as the winner, and calendars that earn less.
    ties,
    alternatives: distinct.slice(0, 4),
  };
}

/** A few cycle lengths either side, for the "what else" list. */
const spread = (n) => [...new Set(
  [n - 3, n - 2, n - 1, n + 1, n + 2, n + 3, n + 7, 14]
    .filter((d) => d >= 1 && d <= 30))];
