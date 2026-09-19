// The solver. You say which potion you want and how many plots you have; this
// works out what to plant, how often to go out, when to stop farming and let
// focus bank, and how much to brew at the end of it.
//
// Pure, like calc.js: game data + prices + settings in, a plan out. It leans
// on simulateCycle for every judgement so the recommendation and the figures
// on the Plan screen can never disagree — the solver only ever proposes, the
// simulator always scores.

import {
  PLOTS, TILES_PER_PLOT, cityBonus, cityFor, farmDayCount, focusCostAt,
  focusLedger, focusPerDayOf, harvestsFor, plotKindOf, returnRate, rowCycle,
  rowOutput, simulateCycle, specFor,
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

/**
 * Which sort of plot each growable ingredient needs.
 *
 * Worth knowing separately from the allocation, because "you own no Farms and
 * this potion is made of herbs" is a different answer from "it was cheaper to
 * buy them", and the two look identical once the plan comes out.
 */
export function landNeeds(chain, data, ctx, out = new Map()) {
  for (const inp of chain.inputs) {
    if (inp.sub) landNeeds(inp.sub, data, ctx, out);
    if (!inp.farm) continue;
    const probe = rowCycle(
      { itemId: inp.farm.itemId, mode: inp.farm.mode, cityId: ctx.settings.farmCity },
      data, ctx, 1);
    if (probe) out.set(inp.itemId, plotKindOf(probe));
  }
  return out;
}

/* ------------------------------------------------------ requirements --- */

const rrrFor = (recipe, useFocus, settings) => returnRate(
  cityBonus(cityFor(settings), recipe.category, settings).total
  + (useFocus ? settings.focusCraftBonus : 0));

/**
 * How many items one craft really makes. Butchering pays its return rate out
 * in product rather than in resources, so a cow yields more than the 18 cuts
 * the recipe names \u2014 see craftBatch, which is where that reading is set out.
 */
const madeBy = (recipe, useFocus, settings) => recipe.amount
  * (recipe.returnProduct ? 1 + rrrFor(recipe, useFocus, settings) : 1);

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
      // An input the game never returns is needed in full, however much focus
      // goes into the craft.
      const need = multiplier * inp.count * (inp.noReturn ? 1 : 1 - rrr);
      const mode = assign[inp.itemId] || 'buy';
      if ((mode === 'craft' || mode === 'craftNoFocus') && inp.sub) {
        const subFocus = mode === 'craft';
        walk(inp.sub, need / madeBy(inp.sub.recipe, subFocus, settings), subFocus);
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
 * Your actual land, as something the allocator can spend down.
 *
 * A holding is so many plots of one sort in one city: six Farms in Martlock,
 * two Pastures on a guild island in Fort Sterling. Pools are keyed by sort and
 * city, and the sort "any" is the pool used when you have not told the app what
 * you own \u2014 one undifferentiated heap, which is how it behaved before.
 */
export function capacityOf(holdings) {
  const cap = {};
  for (const h of holdings || []) {
    const kind = KNOWN_POOLS.has(h.kind) ? h.kind : 'farm';
    const n = Math.max(0, Math.round(Number(h.count)) || 0);
    if (!n) continue;
    const key = `${kind}:${h.cityId}`;
    cap[key] = (cap[key] || 0) + n;
  }
  return cap;
}

export const totalPlots = (holdings) => (holdings || [])
  .reduce((t, h) => t + Math.max(0, Math.round(Number(h.count)) || 0), 0);

/**
 * The four buildings, plus the looser sorts a farm may have been described
 * with before the app told them apart: "plant" is a Farm or a Herb Garden,
 * "animal" is a Pasture or a Kennel, and "any" is a plot that grows anything.
 */
const KNOWN_POOLS = new Set([
  ...PLOTS, 'plant', 'animal', 'any',
]);

const LOOSER = {
  farm: 'plant', herbgarden: 'plant',
  pasture: 'animal', kennel: 'animal',
};

/** A herb row draws on a Herb Garden first, then on anything vaguer. */
const poolsFor = (kind) => [kind, LOOSER[kind], 'any'].filter(Boolean);

export const cityOfPool = (key) => key.slice(key.indexOf(':') + 1);

/**
 * Whole plots, handed out one at a time to whichever ingredient is currently
 * furthest behind, and taken from the best city that still has one free.
 *
 * A batch is only as big as its scarcest ingredient, so the plot that helps
 * most is always the one going to the current bottleneck. Rounding each row
 * separately gets this badly wrong when the ratios are lopsided: with twelve
 * plots and foxglove wanting seven times the land of the eggs, a rounded-down
 * egg row caps the whole batch while the surplus foxglove just piles up.
 *
 * Which city a plot comes from matters because some cities grow some things
 * ten percent better, and that bonus is per crop \u2014 Martlock favours foxglove
 * and potatoes, Lymhurst favours geese. Each plot goes wherever it is worth
 * most, and a crop spills into a second city once the first runs out.
 *
 * `targetCrafts` stops the handout early when focus, not land, is the real
 * limit: those spare plots are better off growing something else entirely.
 */
export function allocateAcrossFarm(leaves, cap, targetCrafts = Infinity) {
  const free = { ...cap };
  const got = leaves.map(() => ({}));    // leaf -> { city: plots }
  const made = leaves.map(() => 0);      // units of the ingredient produced

  const supported = (i) => (leaves[i].need > 0 ? made[i] / leaves[i].need : Infinity);

  // The best plot this leaf could still be given, anywhere.
  const bestPool = (i) => {
    let best = null;
    for (const kind of poolsFor(leaves[i].kind)) {
      for (const [key, n] of Object.entries(free)) {
        if (n <= 0 || !key.startsWith(`${kind}:`)) continue;
        const city = cityOfPool(key);
        const per = leaves[i].perPlotByCity[city] || 0;
        if (per <= 0) continue;
        if (!best || per > best.per) best = { key, city, per };
      }
    }
    return best;
  };

  for (;;) {
    let pick = -1;
    let pool = null;
    for (let i = 0; i < leaves.length; i++) {
      if (!(leaves[i].need > 0)) continue;
      if (supported(i) >= targetCrafts) continue;
      if (pick >= 0 && supported(i) >= supported(pick)) continue;
      const p = bestPool(i);
      if (!p) continue;
      pick = i;
      pool = p;
    }
    if (pick < 0) break;
    got[pick][pool.city] = (got[pick][pool.city] || 0) + 1;
    free[pool.key] -= 1;
    made[pick] += pool.per;
  }
  return { got, made, free };
}


/** The best thing to do with plots the chain does not need. */
export function bestCashCrop(data, ctx, sched, exclude = new Set(), free = null) {
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
    const probe = rowCycle({ ...row, cityId: s.farmCity }, data, ctx, 1);
    if (!probe) continue;
    const kind = plotKindOf(probe);
    // Only somewhere you actually have room for this sort of thing. A pasture
    // going spare is no use to a herb, however well herbs pay.
    for (const [city, plots] of Object.entries(spareBy(free, kind, s.farmCity))) {
      if (plots <= 0) continue;
      const at = { ...row, cityId: city };
      const cycle = rowCycle(at, data, ctx, 1);
      if (!cycle) continue;
      const out = rowOutput(at, cycle, data);
      // A crop nobody has priced looks free and worthless at the same time;
      // never recommend one on the strength of a missing number.
      if (!out || !ctx.priceOf(out.itemId)) continue;
      // The same goes for what it costs to start. Ten of the babies the game
      // ships have no merchant ask \u2014 every kennel animal and two stags \u2014 and
      // no meat is priced out of the box, so a direbear whose output you have
      // priced and whose input you have not reads as pure profit.
      if (unpricedInput(cycle, ctx)) continue;
      const perPlot = cycle.profit * tiles * harvestsFor(cycle, sched);
      if (!Number.isFinite(perPlot)) continue;
      if (!best || perPlot > best.perPlot) {
        best = { ...at, kind, perPlot, cycle, plots };
      }
    }
  }
  return best && best.perPlot > 0 ? best : null;
}

/**
 * Is anything this row has to buy still missing a price? A zero there is not a
 * free input, it is a number nobody has filled in, and it makes the row look
 * better than anything you could really grow.
 */
function unpricedInput(cycle, ctx) {
  const cost = ctx.costOf || ctx.priceOf;
  const needs = cycle.kind === 'plant'
    ? [cycle.ref.seedId]
    : [cycle.feedId, cycle.kind === 'animal' ? cycle.ref.babyId : null];
  return needs.some((id) => id && !cost(id));
}

/** Which cities have a free plot of this sort, after the chain has taken its share. */
function spareBy(free, kind, fallbackCity) {
  if (!free) return { [fallbackCity]: Infinity };
  const out = {};
  for (const key of [...poolsFor(kind)]) {
    for (const [k, n] of Object.entries(free)) {
      if (n <= 0 || !k.startsWith(`${key}:`)) continue;
      const city = cityOfPool(k);
      out[city] = (out[city] || 0) + n;
    }
  }
  return out;
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
export function buildPlan(chain, assign, data, ctx, sched, budget, withFiller = false,
  cap = null) {
  const s = ctx.settings;
  const { raw, jobs, focusPer } = requirements(chain, assign, s);
  const tiles = s.tilesPerPlot || TILES_PER_PLOT;
  // Told nothing about your land, treat it as one undifferentiated heap in your
  // default city, which is how it worked before there was anywhere to say.
  const capacity = cap || { [`any:${s.farmCity}`]: budget };
  const cities = [...new Set(Object.keys(capacity).map(cityOfPool))];

  // Every leaf we grow ourselves, with what one plot of it yields in each city
  // you have land in \u2014 a crop is worth ten percent more in the city that
  // favours it, and that is the whole reason to care where a plot is.
  const farmed = [];
  const bought = [];
  for (const [itemId, at] of raw) {
    const mode = assign[itemId] || 'buy';
    if (mode !== 'farm' || !at.node.farm) { bought.push({ itemId, need: at.need }); continue; }
    const src = at.node.farm;
    const row = { itemId: src.itemId, mode: src.mode, cityId: s.farmCity };
    const probe = rowCycle(row, data, ctx, 1);
    const out = probe ? rowOutput(row, probe, data) : null;
    if (!out) { bought.push({ itemId, need: at.need }); continue; }
    const kind = plotKindOf(probe);
    const harvests = harvestsFor(probe, sched);

    const perPlotByCity = {};
    for (const city of cities) {
      const here = rowCycle({ ...row, cityId: city }, data, ctx, 1);
      const yield_ = here ? rowOutput({ ...row, cityId: city }, here, data) : null;
      if (yield_) perPlotByCity[city] = yield_.perTile * tiles * harvests;
    }
    if (!Object.values(perPlotByCity).some((v) => v > 0)) {
      bought.push({ itemId, need: at.need });
      continue;
    }
    farmed.push({ itemId, need: at.need, row, cycle: probe, kind, perPlotByCity });
  }

  // What the whole cycle can put into crafting, spending focus as it arrives
  // rather than sitting on it: the same measure simulateCycle uses. Watering
  // is paid first, out of the bank, on the days you are actually farming.
  const ledgerAt = (wateringPerDay) => {
    const banked = focusLedger({
      cycleDays: sched.cycleDays, farmDays: sched.farmDays, farmEvery: sched.farmEvery,
      perDay: focusPerDayOf(s), cap: s.focusCap, start: s.startFocus || 0, wateringPerDay,
    });
    const gross = (s.startFocus || 0) + sched.cycleDays * focusPerDayOf(s);
    return Math.max(0, gross - banked.spentWatering);
  };

  const craftsFrom = (focusAvail) => (focusPer > 0 ? focusAvail / focusPer : Infinity);
  const spread = (focusAvail) =>
    allocateAcrossFarm(farmed, capacity, craftsFrom(focusAvail));

  // Watering spends the same focus the crafting wants, so the budget has to be
  // worked out twice: once ignoring it, then again once the farm it implies is
  // known.
  let focusAvail = ledgerAt(0);
  let spent = spread(focusAvail);
  if (s.watered && farmed.length) {
    // A row's focus is the cost of one growth, so bill it per growth the row
    // completes and spread that over the days you actually farm \u2014 the same
    // measure simulateCycle uses.
    const careDays = Math.max(1, farmDayCount(sched.farmDays, sched.farmEvery));
    const careTotal = farmed.reduce((t, f, i) => t
      + (f.cycle.focus || 0) * tiles * harvestsFor(f.cycle, sched)
        * Object.values(spent.got[i]).reduce((a, b) => a + b, 0), 0);
    focusAvail = ledgerAt(careTotal / careDays);
    spent = spread(focusAvail);
  }

  // One row per crop per city, because a crop that spills into a second city is
  // two different yields and has to be two lines you can see.
  const rows = [];
  farmed.forEach((f, i) => {
    for (const [city, count] of Object.entries(spent.got[i])) {
      if (count > 0) rows.push({ id: uid(), ...f.row, cityId: city, count });
    }
  });

  // Anything the chain does not need is idle land. The cash crop that could use
  // it is worked out separately and only added once the calendar is settled:
  // letting it into the search would tune the cycle to the filler rather than
  // to the potion you actually asked about.
  const used = rows.reduce((t, r) => t + r.count, 0);
  const spare = Math.max(0, budget - used);
  let filler = null;
  if (withFiller && spare > 0) {
    const exclude = new Set(rows.map((r) => `${r.itemId}:${r.mode}`));
    filler = bestCashCrop(data, ctx, sched, exclude, spent.free);
    if (filler) {
      rows.push({
        id: uid(), itemId: filler.itemId, mode: filler.mode,
        cityId: filler.cityId,
        count: Math.min(spare, Number.isFinite(filler.plots) ? filler.plots : spare),
        filler: true,
      });
    }
  }

  /* How many crafts of the target this shape of plan is actually good for.
   * Land and focus each cap it; an ingredient you buy caps nothing, which is
   * the whole reason buying one can beat growing it. */
  const byLand = farmed.length
    ? Math.min(...farmed.map((f, i) => spent.made[i] / f.need))
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
    /* No city on the job. It used to be stamped with whatever you were
     * crafting in when the plan was solved, and simulateCycle prefers a
     * job's own city to the setting - so a solved plan was welded to that
     * city and changing where you craft did nothing at all. Left off, the
     * job follows the setting, and the job editor can still pin one
     * deliberately. */
    useFocus: j.useFocus,
  }));

  return {
    plan: { plots: rows, crafts },
    farmed, bought, focusPer, filler, targetCrafts,
    chainPlots: used, plotsSpare: spare,
    // What the chain could not use, by sort and city, so idle land can be named.
    freeLand: spent.free,
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
/** Enough to sink any plan that makes none of what you asked for. */
const MISSES_TARGET = 1e12;
const fuss = (sched) => (sched.watered ? 1 : 0) + (sched.farmEvery > 1 ? 1 : 0);
const rankOf = (perDay, sched) =>
  perDay - fuss(sched) * Math.abs(perDay) * FUSS_MARGIN;

function attempt(chain, assign, sched, data, ctx, budget, withFiller = false, cap = null) {
  const c = withSched(ctx, sched);
  const built = buildPlan(chain, assign, data, c, sched, budget, withFiller, cap);
  if (!built) return REJECTED;
  const sim = simulateCycle(built.plan, data, c);
  /* You asked how best to make a thing. A plan that makes none of it is not an
   * answer, however much silver it earns selling the half-built intermediate:
   * left to maximise profit alone the search will happily grow potatoes, brew
   * them into schnapps and sell the schnapps. Penalise those below every plan
   * that does make it, without discarding them, so a question with no good
   * answer still comes back with something to explain. */
  const line = sim.craftLines.find((l) => l.recipe.id === chain.recipe.id);
  const idle = !line || line.crafts <= 0 ? MISSES_TARGET : 0;
  return {
    assign, sched, built, plan: built.plan, sim,
    target: chain.recipe.id,
    score: sim.perDay, rank: rankOf(sim.perDay, sched) - idle,
  };
}

function rescore(cand, plan, data, ctx) {
  const c = withSched(ctx, cand.sched);
  const sim = simulateCycle(plan, data, c);
  /* The same penalty attempt() applies, or the hill climb is ordering plans by
   * a different rule than the one that seeded it \u2014 and will happily shuffle
   * plots off the chain until the plan makes none of what you asked for. */
  const line = cand.target
    ? sim.craftLines.find((l) => l.recipe.id === cand.target) : null;
  const idle = cand.target && (!line || line.crafts <= 0) ? MISSES_TARGET : 0;
  return {
    ...cand, plan, sim,
    score: sim.perDay, rank: rankOf(sim.perDay, cand.sched) - idle,
  };
}

/** Shuffle a plot between rows, or off the plan entirely, while it helps. */
function movePlots(cur, data, ctx, budget, cap = null) {
  let best = cur;
  const n = cur.plan.plots.length;
  const shift = (i, j, d) => cur.plan.plots.map((p, k) => ({
    ...p, count: (p.count || 0) + (k === i ? -d : 0) + (k === j ? d : 0),
  })).filter((p) => p.count > 0);
  const legal = (plots) => fitsOnYourLand(plots, data, ctx, budget, cap);

  for (let i = 0; i < n; i++) {
    if ((cur.plan.plots[i].count || 0) < 1) continue;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const plots = shift(i, j, 1);
      if (!legal(plots)) continue;
      const cand = rescore(best, { ...cur.plan, plots }, data, ctx);
      if (cand.rank > best.rank + 1e-9) best = cand;
    }
    // Give this row one more plot, or take one away and farm less.
    for (const d of [1, -1]) {
      const plots = cur.plan.plots
        .map((p, k) => ({ ...p, count: (p.count || 0) + (k === i ? d : 0) }))
        .filter((p) => p.count > 0);
      if (!legal(plots)) continue;
      const cand = rescore(best, { ...cur.plan, plots }, data, ctx);
      if (cand.rank > best.rank + 1e-9) best = cand;
    }
  }
  return best;
}

/**
 * Could you actually lay this out on the land you have?
 *
 * The hill climb shuffles plots around one at a time, and without this it will
 * happily put a tenth Farm in a city where you own six, or move a pasture's
 * worth of geese onto a herb patch \u2014 improvements you cannot act on.
 */
export function fitsOnYourLand(plots, data, ctx, budget, cap = null) {
  const total = plots.reduce((t, p) => t + (p.count || 0), 0);
  if (!cap) return total <= budget;
  const free = { ...cap };
  for (const row of plots) {
    const cycle = rowCycle(row, data, ctx, 1);
    if (!cycle) continue;
    let left = row.count || 0;
    for (const kind of [plotKindOf(cycle), 'any']) {
      const key = `${kind}:${row.cityId}`;
      const take = Math.min(left, free[key] || 0);
      free[key] = (free[key] || 0) - take;
      left -= take;
      if (left <= 0) break;
    }
    if (left > 0) return false;
  }
  return true;
}

/** Nudge the calendar and the plot counts until nothing helps any more. */
function refine(start, chain, data, ctx, budget, rounds = 10, grid = null) {
  let cur = start;
  for (let round = 0; round < rounds; round++) {
    let next = cur;
    const tries = [];
    for (const d of [-1, 1]) {
      if (!grid?.pinned) tries.push({ ...cur.sched, cycleDays: cur.sched.cycleDays + d });
      tries.push({ ...cur.sched, farmDays: cur.sched.farmDays + d });
    }
    for (const sched of tries) {
      if (sched.cycleDays < 1 || sched.farmDays < 1) continue;
      if (sched.farmDays > sched.cycleDays) continue;
      const cand = attempt(chain, cur.assign, sched, data, ctx, budget, false, grid?.cap);
      if (cand.rank > next.rank + 1e-9) next = cand;
    }
    const moved = movePlots(next, data, ctx, budget, grid?.cap);
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

  const holdings = (opts.holdings || []).filter((h) => (Number(h.count) || 0) > 0);
  const cap = holdings.length ? capacityOf(holdings) : null;
  const budget = holdings.length
    ? totalPlots(holdings)
    : Math.max(0, Math.round(Number(plotBudget)) || 0);
  const s = ctx.settings;
  if (!ctx.priceOf(chain.recipe.id)) {
    return { ok: false, reason: 'no-price', target: chain.recipe };
  }

  // You can pin the cycle to the rhythm you actually play to. Everything else
  // is then solved inside it: which days of it you farm, how often, and how
  // much of the land goes where.
  const pinned = Math.round(Number(opts.cycleDays)) || 0;
  const minCycle = pinned || Math.max(1, opts.minCycleDays || 2);
  const maxCycle = pinned || (opts.maxCycleDays || 21);
  // Idling past the focus cap earns nothing, so a cycle never wants more idle
  // days than it takes to fill the bar. One spare day for rounding.
  const idleMax = Math.ceil((s.focusCap || 30000)
    / Math.max(1, focusPerDayOf(s) || 10000)) + 1;
  const everies = opts.farmEvery || [1, 2, 3];

  // With the length pinned, every day of the cycle is fair game as a farming
  // day: the point of a long cycle is no longer to bank focus, so capping the
  // idle days would hide the shapes that actually suit it.
  const grid = {
    minCycle, maxCycle, everies, pinned: !!pinned, cap,
    idleMax: pinned ? pinned : idleMax,
  };

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
          data, ctx, budget, false, grid.cap);
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
    const tuned = refine(cand, chain, data, ctx, budget, 10, grid);
    if (!best || tuned.rank > best.rank) best = tuned;
  }
  for (let round = 0; round < 3; round++) {
    const again = sweepCalendar(chain, best.assign, data, ctx, budget, grid);
    if (!again.length || again[0].rank <= best.rank + 1e-9) break;
    const tuned = refine(again[0], chain, data, ctx, budget, 10, grid);
    if (tuned.rank <= best.rank + 1e-9) break;
    best = tuned;
  }
  if (opts.fillSpare) best = withFiller(best, chain, data, ctx, budget, grid.cap);

  return describe(best, chain, data, ctx, budget, opts, grid);
}

const schedKey = (x) => `${x.cycleDays}/${x.farmDays}/${x.farmEvery}/${x.watered}`;

/** Score one way of sourcing the chain across every shape of cycle worth trying. */
function sweepCalendar(chain, assign, data, ctx, budget, grid) {   // eslint-disable-line
  const out = [];
  for (const cycleDays of range(grid.minCycle, grid.maxCycle)) {
    for (const farmDays of range(Math.max(1, cycleDays - grid.idleMax), cycleDays)) {
      for (const farmEvery of grid.everies) {
        if (farmEvery > 1 && farmEvery > farmDays) continue;
        // No Premium, no watering: do not search a routine the game refuses.
        for (const watered of (ctx.settings.premium ? [false, true] : [false])) {
          const r = attempt(chain, assign, { cycleDays, farmDays, farmEvery, watered },
            data, ctx, budget, false, grid.cap);
          if (Number.isFinite(r.score)) out.push(r);
        }
      }
    }
  }
  return out.sort((a, b) => b.rank - a.rank);
}

/** Plant whatever the chain left idle, if doing so actually pays. */
function withFiller(cand, chain, data, ctx, budget, cap = null) {
  if (!cand.built || cand.built.plotsSpare <= 0) return cand;
  const withIt = attempt(chain, cand.assign, cand.sched, data, ctx, budget, true, cap);
  return withIt.score > cand.score + 1e-9 ? withIt : cand;
}

/**
 * What the plots the chain does not need are worth, if you planted the best
 * cash crop on them. Kept out of the plan and out of the score: it answers a
 * different question, and it only gets added if you ask for it.
 */
function spareAdvice(cand, chain, data, ctx, budget, cap = null) {
  if (!cand.built || cand.built.plotsSpare <= 0) return null;
  const withIt = attempt(chain, cand.assign, cand.sched, data, ctx, budget, true, cap);
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
  // With the length pinned there is no other length to offer, so the choice on
  // the table becomes how much of that cycle you spend farming.
  const shapes = grid?.pinned
    ? spread(sched.farmDays).filter((d) => d <= sched.cycleDays)
      .map((farmDays) => [sched.cycleDays, farmDays])
    : spread(sched.cycleDays).map((cycleDays) => [cycleDays,
      Math.max(1, Math.min(cycleDays, sched.farmDays + (cycleDays - sched.cycleDays)))]);
  for (const [cycleDays, farmDays] of shapes) {
    for (const farmEvery of [1, 2, 3]) {
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
      const r = attempt(chain, best.assign, alt, data, ctx, budget, false, grid?.cap);
      // Same constraint as the search itself: a calendar that brews none of
      // the thing is not on the table, whatever it earns selling the pieces.
      if (Number.isFinite(r.score) && r.rank > -MISSES_TARGET / 2) {
        alternatives.push({ sched: alt, perDay: r.score });
      }
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
    holdings: (opts.holdings || []).filter((h) => (Number(h.count) || 0) > 0),
    // Ingredients you could have grown, if only you owned the right sort of
    // plot. Being told to buy foxglove reads very differently once you know it
    // is because you have no Farms rather than because buying was cheaper.
    landGaps: landGapsFor(chain, data, ctx, opts.holdings),
    // Plots the chain had no use for, by sort and city. Pastures going spare
    // on a herb plan is worth saying out loud rather than leaving you to
    // notice the totals do not add up.
    idleLand: Object.entries(built.freeLand || {})
      .filter(([, n]) => n > 0)
      .map(([key, n]) => ({ kind: key.slice(0, key.indexOf(':')), city: cityOfPool(key), plots: n }))
      .sort((a, b) => b.plots - a.plots),
    chainPlots,
    fillerPlots,
    plotsIdle: Math.max(0, budget - chainPlots - fillerPlots),
    filler: plan.plots.find((p) => p.filler) || null,
    spare: spareAdvice(best, chain, data, ctx, budget, grid?.cap),
    focusPerTarget: built.focusPer || 0,
    targetCrafts: line?.crafts || 0,
    made: line?.made || 0,
    // What one craft of the target really hands over. Butchering pays its
    // return rate out in product, so it is not always recipe.amount.
    targetMade: line?.batch?.made || chain.recipe.amount,
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
    pinnedCycle: !!grid?.pinned,
    // Calendars that earn the same as the winner, and calendars that earn less.
    ties,
    alternatives: distinct.slice(0, 4),
  };
}

/** Ingredients the chain would grow, if you had anywhere to grow them. */
function landGapsFor(chain, data, ctx, holdings) {
  const owned = (holdings || []).filter((h) => (Number(h.count) || 0) > 0);
  if (!owned.length) return [];
  const have = new Set(owned.map((h) => h.kind));
  // A Herb Garden is covered by owning one, or by having described your land
  // more loosely than the game does.
  const covered = (kind) => poolsFor(kind).some((pool) => have.has(pool));

  const byKind = new Map();
  for (const [itemId, kind] of landNeeds(chain, data, ctx)) {
    if (covered(kind)) continue;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(itemId);
  }
  return [...byKind.entries()].map(([kind, items]) => ({ kind, items }));
}

/** A few cycle lengths either side, for the "what else" list. */
const spread = (n) => [...new Set(
  [n - 3, n - 2, n - 1, n + 1, n + 2, n + 3, n + 7, 14]
    .filter((d) => d >= 1 && d <= 30))];
