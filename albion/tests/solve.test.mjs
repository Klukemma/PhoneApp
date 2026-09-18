// Run with: npm test  (from the repo root)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  allocateAcrossFarm, assignments, bestCashCrop, buildPlan, capacityOf,
  chainFor, preferredAssign, requirements, solve, sourcesFor, totalPlots,
} from '../js/solve.js';
import {
  cityBonus, cityFor, returnRate, ruleCovers, simulateCycle,
} from '../js/calc.js';

const data = JSON.parse(
  readFileSync(new URL('../data/gamedata.json', import.meta.url), 'utf8'));

// Ballpark Caerleon numbers, so the answers are about the model and not about
// a missing price reading as free.
const PRICES = {
  T6_POTION_HEAL: 2400,
  T6_FOXGLOVE: 260, T6_FARM_FOXGLOVE_SEED: 2200,
  T6_POTATO: 210, T6_FARM_POTATO_SEED: 2000,
  T6_ALCOHOL: 900,
  T5_EGG: 320, T5_FARM_GOOSE_BABY: 1800, T5_FARM_GOOSE_GROWN: 4000,
  T5_CABBAGE: 250, T5_FARM_CABBAGE_SEED: 1400,
  T3_WHEAT: 90,
};

const ctx = (prices = PRICES, over = {}) => ({
  priceOf: (id) => prices[id] ?? 0,
  settings: {
    ...data.constants,
    cities: data.cities, focusNodes: data.focusNodes,
    premium: true, watered: false, favouriteFood: true, useFocus: true,
    craftCity: 'brecilien', farmCity: 'martlock',
    spec: {}, nodeLevels: {}, specLevel: 0,
    cadenceHours: 24, cycleDays: 14, farmDays: 10, farmEvery: 1, startFocus: 0,
    stockCap: 5000, stationFeePerCraft: 0, feedItemId: 'T3_WHEAT', hideMounts: true,
    ...over,
  },
});

const POTION = 'T6_POTION_HEAL';

// Enough of a price list that most recipes have something to work with. A
// missing price is a real answer too, so the ones still left out stay out.
const WIDE_PRICES = { ...PRICES };
for (const r of data.recipes) {
  WIDE_PRICES[r.id] ??= 400 * r.tier;
  for (const i of r.inputs) WIDE_PRICES[i.id] ??= 40 * r.tier;
}
for (const p of data.plants) {
  WIDE_PRICES[p.cropId] ??= 40 * p.tier;
  WIDE_PRICES[p.seedId] ??= 300 * p.tier;
}
for (const a of data.animals) {
  WIDE_PRICES[a.babyId] ??= 300 * a.tier;
  WIDE_PRICES[a.grownId] ??= 700 * a.tier;
  if (a.product) WIDE_PRICES[a.product.itemId] ??= 60 * a.tier;
}

/* --------------------------------------------------------- the chain --- */

test('every way of getting an item is found', () => {
  const foxglove = sourcesFor('T6_FOXGLOVE', data);
  assert.deepEqual(foxglove.map((s) => s.kind), ['plant']);
  assert.equal(foxglove[0].itemId, 'T6_FARM_FOXGLOVE_SEED');

  const eggs = sourcesFor('T5_EGG', data);
  assert.equal(eggs[0].kind, 'product');
  assert.equal(eggs[0].mode, 'product');
  assert.equal(eggs[0].itemId, 'T5_FARM_GOOSE_BABY');

  // Schnapps is both a thing you buy and a thing you brew.
  assert.ok(sourcesFor('T6_ALCOHOL', data).some((s) => s.kind === 'craft'));
  assert.deepEqual(sourcesFor('NOT_A_THING', data), []);
});

test('the chain behind a healing potion reaches the potatoes', () => {
  const chain = chainFor(POTION, data);
  assert.equal(chain.recipe.id, POTION);
  const ids = chain.inputs.map((i) => i.itemId);
  assert.deepEqual(ids, ['T6_FOXGLOVE', 'T5_EGG', 'T6_ALCOHOL']);

  const schnapps = chain.inputs.find((i) => i.itemId === 'T6_ALCOHOL');
  assert.ok(schnapps.make, 'schnapps can be crafted');
  assert.equal(schnapps.sub.recipe.id, 'T6_ALCOHOL');
  assert.deepEqual(schnapps.sub.inputs.map((i) => i.itemId), ['T6_POTATO']);
  assert.ok(schnapps.sub.inputs[0].farm, 'potatoes can be grown');
});

test('a recipe nobody has heard of has no chain', () => {
  assert.equal(chainFor('T6_NOPE', data), null);
});

test('the obvious plan grows what it can and keeps focus for the potion', () => {
  const assign = preferredAssign(chainFor(POTION, data));
  assert.equal(assign.T6_FOXGLOVE, 'farm');
  assert.equal(assign.T5_EGG, 'farm');
  assert.equal(assign.T6_POTATO, 'farm');
  assert.equal(assign.T6_ALCOHOL, 'craftNoFocus');
});

test('every combination of sourcing is on the table', () => {
  const combos = assignments(chainFor(POTION, data));
  const has = (want) => combos.some(
    (c) => Object.entries(want).every(([k, v]) => c[k] === v));
  assert.ok(has({ T6_FOXGLOVE: 'farm', T5_EGG: 'farm', T6_ALCOHOL: 'craft' }));
  assert.ok(has({ T6_FOXGLOVE: 'buy' }));
  assert.ok(has({ T6_ALCOHOL: 'buy' }));
  assert.ok(has({ T6_ALCOHOL: 'craftNoFocus', T6_POTATO: 'buy' }));
});

/* --------------------------------------------------- what a craft needs - */

test('one craft draws only what the return rate does not hand back', () => {
  const s = ctx().settings;
  const chain = chainFor(POTION, data);
  const assign = { ...preferredAssign(chain), __target: true };
  const { raw, focusPer, jobs } = requirements(chain, assign, s);

  const potion = data.recipes.find((r) => r.id === POTION);
  const rrr = returnRate(
    cityBonus(cityFor(s), potion.category, s).total + s.focusCraftBonus);
  // 72 foxglove on paper, 37.5 out of your own pile at 47.9% back.
  assert.equal(
    Math.round(raw.get('T6_FOXGLOVE').need * 100) / 100,
    Math.round(72 * (1 - rrr) * 100) / 100);
  assert.ok(raw.get('T6_FOXGLOVE').need < 72);

  // The schnapps step is crafted, so potatoes appear in its place.
  assert.ok(!raw.has('T6_ALCOHOL'));
  assert.ok(raw.has('T6_POTATO'));

  // Only the potion spends focus here; the schnapps was set to go without.
  assert.equal(Math.round(focusPer), Math.round(potion.focus));
  assert.equal(jobs.find((j) => j.recipeId === 'T6_ALCOHOL').useFocus, false);
  assert.equal(jobs.find((j) => j.recipeId === POTION).multiplier, 1);
});

test('brewing the schnapps with focus adds its focus to the bill', () => {
  const s = ctx().settings;
  const chain = chainFor(POTION, data);
  const plain = requirements(chain, { ...preferredAssign(chain), __target: true }, s);
  const both = requirements(
    chain, { ...preferredAssign(chain), T6_ALCOHOL: 'craft', __target: true }, s);
  assert.ok(both.focusPer > plain.focusPer);
  // Focus on the schnapps returns potatoes, so fewer are needed per potion.
  assert.ok(both.raw.get('T6_POTATO').need < plain.raw.get('T6_POTATO').need);
});

test('buying an ingredient takes it out of the farm and leaves it in the bill', () => {
  const s = ctx().settings;
  const chain = chainFor(POTION, data);
  const r = requirements(chain, { ...preferredAssign(chain), T5_EGG: 'buy' }, s);
  assert.ok(r.raw.has('T5_EGG'), 'still needed, just not grown');
});

/* ------------------------------------------------------- allocation ---- */

// Three ingredients wanting wildly different amounts of land, the way a
// healing potion does: foxglove takes seven times the plots the eggs do.
const leaf = (kind, need, perPlotByCity) => ({ kind, need, perPlotByCity });
const THREE = (city = 'martlock') => [
  leaf('farm', 54, { [city]: 178 }),        // foxglove: 0.30 plots a craft
  leaf('pasture', 13.5, { [city]: 324 }),   // eggs:     0.042
  leaf('farm', 7.6, { [city]: 178 }),       // potatoes: 0.043
];
const spent = (got) => got.reduce((t, g) => t + Object.values(g).reduce((a, b) => a + b, 0), 0);

test('plots go to whichever ingredient is furthest behind', () => {
  const { got, made } = allocateAcrossFarm(THREE(),
    capacityOf([{ cityId: 'martlock', kind: 'any', count: 12 }]));
  assert.equal(spent(got), 12);
  assert.ok(got[0].martlock > got[1].martlock && got[0].martlock > got[2].martlock);

  // The batch is as big as its scarcest part, and handing plots to the current
  // bottleneck beats rounding each row on its own (10/1/1 supports 23 crafts).
  const supported = Math.min(made[0] / 54, made[1] / 13.5, made[2] / 7.6);
  assert.ok(supported > Math.min((10 * 178) / 54, 324 / 13.5, 178 / 7.6));
});

test('allocation stops once focus, not land, is the limit', () => {
  const { got, made } = allocateAcrossFarm(THREE(),
    capacityOf([{ cityId: 'martlock', kind: 'any', count: 40 }]), 26);
  assert.ok(spent(got) < 40, 'leaves the rest of the land alone');
  for (const [i, need] of [54, 13.5, 7.6].entries()) {
    assert.ok(made[i] / need >= 26, 'every row covers the batch');
  }
});

test('a herb never ends up in a pasture, nor a goose on a herb patch', () => {
  const cap = capacityOf([
    { cityId: 'martlock', kind: 'farm', count: 6 },
    { cityId: 'lymhurst', kind: 'pasture', count: 3 },
  ]);
  const leaves = [
    leaf('farm', 54, { martlock: 178, lymhurst: 178 }),
    leaf('pasture', 13.5, { martlock: 324, lymhurst: 356 }),
  ];
  const { got } = allocateAcrossFarm(leaves, cap);
  assert.equal(got[0].lymhurst ?? 0, 0, 'the herb stays out of the pasture city');
  assert.equal(got[1].martlock ?? 0, 0, 'the geese stay out of the farm city');
  assert.equal(got[0].martlock, 6);
  assert.equal(got[1].lymhurst, 3);
});

test('a plot goes to the city that grows the thing best', () => {
  // The same crop, ten percent better in Martlock, with room in both.
  const cap = capacityOf([
    { cityId: 'caerleon', kind: 'farm', count: 4 },
    { cityId: 'martlock', kind: 'farm', count: 4 },
  ]);
  const { got } = allocateAcrossFarm(
    [leaf('farm', 100, { caerleon: 178, martlock: 196 })], cap);
  assert.equal(got[0].martlock, 4, 'the better city fills first');
  assert.equal(got[0].caerleon, 4, 'then it spills into the other one');
});

test('a crop with nowhere to go gets nothing rather than a plot it cannot use', () => {
  const cap = capacityOf([{ cityId: 'martlock', kind: 'pasture', count: 5 }]);
  const { got, free } = allocateAcrossFarm([leaf('farm', 54, { martlock: 178 })], cap);
  assert.deepEqual(got[0], {});
  assert.equal(free['pasture:martlock'], 5, 'the pastures are still going spare');
});

test('land you have not described is one undifferentiated heap', () => {
  const cap = capacityOf([{ cityId: 'martlock', kind: 'any', count: 9 }]);
  const leaves = [
    leaf('farm', 54, { martlock: 178 }),
    leaf('pasture', 13.5, { martlock: 324 }),
  ];
  const { got } = allocateAcrossFarm(leaves, cap);
  // Both draw on the same heap, so between them they take all nine.
  assert.equal(spent(got), 9);
  assert.ok(got[0].martlock > 0 && got[1].martlock > 0);
});

test('allocation copes with nothing to allocate', () => {
  assert.deepEqual(allocateAcrossFarm([], capacityOf([])), { got: [], made: [], free: {} });
  const none = allocateAcrossFarm([leaf('farm', 5, { martlock: 10 })], capacityOf([]));
  assert.deepEqual(none.got[0], {});
  const noNeed = allocateAcrossFarm([leaf('farm', 0, { martlock: 10 })],
    capacityOf([{ cityId: 'martlock', kind: 'farm', count: 4 }]));
  assert.deepEqual(noNeed.got[0], {});
});

test('holdings add up and ignore nonsense', () => {
  assert.equal(totalPlots([{ count: 6 }, { count: 3 }, { count: -2 }, {}]), 9);
  const cap = capacityOf([
    { cityId: 'martlock', kind: 'farm', count: 4 },
    { cityId: 'martlock', kind: 'farm', count: 2 },
    { cityId: 'martlock', kind: 'pasture', count: 1 },
    { cityId: 'martlock', kind: 'farm', count: 0 },
  ]);
  assert.deepEqual(cap, { 'farm:martlock': 6, 'pasture:martlock': 1 });
});

/* ---------------------------------------------------------- the plan --- */

const SCHED = { cycleDays: 3, farmDays: 3, farmEvery: 1, watered: false };

test('a built plan stays inside the plots you have', () => {
  const c = ctx(PRICES, SCHED);
  const chain = chainFor(POTION, data);
  const built = buildPlan(chain, preferredAssign(chain), data, c, SCHED, 12);
  const used = built.plan.plots.reduce((t, p) => t + p.count, 0);
  assert.ok(used > 0 && used <= 12);
  assert.ok(built.plan.plots.every((p) => p.count > 0));
  // The potion and the schnapps both get a job, deepest one included.
  assert.deepEqual(
    built.plan.crafts.map((j) => j.recipeId).sort(),
    ['T6_ALCOHOL', 'T6_POTION_HEAL']);
});

test('grown ingredients leave the craft jobs free to follow your edits', () => {
  const c = ctx(PRICES, SCHED);
  const chain = chainFor(POTION, data);
  const built = buildPlan(chain, preferredAssign(chain), data, c, SCHED, 12);
  assert.ok(built.plan.crafts.every((j) => j.mode === 'auto'));
  assert.equal(built.bought.length, 0);
});

test('a bought ingredient makes the batch size explicit, so it gets topped up', () => {
  const c = ctx(PRICES, SCHED);
  const chain = chainFor(POTION, data);
  const assign = { ...preferredAssign(chain), T5_EGG: 'buy' };
  const built = buildPlan(chain, assign, data, c, SCHED, 12);
  assert.ok(built.bought.some((b) => b.itemId === 'T5_EGG'));
  assert.ok(built.plan.crafts.every((j) => j.mode === 'fixed'));
  assert.ok(built.plan.crafts.every((j) => j.perCycle > 0));
  // Nothing grows eggs now, so no pasture is planted.
  assert.ok(!built.plan.plots.some((p) => p.itemId.includes('GOOSE')));
  // And the simulator really does buy them rather than making nothing.
  const sim = simulateCycle(built.plan, data, c);
  assert.ok(sim.craftLines.find((l) => l.recipe.id === POTION).crafts > 0);
  assert.ok(sim.buyCost > 0);
});

test('a plan with nothing to grow and no focus to spend has no honest size', () => {
  const c = ctx(PRICES, SCHED);
  const chain = chainFor(POTION, data);
  const built = buildPlan(chain, {
    T6_FOXGLOVE: 'buy', T5_EGG: 'buy', T6_ALCOHOL: 'buy', __target: false,
  }, data, c, SCHED, 12);
  assert.equal(built, null);
});

test('the best cash crop is never one nobody has priced', () => {
  const c = ctx({ T5_CABBAGE: 250, T5_FARM_CABBAGE_SEED: 100 }, SCHED);
  const best = bestCashCrop(data, c, SCHED);
  assert.equal(best.itemId, 'T5_FARM_CABBAGE_SEED');
  assert.equal(bestCashCrop(data, ctx({}, SCHED), SCHED), null);
});

/* --------------------------------------------------------- the solve --- */

test('the solver answers the question it was asked', () => {
  const r = solve(POTION, 12, data, ctx());
  assert.equal(r.ok, true);
  assert.equal(r.target.id, POTION);
  assert.ok(r.made > 0, 'it actually makes potions');
  assert.ok(r.perDay > 0);
  assert.ok(['focus', 'plots', 'materials'].includes(r.limit));
  assert.ok(r.sched.cycleDays >= 1);
  assert.ok(r.sched.farmDays >= 1 && r.sched.farmDays <= r.sched.cycleDays);
});

test('the plan it hands back never uses more plots than you have', () => {
  for (const budget of [1, 3, 6, 12, 30, 60]) {
    const r = solve(POTION, budget, data, ctx());
    const used = r.plan.plots.reduce((t, p) => t + p.count, 0);
    assert.ok(used <= budget, `${used} plots used of ${budget}`);
    assert.equal(r.chainPlots + r.fillerPlots + r.plotsIdle, budget);
  }
});

test('the headline figure is the simulator, not a second opinion', () => {
  const r = solve(POTION, 12, data, ctx());
  const sim = simulateCycle(r.plan, data, {
    ...ctx(), settings: { ...ctx().settings, ...r.settingsPatch },
  });
  assert.equal(Math.round(sim.profit), Math.round(r.perCycle));
  assert.equal(Math.round(sim.perDay), Math.round(r.perDay));
});

test('nothing it offers as an alternative beats what it recommended', () => {
  // Across every recipe, not just the one chain: an alternative that out-earns
  // the recommendation means the search settled somewhere it should not have.
  for (const recipe of data.recipes) {
    for (const budget of [1, 9, 40]) {
      const r = solve(recipe.id, budget, data, ctx(WIDE_PRICES));
      if (!r.ok) continue;
      for (const alt of r.alternatives) {
        assert.ok(alt.perDay <= r.perDay + 1,
          `${recipe.id} at ${budget}: ${JSON.stringify(alt.sched)} earns
           ${Math.round(alt.perDay)} against the recommended ${Math.round(r.perDay)}`);
      }
      for (const tie of r.ties || []) {
        assert.ok(tie.perDay <= r.perDay * 1.02 + 1, 'a tie is not a better plan');
      }
    }
  }
});

test('every recipe in the game gets an answer or an honest refusal', () => {
  for (const recipe of data.recipes) {
    const r = solve(recipe.id, 9, data, ctx(WIDE_PRICES));
    if (!r.ok) { assert.equal(r.reason, 'no-price'); continue; }
    const used = r.plan.plots.reduce((t, p) => t + p.count, 0);
    assert.ok(used <= 9, `${recipe.id} used ${used} plots of 9`);
    assert.ok(Number.isFinite(r.perDay), `${recipe.id} has no figure`);
  }
});

test('spare land is reported, never quietly planted', () => {
  const r = solve(POTION, 12, data, ctx());
  if (r.spare) {
    assert.ok(r.spare.plots > 0 && r.spare.perDay > 0);
    assert.ok(!r.plan.plots.some((p) => p.filler), 'kept out of the plan');
  }
  const filled = solve(POTION, 12, data, ctx(), { fillSpare: true });
  if (r.spare) assert.ok(filled.plan.plots.some((p) => p.filler));
});

test('the same question gets the same answer twice', () => {
  const strip = (r) => r.plan.plots
    .map((p) => `${p.itemId}:${p.mode}:${p.count}`).sort().join('|');
  assert.equal(strip(solve(POTION, 12, data, ctx())), strip(solve(POTION, 12, data, ctx())));
});

test('more land never earns less', () => {
  let last = 0;
  for (const budget of [3, 6, 12, 24]) {
    const r = solve(POTION, budget, data, ctx());
    assert.ok(r.perDay >= last * 0.999, `${budget} plots earned less than fewer`);
    last = r.perDay;
  }
});

test('without a price for the potion there is nothing to say', () => {
  const r = solve(POTION, 12, data, ctx({ T6_FOXGLOVE: 260 }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-price');
});

test('a recipe that does not exist is refused, not guessed at', () => {
  assert.equal(solve('T6_NOPE', 12, data, ctx()).reason, 'unknown-recipe');
});

test('with no land at all it says so instead of inventing a farm', () => {
  const r = solve(POTION, 0, data, ctx());
  assert.equal(r.plan.plots.length, 0);
});

test('a plan that spends focus on the potion never asks for more than the cap', () => {
  const r = solve(POTION, 12, data, ctx());
  assert.ok(r.sim.focusUsed <= r.sim.focusAtCraft + 1);
  assert.ok(r.sim.focusAtCraft <= data.constants.focusCap + 1);
});

/* ------------------------------------------------ the cycle you choose - */

test('a cycle length you pin is the one you get', () => {
  for (const cycleDays of [1, 3, 7, 14, 21]) {
    const r = solve(POTION, 12, data, ctx(), { cycleDays });
    assert.equal(r.ok, true);
    assert.equal(r.sched.cycleDays, cycleDays);
    assert.equal(r.settingsPatch.cycleDays, cycleDays);
    assert.equal(r.pinnedCycle, true);
    assert.ok(r.sched.farmDays >= 1 && r.sched.farmDays <= cycleDays);
    // Every alternative it offers has to keep to the length you asked for.
    for (const alt of [...r.alternatives, ...(r.ties || [])]) {
      assert.equal(alt.sched.cycleDays, cycleDays);
    }
  }
});

test('pinning a cycle still solves everything inside it', () => {
  // Fourteen days is a long batch, so it should farm only the days it can
  // process rather than filling the cycle with produce it cannot brew.
  const free = solve(POTION, 12, data, ctx());
  const long = solve(POTION, 12, data, ctx(), { cycleDays: 14 });
  assert.equal(free.pinnedCycle, false);
  assert.ok(long.sched.farmDays < 14, 'it stops farming once focus is the cap');
  // And the length costs you something, because focus caps whatever you do.
  assert.ok(long.perDay < free.perDay);
  assert.ok(long.made > 0);
});

test('a pinned cycle never beats the same plan left free', () => {
  for (const cycleDays of [2, 5, 9]) {
    const pinned = solve(POTION, 12, data, ctx(), { cycleDays });
    const free = solve(POTION, 12, data, ctx());
    assert.ok(free.perDay >= pinned.perDay - 1,
      `pinning ${cycleDays} days beat the unconstrained search`);
  }
});

/* ------------------------------------------------------ mastery moves -- */

/** Level every destiny board node that covers an item. */
const boardFor = (itemId, level) => Object.fromEntries(
  data.focusNodes
    .filter((n) => n.rules.some((r) => ruleCovers(r, itemId)))
    .map((n) => [n.id, level]));

test('levelling the destiny board changes the plan, not just the figures', () => {
  const at = (level) => solve(POTION, 12, data,
    ctx(PRICES, { nodeLevels: boardFor(POTION, level) }), { cycleDays: 14 });

  const none = at(0);
  const some = at(50);
  const lots = at(100);

  // Cheaper focus buys a bigger batch out of the same land and the same cap.
  assert.ok(some.focusPerTarget < none.focusPerTarget);
  assert.ok(lots.focusPerTarget < some.focusPerTarget);
  assert.ok(some.made > none.made);
  assert.ok(lots.made > some.made);
  assert.ok(lots.perDay > none.perDay);

  // And the shape of the week moves with it: a batch that can absorb more
  // produce is worth farming more days for.
  assert.ok(lots.sched.farmDays > none.sched.farmDays);
});

test('a flat mastery override moves the plan the same way as the board', () => {
  const plain = solve(POTION, 12, data, ctx(), { cycleDays: 14 });
  const skilled = solve(POTION, 12, data,
    ctx(PRICES, { spec: { [POTION]: 100 } }), { cycleDays: 14 });
  assert.ok(skilled.focusPerTarget < plain.focusPerTarget);
  assert.ok(skilled.made > plain.made);
});

test('the fingerprint of a plan moves when its mastery does', () => {
  // Same shape the app stores, so a stale plan can be spotted without
  // re-running the search on every render.
  const stamp = (over) => JSON.stringify(over.nodeLevels ?? {});
  assert.notEqual(stamp({ nodeLevels: boardFor(POTION, 50) }), stamp({}));
});

/* ---------------------------------------------------------- your land -- */

const LAND = (...h) => h.map((x, i) => ({ id: `h${i}`, ...x }));

test('a plan never puts a herb in a pasture', () => {
  // Farms in Martlock, pastures in Lymhurst: the herbs and potatoes belong in
  // one, the geese in the other, and neither may wander.
  const r = solve(POTION, 12, data, ctx(), {
    cycleDays: 7,
    holdings: LAND(
      { cityId: 'martlock', kind: 'farm', count: 6 },
      { cityId: 'lymhurst', kind: 'pasture', count: 2 }),
  });
  assert.equal(r.ok, true);
  for (const row of r.plan.plots) {
    const isAnimal = data.animals.some((a) => a.id === row.itemId);
    assert.equal(row.cityId, isAnimal ? 'lymhurst' : 'martlock',
      `${row.itemId} ended up in ${row.cityId}`);
  }
});

test('with no pastures it buys the eggs instead of imagining a pasture', () => {
  const r = solve(POTION, 9, data, ctx(), {
    cycleDays: 7,
    holdings: LAND({ cityId: 'martlock', kind: 'farm', count: 9 }),
  });
  assert.ok(!r.plan.plots.some((p) => data.animals.some((a) => a.id === p.itemId)),
    'nothing is being kept in a pasture you do not have');
  assert.ok(r.buys.some((b) => b.itemId === 'T5_EGG'), 'the eggs are bought');
  // And it says why, rather than leaving that looking like a price decision.
  assert.deepEqual(r.landGaps.map((g) => g.kind), ['pasture']);
  assert.ok(r.landGaps[0].items.includes('T5_EGG'));
});

test('land the plan cannot use is named rather than silently ignored', () => {
  const r = solve(POTION, 4, data, ctx(), {
    cycleDays: 7,
    holdings: LAND({ cityId: 'lymhurst', kind: 'pasture', count: 4 }),
  });
  assert.equal(r.plan.plots.length, 0, 'herbs cannot go in a pasture');
  assert.ok(r.idleLand.some((x) => x.kind === 'pasture' && x.city === 'lymhurst'));
  assert.deepEqual(r.landGaps.map((g) => g.kind), ['farm']);
});

test('plots go to the city that grows the thing best, then spill over', () => {
  // Martlock gives foxglove and potatoes +10%; Caerleon gives them nothing.
  const r = solve(POTION, 14, data, ctx(), {
    cycleDays: 7,
    holdings: LAND(
      { cityId: 'caerleon', kind: 'farm', count: 8 },
      { cityId: 'martlock', kind: 'farm', count: 4 },
      { cityId: 'lymhurst', kind: 'pasture', count: 2 }),
  });
  const farmRows = r.plan.plots.filter((p) => !data.animals.some((a) => a.id === p.itemId));
  const inMartlock = farmRows.filter((p) => p.cityId === 'martlock')
    .reduce((t, p) => t + p.count, 0);
  assert.equal(inMartlock, 4, 'the favouring city is filled before the other');
});

test('the plan never uses more of a kind of plot than you own', () => {
  const holdings = LAND(
    { cityId: 'martlock', kind: 'farm', count: 5 },
    { cityId: 'lymhurst', kind: 'pasture', count: 1 });
  for (const cycleDays of [3, 7, 14]) {
    const r = solve(POTION, 6, data, ctx(), { cycleDays, holdings });
    const used = { farm: {}, pasture: {} };
    for (const row of r.plan.plots) {
      const kind = data.animals.some((a) => a.id === row.itemId) ? 'pasture' : 'farm';
      used[kind][row.cityId] = (used[kind][row.cityId] || 0) + row.count;
    }
    for (const h of holdings) {
      assert.ok((used[h.kind][h.cityId] || 0) <= h.count,
        `${cycleDays}d used ${used[h.kind][h.cityId]} ${h.kind} in ${h.cityId} of ${h.count}`);
    }
  }
});

test('describing your land never invents plots you did not describe', () => {
  const r = solve(POTION, 999, data, ctx(), {
    cycleDays: 7,
    holdings: LAND({ cityId: 'martlock', kind: 'farm', count: 3 }),
  });
  assert.equal(r.budget, 3, 'the land you described is the budget');
  assert.ok(r.plan.plots.reduce((t, p) => t + p.count, 0) <= 3);
});

test('saying nothing about your land works exactly as before', () => {
  const plain = solve(POTION, 12, data, ctx(), { cycleDays: 7 });
  const heap = solve(POTION, 12, data, ctx(), {
    cycleDays: 7,
    holdings: LAND({ cityId: 'martlock', kind: 'any', count: 12 }),
  });
  assert.equal(Math.round(plain.perDay), Math.round(heap.perDay));
  assert.deepEqual(plain.landGaps, []);
});
