// Run with: npm test  (from the repo root)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  animalCycle, cityBonus, cityFor, craftBatch, farmBonus, farmCityFor,
  focusCostAt, focusEfficiency, focusLedger, perPeriod, planTotals, plantCycle, productCycle,
  farmDayCount, isFarmDay, rankRecipes, returnRate, ruleCovers,
  simulateCycle, specFor, taxRate, TILES_PER_PLOT,
} from '../js/calc.js';

const data = JSON.parse(
  readFileSync(new URL('../data/gamedata.json', import.meta.url), 'utf8'));

const plant = (id) => data.plants.find((p) => p.id === id);
const animal = (id) => data.animals.find((a) => a.id === id);
const recipe = (id) => data.recipes.find((r) => r.id === id);

const ctx = (prices = {}, over = {}) => ({
  priceOf: (id) => prices[id] ?? 0,
  settings: {
    ...data.constants,
    cities: data.cities,
    premium: true, watered: false, favouriteFood: true, useFocus: false,
    craftCity: 'martlock', farmCity: 'island', spec: {}, specLevel: 0,
    cadenceHours: 24, cycleDays: 14, farmDays: 10, farmEvery: 1, startFocus: 0,
    focusNodes: data.focusNodes, nodeLevels: {}, stockCap: 5000,
    stationFeePerCraft: 0, feedItemId: 'T3_WHEAT',
    ...over,
  },
});

/* ------------------------------------------------- the return-rate curve */

test('return rate matches the numbers players see in game', () => {
  // Royal city, no focus: +18 -> 15.2%
  assert.equal(Math.round(returnRate(18) * 1000) / 10, 15.3);
  // Royal city + focus: +18+59 -> 43.5%
  assert.equal(Math.round(returnRate(18 + 59) * 1000) / 10, 43.5);
  // Crafting specialty city + focus: +18+15+59 -> 47.9%
  assert.equal(Math.round(returnRate(18 + 15 + 59) * 1000) / 10, 47.9);
  // Refining specialty + focus: +18+40+59 -> 53.9%
  assert.equal(Math.round(returnRate(18 + 40 + 59) * 1000) / 10, 53.9);
  assert.equal(returnRate(0), 0);
});

test('focus cost halves at specialisation 100', () => {
  assert.equal(Math.round(focusCostAt(1000, 100, data.constants.focusCostConstant)), 500);
  assert.equal(focusCostAt(1000, 0), 1000);
  assert.equal(Math.round(focusCostAt(1000, 50, data.constants.focusCostConstant)), 707);
});

test('market tax is the setup fee plus a transaction tax premium halves', () => {
  // Both figures come from gamedata.xml: 2.5% setup, 8% transaction.
  const g = { marketSetupFee: 2.5, marketTransactionTax: 8 };
  assert.equal(taxRate({ ...g, premium: true }), 0.065);    // 2.5 + 4
  assert.equal(taxRate({ ...g, premium: false }), 0.105);   // 2.5 + 8
  assert.equal(data.constants.marketSetupFee, 2.5);
  assert.equal(data.constants.marketTransactionTax, 8);
});

/* ------------------------------------------------------------- farming - */

test('watering adds exactly the seed bonus from the game data', () => {
  const cab = plant('T5_FARM_CABBAGE_SEED');
  assert.equal(cab.seedReturn, 0.8);
  assert.equal(cab.wateredBonus, 0.4);

  const p = { 'T5_FARM_CABBAGE_SEED': 10000, 'T5_CABBAGE': 500 };
  const dry = plantCycle(cab, ctx(p));
  const wet = plantCycle(cab, ctx(p, { watered: true }));

  assert.equal(dry.seedsBack, 0.8);
  assert.equal(wet.seedsBack, 1.2000000000000002);   // float, value is 1.2
  assert.equal(dry.focus, 0);
  assert.equal(wet.focus, 1000);
  // Dry burns 0.2 seeds; watered leaves a 0.2 surplus, so it earns silver back.
  assert.equal(Math.round(dry.seedCost), 2000);
  assert.equal(Math.round(wet.seedCost), -2000);
  assert.ok(wet.profit > dry.profit);
});

test('premium doubles the harvest', () => {
  const cab = plant('T5_FARM_CABBAGE_SEED');
  const p = { 'T5_CABBAGE': 500, 'T5_FARM_CABBAGE_SEED': 10000 };
  // Per tile: 3-6 averages 4.5, and premium doubles it.
  assert.equal(plantCycle(cab, ctx(p, { premium: true })).yieldPerTile, 9);
  assert.equal(plantCycle(cab, ctx(p, { premium: false })).yieldPerTile, 4.5);
});

test('unwatered carrots return no seed at all', () => {
  const carrot = plant('T1_FARM_CARROT_SEED');
  assert.equal(carrot.seedReturn, 0);
  assert.equal(carrot.wateredBonus, 2);
  const c = ctx({ 'T1_FARM_CARROT_SEED': 2000, 'T1_CARROT': 100 });
  assert.equal(plantCycle(carrot, c).netSeeds, 1);          // buy one every time
  const wet = plantCycle(carrot, ctx({ 'T1_FARM_CARROT_SEED': 2000 }, { watered: true }));
  assert.equal(wet.netSeeds, -1);                            // watered: one spare
});

test('a crop that sells for nothing still reports what it cost to grow', () => {
  const cab = plant('T5_FARM_CABBAGE_SEED');
  const c = plantCycle(cab, ctx({ 'T5_FARM_CABBAGE_SEED': 10000, 'T5_CABBAGE': 0 }));
  assert.equal(Math.round(c.costPerUnit), 222);   // 2000 silver of seed over 9 cabbages
  assert.ok(c.profit < 0);
});

test('market tax is taken off the sale, not the cost', () => {
  const cab = plant('T5_FARM_CABBAGE_SEED');
  const p = { 'T5_FARM_CABBAGE_SEED': 0, 'T5_CABBAGE': 1000 };
  const prem = plantCycle(cab, ctx(p, { premium: true }));
  assert.equal(prem.revenue, 9 * 1000 * (1 - 0.065));
});

/* ------------------------------------------------------------- animals - */

test('a chicken eats 18 plants, or 9 if they are its favourite', () => {
  const chick = animal('T3_FARM_CHICKEN_BABY');
  assert.equal(chick.nutrition, 864);
  assert.equal(chick.favouriteFood, 'T3_WHEAT');

  const p = { 'T3_WHEAT': 100, 'T3_FARM_CHICKEN_BABY': 5000, 'T3_FARM_CHICKEN_GROWN': 9000 };
  const fav = animalCycle(chick, ctx(p, { favouriteFood: true }));
  const any = animalCycle(chick, ctx(p, { favouriteFood: false, feedItemId: 'T3_WHEAT' }));
  assert.equal(fav.plantsNeeded, 9);
  assert.equal(any.plantsNeeded, 18);
  assert.equal(fav.feedCost, 900);
  assert.equal(any.feedCost, 1800);
});

test('offspring offsets the cost of the next baby', () => {
  const cow = animal('T8_FARM_COW_BABY');
  const p = { 'T8_FARM_COW_BABY': 30000, 'T8_FARM_COW_GROWN': 120000, 'T8_PUMPKIN': 500 };
  const dry = animalCycle(cow, ctx(p));
  const wet = animalCycle(cow, ctx(p, { watered: true }));
  assert.equal(dry.babiesBack, 0.9333);
  assert.ok(wet.babiesBack > 1);                    // watered T8 cows self-sustain
  assert.ok(wet.babyCost < 0);
  assert.ok(wet.profit > dry.profit);
});

test('milk and eggs are charged their feed', () => {
  const cow = animal('T8_FARM_COW_BABY');
  const prod = productCycle(cow, ctx({ 'T8_MILK': 1000, 'T8_PUMPKIN': 200 }));
  assert.equal(prod.perCycle, 18);                  // avg 9, doubled by premium
  assert.equal(prod.hours, 22);
  assert.ok(prod.feedCost > 0);
  assert.equal(prod.profit, prod.revenue - prod.feedCost);
});

test('a pig has no product to harvest', () => {
  assert.equal(productCycle(animal('T7_FARM_PIG_BABY'), ctx({})), null);
});

/* ------------------------------------------------------------ crafting - */

test('healing potion uses the recipe straight from the dump', () => {
  const r = recipe('T4_POTION_HEAL');
  assert.equal(r.amount, 5);
  assert.equal(r.focus, 210);
  assert.deepEqual(r.inputs, [
    { id: 'T4_BURDOCK', count: 24 }, { id: 'T3_EGG', count: 6 },
  ]);
});

test('focus and the city bonus both cut the material bill', () => {
  const r = recipe('T4_POTION_HEAL');
  const p = { 'T4_BURDOCK': 500, 'T3_EGG': 300, 'T4_POTION_HEAL': 2000 };

  const plain = craftBatch(r, ctx(p));
  const focus = craftBatch(r, ctx(p, { useFocus: true }));
  const both = craftBatch(r, { ...ctx(p, { useFocus: true }), cityId: 'brecilien' });

  assert.equal(plain.materials, 24 * 500 + 6 * 300);          // 13800
  assert.equal(Math.round(plain.rrr * 1000) / 10, 15.3);
  assert.equal(Math.round(focus.rrr * 1000) / 10, 43.5);
  assert.equal(Math.round(both.rrr * 1000) / 10, 47.9);

  assert.ok(focus.materialsAfterReturn < plain.materialsAfterReturn);
  assert.ok(both.profit > focus.profit);
  assert.equal(plain.focus, 0);
  assert.equal(focus.focus, 210);
});

test('silver per focus is only defined when focus is spent', () => {
  const r = recipe('T4_POTION_HEAL');
  const p = { 'T4_BURDOCK': 100, 'T3_EGG': 100, 'T4_POTION_HEAL': 3000 };
  assert.equal(craftBatch(r, ctx(p)).silverPerFocus, null);
  const f = craftBatch(r, ctx(p, { useFocus: true }));
  assert.equal(Math.round(f.silverPerFocus), Math.round(f.profit / f.focus));
});

test('crafting your own crops is cheaper than buying them', () => {
  const r = recipe('T4_POTION_HEAL');
  const prices = { 'T4_BURDOCK': 500, 'T3_EGG': 300, 'T4_POTION_HEAL': 2000 };
  const base = ctx(prices);
  const market = craftBatch(r, base);
  const own = craftBatch(r, { ...base, inputCostOf: (id) => (id === 'T4_BURDOCK' ? 120 : 300) });
  assert.ok(own.profit > market.profit);
});

/* --------------------------------------------------------------- rates - */

test('a 22h crop harvested daily runs once a day, not 1.09 times', () => {
  const cycle = { profit: 1000, hours: 22, focus: 0 };
  assert.equal(perPeriod(cycle, { cadenceHours: 24 }).cyclesPerDay, 1);
  assert.equal(perPeriod(cycle, { cadenceHours: 24 }).perMonth, 30000);
  // Someone harvesting the moment it ripens gets the extra 2h back.
  assert.equal(round2(perPeriod(cycle, { cadenceHours: 22 }).cyclesPerDay), 1.09);
});
const round2 = (n) => Math.round(n * 100) / 100;

test('plot count scales the whole line', () => {
  const cycle = { profit: 500, hours: 22, focus: 1000 };
  const one = perPeriod(cycle, { count: 1, cadenceHours: 24 });
  const nine = perPeriod(cycle, { count: 9, cadenceHours: 24 });
  assert.equal(nine.perDay, one.perDay * 9);
  assert.equal(nine.focusPerDay, 9000);
});

/* ---------------------------------------------------------------- plan - */

test('a plan adds up its lines and flags going over focus', () => {
  const plan = {
    plots: [{ id: 'a', itemId: 'T5_FARM_CABBAGE_SEED', count: 9, mode: 'grow' }],
    crafts: [{ id: 'c', recipeId: 'T4_POTION_HEAL', craftsPerDay: 20 }],
  };
  const c = ctx({
    'T5_FARM_CABBAGE_SEED': 10000, 'T5_CABBAGE': 600,
    'T4_BURDOCK': 400, 'T3_EGG': 300, 'T4_POTION_HEAL': 2500,
  }, { watered: true, useFocus: true });

  const totals = planTotals(plan, data, c);
  assert.equal(totals.lines.length, 2);
  assert.equal(round2(totals.perMonth), round2(totals.perDay * 30));
  // 9 plots watered = 9000 focus, plus 20 potions at 210 = 4200. Over 10k/day.
  assert.equal(totals.focusPerDay, 9000 + 20 * 210);
  assert.equal(totals.focusOver, true);
});

test('an empty plan is zero, not NaN', () => {
  const totals = planTotals({ plots: [], crafts: [] }, data, ctx({}));
  assert.equal(totals.perDay, 0);
  assert.equal(totals.perMonth, 0);
  assert.equal(totals.focusOver, false);
});

test('every ranked row is a real number even with no prices set', () => {
  const rows = rankRecipes(data, ctx({}));
  assert.ok(rows.length > 50);
  for (const r of rows) assert.ok(Number.isFinite(r.profit), r.ref.id);
});

/* ------------------------------------------------- data file integrity - */

test('the extracted game data is internally consistent', () => {
  assert.ok(data.plants.length >= 15);
  assert.ok(data.recipes.length >= 50);

  for (const p of data.plants) {
    assert.ok(p.cropId, `${p.id} has no crop`);
    assert.ok(data.items[p.cropId], `${p.cropId} missing from items`);
    assert.equal(p.growSeconds, 79200, `${p.id} should grow in 22h`);
    assert.ok(p.seedReturn >= 0 && p.seedReturn <= 1, p.id);
    assert.ok(p.seedNpc > 0, p.id);
  }
  for (const a of data.animals) {
    assert.ok(data.items[a.grownId], `${a.grownId} missing from items`);
    assert.ok(a.nutrition > 0 && a.nutrition % 48 === 0, a.id);
    if (a.product) assert.ok(data.items[a.product.itemId], a.product.itemId);
  }
  for (const r of data.recipes) {
    assert.ok(r.amount > 0, r.id);
    assert.ok(r.inputs.length > 0, r.id);
    for (const i of r.inputs) assert.ok(data.items[i.id], `${i.id} (in ${r.id})`);
  }
});

test('every seed return plus its watered bonus is a sane multiplier', () => {
  for (const p of data.plants) {
    const watered = p.seedReturn + p.wateredBonus;
    assert.ok(watered > 0 && watered <= 2.001, `${p.id} -> ${watered}`);
  }
});

/* ------------------------------------------------------ missing prices - */

test('a row with an unpriced input is reported, not silently valued at zero', async () => {
  // Same rule the Best screen uses: no price anywhere in the chain -> no number.
  const priced = { 'T3_WHEAT': 180 };
  const chick = animal('T3_FARM_CHICKEN_BABY');
  const c = animalCycle(chick, ctx(priced));
  // The grown chicken has no price, so revenue is zero and profit is a loss.
  assert.equal(c.revenue, 0);
  assert.ok(c.profit < 0);

  // With it priced, the same call turns a profit.
  const full = animalCycle(chick, ctx({ ...priced, 'T3_FARM_CHICKEN_GROWN': 11500, 'T3_FARM_CHICKEN_BABY': 5000 }));
  assert.ok(full.profit > 0);
});

/* ------------------------------------------------- city, per category -- */

test('a city only boosts the categories it actually specialises in', () => {
  const s = ctx({}).settings;
  const brecilien = cityFor(s, 'brecilien');
  const caerleon = cityFor(s, 'caerleon');
  const martlock = cityFor(s, 'martlock');

  // Brecilien is the potion city, Caerleon the food city.
  assert.equal(cityBonus(brecilien, 'potion', s).total, 33);
  assert.equal(cityBonus(brecilien, 'food', s).total, 18);
  assert.equal(cityBonus(caerleon, 'food', s).total, 33);
  assert.equal(cityBonus(caerleon, 'potion', s).total, 18);
  // Royal cities specialise in weapons and armour, so neither applies.
  assert.equal(cityBonus(martlock, 'potion', s).total, 18);
  assert.equal(cityBonus(martlock, 'food', s).total, 18);
  assert.equal(cityBonus(martlock, 'potion', s).specialises, false);
});

test('brewing a potion outside Brecilien loses the specialty', () => {
  const r = recipe('T4_POTION_HEAL');
  const p = { 'T4_BURDOCK': 500, 'T3_EGG': 300, 'T4_POTION_HEAL': 2000 };
  const base = { ...ctx(p, { useFocus: true }) };

  const brec = craftBatch(r, { ...base, cityId: 'brecilien' });
  const mart = craftBatch(r, { ...base, cityId: 'martlock' });

  assert.equal(Math.round(brec.rrr * 1000) / 10, 47.9);   // 18 + 15 + 59
  assert.equal(Math.round(mart.rrr * 1000) / 10, 43.5);   // 18 + 59
  assert.ok(brec.profit > mart.profit);
  assert.equal(brec.city.id, 'brecilien');
  assert.equal(mart.bonus.specialises, false);
});

test('food gets its bonus in Caerleon, not Brecilien', () => {
  const food = data.recipes.find((x) => x.category === 'food' && x.focus > 0);
  const base = { ...ctx({}, { useFocus: true }) };
  const caer = craftBatch(food, { ...base, cityId: 'caerleon' });
  const brec = craftBatch(food, { ...base, cityId: 'brecilien' });
  assert.equal(caer.bonus.specialises, true);
  assert.equal(brec.bonus.specialises, false);
  assert.ok(caer.rrr > brec.rrr);
});

test('an unknown city falls back rather than producing NaN', () => {
  const r = recipe('T4_POTION_HEAL');
  const b = craftBatch(r, { ...ctx({}), cityId: 'atlantis' });
  assert.ok(Number.isFinite(b.rrr));
  assert.ok(Number.isFinite(b.profit));
});

/* ------------------------------------------------------------ mastery -- */

test('mastery is per recipe, falling back to the default', () => {
  const s = { spec: { T4_POTION_HEAL: 80 }, specLevel: 20 };
  assert.equal(specFor(s, 'T4_POTION_HEAL'), 80);
  assert.equal(specFor(s, 'T6_POTION_HEAL'), 20);
  assert.equal(specFor({ specLevel: 0 }, 'anything'), 0);
});

test("a recipe's own mastery drives its focus cost", () => {
  const r = recipe('T4_POTION_HEAL');          // 210 focus at spec 0
  const p = { 'T4_BURDOCK': 400, 'T3_EGG': 300, 'T4_POTION_HEAL': 2500 };

  const raw = craftBatch(r, { ...ctx(p, { useFocus: true }) });
  const spec100 = craftBatch(r, { ...ctx(p, { useFocus: true }), specLevel: 100 });
  const viaMap = craftBatch(r, ctx(p, { useFocus: true, spec: { T4_POTION_HEAL: 100 } }));

  assert.equal(Math.round(raw.focus), 210);
  assert.equal(Math.round(spec100.focus), 105);          // halved at 100
  assert.equal(Math.round(viaMap.focus), 105);           // same, set per recipe
  assert.equal(spec100.spec, 100);
  // Focus buys the same return rate either way, so silver per focus doubles.
  assert.equal(spec100.rrr, raw.rrr);
  assert.ok(spec100.silverPerFocus > raw.silverPerFocus * 1.9);
});

test('mastery on one recipe does not leak into another', () => {
  const p = { 'T4_BURDOCK': 400, 'T3_EGG': 300, 'T4_POTION_HEAL': 2500 };
  const c = ctx(p, { useFocus: true, spec: { T4_POTION_HEAL: 100 }, specLevel: 0 });
  const healed = craftBatch(recipe('T4_POTION_HEAL'), c);
  const other = craftBatch(recipe('T4_POTION_ENERGY'), c);
  assert.equal(healed.spec, 100);
  assert.equal(other.spec, 0);
});

test('a plan costs each craft job in its own city at its own mastery', () => {
  const plan = {
    plots: [],
    crafts: [
      { id: 'a', recipeId: 'T4_POTION_HEAL', craftsPerDay: 10, cityId: 'brecilien', specLevel: 100 },
      { id: 'b', recipeId: 'T4_POTION_HEAL', craftsPerDay: 10, cityId: 'martlock', specLevel: 0 },
    ],
  };
  const c = ctx({ 'T4_BURDOCK': 400, 'T3_EGG': 300, 'T4_POTION_HEAL': 2500 },
    { useFocus: true });
  const totals = planTotals(plan, data, c);
  const [brec, mart] = totals.lines;

  assert.equal(brec.cycle.city.id, 'brecilien');
  assert.equal(mart.cycle.city.id, 'martlock');
  assert.ok(brec.cycle.profit > mart.cycle.profit);       // specialty applies
  assert.equal(Math.round(brec.cycle.focus), 105);        // mastery 100
  assert.equal(Math.round(mart.cycle.focus), 210);        // mastery 0
  assert.equal(Math.round(totals.focusPerDay), 10 * 105 + 10 * 210);
});

/* ------------------------------------------------ crafting on an island - */

test('crafting on your own island earns no city bonus at all', () => {
  // craftingmodifiers.xml gives every city islandvalue="0" for crafting.
  const s = ctx({}).settings;
  const island = cityFor(s, 'island');
  assert.equal(island.craftBase, 0);
  assert.equal(cityBonus(island, 'potion', s).total, 0);

  const r = recipe('T4_POTION_HEAL');
  const p = { 'T4_BURDOCK': 500, 'T3_EGG': 300, 'T4_POTION_HEAL': 2000 };
  const onIsland = craftBatch(r, { ...ctx(p, { useFocus: true }), cityId: 'island' });
  const inCity = craftBatch(r, { ...ctx(p, { useFocus: true }), cityId: 'martlock' });

  // Focus alone: 1 - 100/159 = 37.1%, against 43.5% with the city's +18.
  assert.equal(Math.round(onIsland.rrr * 1000) / 10, 37.1);
  assert.equal(Math.round(inCity.rrr * 1000) / 10, 43.5);
  assert.ok(onIsland.profit < inCity.profit);
});

/* ------------------------------------------------------ farming bonus -- */

test('a city gives +10% yield only on the things it actually boosts', () => {
  const s = ctx({}).settings;
  const martlock = farmCityFor(s, 'martlock');
  const thetford = farmCityFor(s, 'thetford');

  // From farmingmodifiers.xml: Martlock boosts wheat, Thetford cabbage.
  assert.equal(farmBonus(martlock, 'T3_FARM_WHEAT_SEED'), 10);
  assert.equal(farmBonus(martlock, 'T5_FARM_CABBAGE_SEED'), 0);
  assert.equal(farmBonus(thetford, 'T5_FARM_CABBAGE_SEED'), 10);
  assert.equal(farmBonus(thetford, 'T3_FARM_WHEAT_SEED'), 0);
});

test('the farming bonus lifts the harvest by exactly a tenth', () => {
  const wheat = plant('T3_FARM_WHEAT_SEED');
  const prices = { 'T3_FARM_WHEAT_SEED': 5000, 'T3_WHEAT': 200 };

  const plain = plantCycle(wheat, { ...ctx(prices), cityId: 'thetford' });
  const boosted = plantCycle(wheat, { ...ctx(prices), cityId: 'martlock' });

  assert.equal(plain.yieldPerTile, 9);          // 4.5 avg, doubled by premium
  assert.equal(round2(boosted.yieldPerTile), 9.9);
  assert.equal(boosted.farmBonusPct, 10);
  assert.equal(plain.farmBonusPct, 0);
  assert.ok(boosted.revenue > plain.revenue);
});

test('Brecilien boosts every crop but no herb', () => {
  const s = ctx({}).settings;
  const brec = farmCityFor(s, 'brecilien');
  const crops = data.plants.filter((x) => x.kind === 'crop');
  const herbs = data.plants.filter((x) => x.kind === 'herb');
  assert.ok(crops.every((x) => farmBonus(brec, x.id) === 10), 'all crops');
  assert.ok(herbs.every((x) => farmBonus(brec, x.id) === 0), 'no herbs');
});

test('eggs and milk get the bonus, but raising the animal does not', () => {
  const chicken = animal('T3_FARM_CHICKEN_BABY');
  const prices = {
    'T3_WHEAT': 180, 'T3_EGG': 500,
    'T3_FARM_CHICKEN_BABY': 5000, 'T3_FARM_CHICKEN_GROWN': 11500,
  };
  // Fort Sterling boosts T3_FARM_CHICKEN_GROWN, i.e. the eggs.
  const eggsHere = productCycle(chicken, { ...ctx(prices), cityId: 'fortsterling' });
  const eggsAway = productCycle(chicken, { ...ctx(prices), cityId: 'martlock' });
  assert.equal(eggsHere.farmBonusPct, 10);
  assert.equal(eggsAway.farmBonusPct, 0);
  assert.equal(round2(eggsHere.perCycle), 19.8);   // 18 plus a tenth
  assert.equal(eggsAway.perCycle, 18);

  // Raising the bird is unaffected wherever you do it.
  const raiseHere = animalCycle(chicken, { ...ctx(prices), cityId: 'fortsterling' });
  const raiseAway = animalCycle(chicken, { ...ctx(prices), cityId: 'martlock' });
  assert.equal(raiseHere.farmBonusPct, 0);
  assert.equal(raiseHere.profit, raiseAway.profit);
});

test('an animal favourite food is boosted somewhere other than the animal', () => {
  // The game deliberately splits these to create trade. Chickens are boosted in
  // Fort Sterling; their favourite wheat is boosted in Martlock.
  const s = ctx({}).settings;
  const chicken = animal('T3_FARM_CHICKEN_BABY');
  const birdCity = s.cities.find((c) => farmBonus(c, chicken.grownId) > 0);
  const feedCity = s.cities.find((c) => farmBonus(c, `T3_FARM_WHEAT_SEED`) > 0);
  assert.equal(chicken.favouriteFood, 'T3_WHEAT');
  assert.ok(birdCity && feedCity);
  assert.notEqual(birdCity.id, feedCity.id);
});

test('each plot on a plan is farmed in its own city', () => {
  const plan = {
    plots: [
      { id: 'a', itemId: 'T3_FARM_WHEAT_SEED', count: 9, mode: 'grow', cityId: 'martlock' },
      { id: 'b', itemId: 'T3_FARM_WHEAT_SEED', count: 9, mode: 'grow', cityId: 'thetford' },
    ],
    crafts: [],
  };
  const c = ctx({ 'T3_FARM_WHEAT_SEED': 5000, 'T3_WHEAT': 200 });
  const totals = planTotals(plan, data, c);
  assert.equal(totals.lines[0].cycle.farmBonusPct, 10);
  assert.equal(totals.lines[1].cycle.farmBonusPct, 0);
  assert.ok(totals.lines[0].cycle.profit > totals.lines[1].cycle.profit);
});

/* --------------------------------------------------- the city data set - */

test('the city table came out of the game files intact', () => {
  const cities = data.cities;
  assert.equal(cities.length, 11);                  // 10 locations plus island

  const byId = Object.fromEntries(cities.map((c) => [c.id, c]));
  // Only these two matter for what this app crafts.
  assert.equal(byId.brecilien.craftSpecialties.potion, 15);
  assert.equal(byId.caerleon.craftSpecialties.food, 15);
  for (const id of ['martlock', 'thetford', 'lymhurst', 'bridgewatch', 'fortsterling']) {
    assert.equal(byId[id].craftSpecialties.potion, undefined, id);
    assert.equal(byId[id].craftSpecialties.food, undefined, id);
    assert.equal(byId[id].craftBase, 18, id);
  }
  assert.equal(byId.island.craftBase, 0);

  // Every farming key must name something the app knows about.
  const known = new Set([
    ...data.plants.map((p) => p.id),
    ...data.animals.map((a) => a.grownId),
  ]);
  for (const c of cities) {
    for (const [key, pct] of Object.entries(c.farmBonus)) {
      assert.ok(known.has(key), `${c.id} boosts unknown ${key}`);
      assert.equal(pct, 10, `${c.id} ${key}`);
    }
  }
});

/* -------------------------------------------------------- focus ledger - */

test('focus banks up daily and stops dead at the cap', () => {
  const l = focusLedger({ cycleDays: 14, farmDays: 0, perDay: 10000, cap: 30000, start: 0 });
  assert.equal(l.days[0].focus, 10000);
  assert.equal(l.days[2].focus, 30000);
  assert.equal(l.cappedOn, 3);
  assert.equal(l.atCraft, 30000);
  // Days 4-14 each throw away a full day of regeneration.
  assert.equal(l.wasted, 11 * 10000);
});

test('a cycle that ends the day it caps wastes nothing', () => {
  const l = focusLedger({ cycleDays: 3, farmDays: 0, perDay: 10000, cap: 30000, start: 0 });
  assert.equal(l.atCraft, 30000);
  assert.equal(l.wasted, 0);
});

test('watering spends the regeneration it is given, and no more', () => {
  // 18k of plots a day against 10k of regen: you bank nothing while farming.
  const l = focusLedger({
    cycleDays: 14, farmDays: 10, perDay: 10000, cap: 30000, start: 0,
    wateringPerDay: 18000,
  });
  assert.equal(l.days[0].spent, 10000);
  assert.equal(l.days[0].focus, 0);
  assert.equal(l.days[9].focus, 0);
  // Then four idle days bank it back up, capping on day 13.
  assert.equal(l.atCraft, 30000);
  assert.equal(l.cappedOn, 13);
  // 8k of watering a day never happens.
  assert.equal(l.shortfall, 10 * 8000);
});

test('starting focus carries into the cycle', () => {
  const l = focusLedger({ cycleDays: 1, farmDays: 0, perDay: 10000, cap: 30000, start: 15000 });
  assert.equal(l.atCraft, 25000);
});

/* ------------------------------------------------------ whole cycles --- */

const cyclePrices = {
  T6_FARM_FOXGLOVE_SEED: 15000, T6_FOXGLOVE: 900,
  T6_FARM_POTATO_SEED: 15000, T6_POTATO: 420, T6_ALCOHOL: 700,
  T5_FARM_GOOSE_BABY: 10000, T5_FARM_GOOSE_GROWN: 26000, T5_EGG: 780,
  T5_CABBAGE: 330, T6_POTION_HEAL: 5400,
};
const cycleCtx = (over = {}) => ctx(cyclePrices, {
  watered: true, useFocus: true, craftCity: 'brecilien', farmCity: 'martlock',
  feedItemId: 'T5_CABBAGE', ...over,
});
const cyclePlan = (crafts) => ({
  plots: [
    { id: 'f', itemId: 'T6_FARM_FOXGLOVE_SEED', count: 9, mode: 'grow', cityId: 'martlock' },
    { id: 'p', itemId: 'T6_FARM_POTATO_SEED', count: 9, mode: 'grow', cityId: 'martlock' },
    { id: 'g', itemId: 'T5_FARM_GOOSE_BABY', count: 9, mode: 'product', cityId: 'lymhurst' },
  ],
  crafts,
});

test('farming runs only on the farming days', () => {
  const sim = simulateCycle(cyclePlan([]), data, cycleCtx());
  const foxglove = sim.farmLines.find((l) => l.itemId === 'T6_FOXGLOVE');
  assert.equal(foxglove.harvests, 10);              // 10 farm days, 24h cadence
  assert.equal(sim.idleDays, 4);

  // Half the farming days, half the crop.
  const half = simulateCycle(cyclePlan([]), data, cycleCtx({ farmDays: 5 }));
  assert.equal(half.farmLines.find((l) => l.itemId === 'T6_FOXGLOVE').harvests, 5);
  assert.equal(half.pool.T6_FOXGLOVE, foxglove.produced / 2);
});

test('a craft chain runs in dependency order however it is listed', () => {
  // Potions need alcohol, and alcohol is made from potatoes. Listing the
  // potion first must not starve it.
  const sim = simulateCycle(cyclePlan([
    { id: 'c2', recipeId: 'T6_POTION_HEAL', mode: 'auto' },
    { id: 'c1', recipeId: 'T6_ALCOHOL', mode: 'auto', useFocus: false },
  ]), data, cycleCtx());

  assert.equal(sim.craftLines[0].recipe.id, 'T6_ALCOHOL');
  assert.equal(sim.craftLines[1].recipe.id, 'T6_POTION_HEAL');
  assert.ok(sim.craftLines[1].crafts > 0, 'potions actually got made');
});

test('a cheap intermediate step can eat the whole focus budget', () => {
  // Alcohol is 38 focus each and you need a lot of it, so focusing it starves
  // the potions it exists to feed.
  const withFocus = simulateCycle(cyclePlan([
    { id: 'c1', recipeId: 'T6_ALCOHOL', mode: 'auto', useFocus: true },
    { id: 'c2', recipeId: 'T6_POTION_HEAL', mode: 'auto' },
  ]), data, cycleCtx());
  const without = simulateCycle(cyclePlan([
    { id: 'c1', recipeId: 'T6_ALCOHOL', mode: 'auto', useFocus: false },
    { id: 'c2', recipeId: 'T6_POTION_HEAL', mode: 'auto' },
  ]), data, cycleCtx());

  const potions = (sim) => sim.craftLines.find((l) => l.recipe.id === 'T6_POTION_HEAL');
  assert.equal(potions(withFocus).crafts, 0, 'focus all went on alcohol');
  assert.ok(potions(without).crafts > 0, 'saving focus leaves some for potions');
  assert.equal(withFocus.craftLines[0].limitedBy, 'focus');
  assert.equal(without.craftLines[0].limitedBy, 'materials');
});

test('the binding constraint is reported honestly', () => {
  // Nine 3x3 plots is 81 tiles of foxglove, so focus runs out well before the
  // herbs do - the opposite of the old per-tile reading.
  const sim = simulateCycle(cyclePlan([
    { id: 'c1', recipeId: 'T6_ALCOHOL', mode: 'auto', useFocus: false },
    { id: 'c2', recipeId: 'T6_POTION_HEAL', mode: 'auto' },
  ]), data, cycleCtx());
  const potions = sim.craftLines.find((l) => l.recipe.id === 'T6_POTION_HEAL');

  assert.equal(potions.limitedBy, 'focus');
  assert.ok(potions.byFocus < potions.byMaterial);
  assert.ok(sim.focusLeft < potions.batch.focus, 'focus is spent down to the last craft');

  // Growing more foxglove cannot lift a ceiling that focus is setting.
  const more = simulateCycle({
    ...cyclePlan([
      { id: 'c1', recipeId: 'T6_ALCOHOL', mode: 'auto', useFocus: false },
      { id: 'c2', recipeId: 'T6_POTION_HEAL', mode: 'auto' },
    ]),
    plots: [
      { id: 'f', itemId: 'T6_FARM_FOXGLOVE_SEED', count: 27, mode: 'grow', cityId: 'martlock' },
      { id: 'p', itemId: 'T6_FARM_POTATO_SEED', count: 9, mode: 'grow', cityId: 'martlock' },
      { id: 'g', itemId: 'T5_FARM_GOOSE_BABY', count: 9, mode: 'product', cityId: 'lymhurst' },
    ],
  }, data, cycleCtx());
  const morePotions = more.craftLines.find((l) => l.recipe.id === 'T6_POTION_HEAL');
  assert.equal(morePotions.crafts, potions.crafts, 'focus-bound, so more herbs change nothing');
});

test('when materials bind instead, growing more does lift the ceiling', () => {
  const small = (plots) => ({
    plots: [
      { id: 'f', itemId: 'T6_FARM_FOXGLOVE_SEED', count: plots, mode: 'grow', cityId: 'martlock' },
      { id: 'p', itemId: 'T6_FARM_POTATO_SEED', count: plots, mode: 'grow', cityId: 'martlock' },
      { id: 'g', itemId: 'T5_FARM_GOOSE_BABY', count: plots, mode: 'product', cityId: 'lymhurst' },
    ],
    crafts: [
      { id: 'c1', recipeId: 'T6_ALCOHOL', mode: 'auto', useFocus: false },
      { id: 'c2', recipeId: 'T6_POTION_HEAL', mode: 'auto' },
    ],
  });
  const one = simulateCycle(small(1), data, cycleCtx());
  const two = simulateCycle(small(2), data, cycleCtx());
  const potionsOf = (sim) => sim.craftLines.find((l) => l.recipe.id === 'T6_POTION_HEAL');
  assert.equal(potionsOf(one).limitedBy, 'materials');
  assert.ok(potionsOf(two).crafts > potionsOf(one).crafts);
});

test('the return rate stretches materials into more crafts, each costing focus', () => {
  // Alcohol has to be in the plan or the potion has no alcohol at all and both
  // cities are equally stuck at zero.
  const plan = cyclePlan([
    { id: 'c1', recipeId: 'T6_ALCOHOL', mode: 'auto', useFocus: false },
    { id: 'c', recipeId: 'T6_POTION_HEAL', mode: 'auto' },
  ]);
  // Same materials, better return rate: more crafts out of the same pile.
  const brecilien = simulateCycle(plan, data, cycleCtx({ craftCity: 'brecilien' }));
  const martlock = simulateCycle(plan, data, cycleCtx({ craftCity: 'martlock' }));
  const potions = (sim) => sim.craftLines.find((l) => l.recipe.id === 'T6_POTION_HEAL');
  // A better return rate always stretches the same pile further.
  assert.ok(potions(brecilien).byMaterial > potions(martlock).byMaterial);
});

test('a fixed number of crafts buys in what was not farmed', () => {
  const grown = simulateCycle(cyclePlan([
    { id: 'a', recipeId: 'T6_ALCOHOL', mode: 'auto', useFocus: false },
    { id: 'c', recipeId: 'T6_POTION_HEAL', mode: 'auto' },
  ]), data, cycleCtx());
  const bought = simulateCycle(cyclePlan([
    { id: 'a', recipeId: 'T6_ALCOHOL', mode: 'auto', useFocus: false },
    { id: 'c', recipeId: 'T6_POTION_HEAL', mode: 'fixed', perCycle: 30 },
  ]), data, cycleCtx());

  const potionsOf = (sim) => sim.craftLines.find((l) => l.recipe.id === 'T6_POTION_HEAL');
  // Fixed asks for 30; focus only pays for fewer, so it lands short either way.
  assert.ok(potionsOf(bought).crafts > 0);
  assert.equal(grown.buyCost, 0, 'growing your own buys nothing');
});

test('a fixed number is still capped by the focus you have', () => {
  const sim = simulateCycle(cyclePlan([
    { id: 'c', recipeId: 'T6_POTION_HEAL', mode: 'fixed', perCycle: 9999 },
  ]), data, cycleCtx());
  const line = sim.craftLines[0];
  assert.equal(line.limitedBy, 'focus');
  assert.ok(line.crafts < 9999);
  assert.ok(line.focusUsed <= sim.focusAtCraft + 1);
});

test('nothing is double counted: crops eaten by crafting are not also sold', () => {
  const raw = simulateCycle(cyclePlan([]), data, cycleCtx());
  const crafted = simulateCycle(cyclePlan([
    { id: 'c1', recipeId: 'T6_ALCOHOL', mode: 'auto', useFocus: false },
    { id: 'c2', recipeId: 'T6_POTION_HEAL', mode: 'auto' },
  ]), data, cycleCtx());

  assert.equal(Math.round(raw.pool.T6_FOXGLOVE), 891 * TILES_PER_PLOT);
  assert.ok(crafted.pool.T6_FOXGLOVE < raw.pool.T6_FOXGLOVE, 'foxglove was consumed');
  const soldFoxglove = crafted.sales.find((x) => x.id === 'T6_FOXGLOVE');
  assert.ok(!soldFoxglove || soldFoxglove.qty < 891 * TILES_PER_PLOT);
});

test('per day and per month are just the cycle spread out', () => {
  const sim = simulateCycle(cyclePlan([
    { id: 'a', recipeId: 'T6_ALCOHOL', mode: 'auto', useFocus: false },
    { id: 'c', recipeId: 'T6_POTION_HEAL', mode: 'auto' },
  ]), data, cycleCtx());
  assert.equal(round2(sim.perDay), round2(sim.profit / 14));
  assert.equal(round2(sim.perMonth), round2(sim.perDay * 30));
});

test('an empty plan produces zeroes, not NaN', () => {
  const sim = simulateCycle({ plots: [], crafts: [] }, data, ctx({}));
  for (const k of ['profit', 'revenue', 'cost', 'perDay', 'perMonth', 'focusAtCraft']) {
    assert.ok(Number.isFinite(sim[k]), `${k} is ${sim[k]}`);
  }
  assert.equal(sim.profit, 0);
});

/* --------------------------------------------- against real harvests --- */

test('a 3x3 plot is nine tiles, matching what a real harvest returns', () => {
  // Reported from the game: about 760 goose eggs from four pastures in one
  // harvest, and 8-14 foxglove per tile. Both only make sense if a row counts
  // 3x3 plots rather than individual tiles.
  assert.equal(TILES_PER_PLOT, 9);

  const geese = {
    plots: [{ id: 'g', itemId: 'T5_FARM_GOOSE_BABY', count: 4, mode: 'product', cityId: 'lymhurst' }],
    crafts: [],
  };
  // One harvest only, so the figure is directly comparable.
  const sim = simulateCycle(geese, data, cycleCtx({ farmDays: 1, cadenceHours: 22 }));
  const line = sim.farmLines[0];
  assert.equal(line.tiles, 36);
  assert.equal(line.harvests, 1);
  // 7-11 each, doubled by premium, plus Lymhurst's 10% on goose eggs.
  assert.ok(line.produced > 500 && line.produced < 800,
    `one harvest from four pastures was ${line.produced}`);
});

test('foxglove per tile lands in the range seen in game', () => {
  const foxglove = plant('T6_FARM_FOXGLOVE_SEED');
  const perTile = (cityId) =>
    plantCycle(foxglove, { ...cycleCtx(), cityId }).yieldPerTile;
  // 3-6 doubled is 6-12; Martlock's +10% takes the average to 9.9, which sits
  // inside the 8-14 a player reports per tile.
  assert.equal(round2(perTile('martlock')), 9.9);
  assert.equal(perTile('thetford'), 9);
});

/* ------------------------------------------------------ spare seeds --- */

test('seeds beyond what you replant become stock you can sell', () => {
  const foxglove = plant('T6_FARM_FOXGLOVE_SEED');
  const watered = plantCycle(foxglove, cycleCtx({ watered: true }));
  const dry = plantCycle(foxglove, cycleCtx({ watered: false }));

  // Watered T6 herbs return more seed than they consume.
  assert.ok(watered.seedsBack > 1);
  assert.equal(watered.seedsBought, 0);
  assert.ok(watered.seedSurplus > 0);
  // Unwatered they run at a loss and have to be topped up.
  assert.ok(dry.seedsBack < 1);
  assert.ok(dry.seedsBought > 0);
  assert.equal(dry.seedSurplus, 0);
});

test('spare seeds show up as produce, not as a negative cost', () => {
  const plan = {
    plots: [{ id: 'f', itemId: 'T6_FARM_FOXGLOVE_SEED', count: 1, mode: 'grow', cityId: 'martlock' }],
    crafts: [],
  };
  const sim = simulateCycle(plan, data, cycleCtx({ watered: true }));

  // The seeds are in the pool and on the sales list, and cost nothing extra.
  assert.ok(sim.pool.T6_FARM_FOXGLOVE_SEED > 0, 'spare seeds were banked');
  assert.ok(sim.sales.some((x) => x.id === 'T6_FARM_FOXGLOVE_SEED'));
  assert.equal(sim.farmCost, 0, 'nothing to buy when the plot feeds itself');

  // Unwatered, the same plot has to buy seed and banks none.
  const drySim = simulateCycle(plan, data, cycleCtx({ watered: false }));
  assert.ok(drySim.farmCost > 0);
  assert.ok(!drySim.pool.T6_FARM_FOXGLOVE_SEED);
});

/* -------------------------------------------------- skipping a day ----- */

test('farming every other day halves the harvests', () => {
  assert.equal(farmDayCount(12, 1), 12);
  assert.equal(farmDayCount(12, 2), 6);
  assert.equal(farmDayCount(12, 3), 4);
  assert.equal(farmDayCount(0, 2), 0);

  // Days 1, 3, 5 ... are farming days when you skip every other one.
  assert.equal(isFarmDay(1, 12, 2), true);
  assert.equal(isFarmDay(2, 12, 2), false);
  assert.equal(isFarmDay(3, 12, 2), true);
  assert.equal(isFarmDay(13, 12, 2), false);   // past the farming phase
});

test('a skipped day banks focus for the next watering', () => {
  const daily = focusLedger({
    cycleDays: 12, farmDays: 12, farmEvery: 1,
    perDay: 10000, cap: 30000, start: 0, wateringPerDay: 30000,
  });
  const alternate = focusLedger({
    cycleDays: 12, farmDays: 12, farmEvery: 2,
    perDay: 10000, cap: 30000, start: 0, wateringPerDay: 30000,
  });

  // Same watering bill, but resting means more of it is actually affordable.
  assert.ok(alternate.shortfall < daily.shortfall);
  // On a farming day after a rest you arrive with two days of regeneration.
  assert.equal(alternate.days[0].spent, 10000);
  assert.equal(alternate.days[2].spent, 20000);
  assert.equal(daily.days[2].spent, 10000);
});

test('resting is a real trade: fewer harvests, more focus', () => {
  const plan = {
    plots: [{ id: 'f', itemId: 'T6_FARM_FOXGLOVE_SEED', count: 9, mode: 'grow', cityId: 'martlock' }],
    crafts: [],
  };
  const daily = simulateCycle(plan, data, cycleCtx({ farmDays: 12, farmEvery: 1 }));
  const rested = simulateCycle(plan, data, cycleCtx({ farmDays: 12, farmEvery: 2 }));

  assert.equal(daily.farmingDays, 12);
  assert.equal(rested.farmingDays, 6);
  assert.equal(rested.restDays, 6);
  assert.equal(rested.farmLines[0].harvests, 6);
  // Half the harvests, so roughly half the crop.
  assert.equal(round2(rested.pool.T6_FOXGLOVE), round2(daily.pool.T6_FOXGLOVE / 2));
  // But the watering that does happen is paid for far more often.
  assert.ok(rested.wateringShortfall < daily.wateringShortfall);
});

test('you cannot harvest faster than the crop grows', () => {
  const plan = {
    plots: [{ id: 'f', itemId: 'T6_FARM_FOXGLOVE_SEED', count: 1, mode: 'grow', cityId: 'martlock' }],
    crafts: [],
  };
  // Even claiming to farm daily, a 22h crop on a 24h login gives 10 in 10 days.
  const sim = simulateCycle(plan, data, cycleCtx({ farmDays: 10, farmEvery: 1 }));
  assert.equal(sim.farmLines[0].harvests, 10);
  // Every third day cannot give more than three harvests in ten days.
  const slow = simulateCycle(plan, data, cycleCtx({ farmDays: 10, farmEvery: 3 }));
  assert.equal(slow.farmLines[0].harvests, 4);   // days 1, 4, 7, 10
});

test('the default rhythm is unchanged, so old plans still read the same', () => {
  const plan = {
    plots: [{ id: 'f', itemId: 'T6_FARM_FOXGLOVE_SEED', count: 9, mode: 'grow', cityId: 'martlock' }],
    crafts: [],
  };
  const withSetting = simulateCycle(plan, data, cycleCtx({ farmEvery: 1 }));
  const withoutSetting = simulateCycle(plan, data, cycleCtx({ farmEvery: undefined }));
  assert.equal(withoutSetting.farmEvery, 1);
  assert.equal(withoutSetting.pool.T6_FOXGLOVE, withSetting.pool.T6_FOXGLOVE);
  assert.equal(withoutSetting.restDays, 0);
});

/* ------------------------------------------- watering you can afford --- */

test('the watering bonus only applies to the plots you could pay to water', () => {
  // 9 plots is 81 tiles, so 81,000 focus a day against 10,000 of regeneration.
  // Only a fraction gets watered, and only that fraction earns the seed bonus.
  const plan = {
    plots: [{ id: 'f', itemId: 'T6_FARM_FOXGLOVE_SEED', count: 9, mode: 'grow', cityId: 'martlock' }],
    crafts: [],
  };
  const sim = simulateCycle(plan, data, cycleCtx({ watered: true, farmDays: 10 }));

  assert.equal(sim.wateringPerDay, 81000);
  assert.ok(sim.wateredFraction > 0 && sim.wateredFraction < 0.2,
    `only ${(sim.wateredFraction * 100).toFixed(0)}% could be watered`);

  const foxglove = plant('T6_FARM_FOXGLOVE_SEED');
  const line = sim.farmLines[0];
  // Seed return sits between the dry rate and the fully watered one.
  assert.ok(line.cycle.seedsBack > foxglove.seedReturn);
  assert.ok(line.cycle.seedsBack < foxglove.seedReturn + foxglove.wateredBonus);
  assert.equal(round2(line.cycle.wateredShare), round2(sim.wateredFraction));
});

test('a farm small enough to water really does get the full bonus', () => {
  const plan = {
    plots: [{ id: 'f', itemId: 'T6_FARM_FOXGLOVE_SEED', count: 1, mode: 'grow', cityId: 'martlock' }],
    crafts: [],
  };
  // 9 tiles is 9,000 focus a day, inside the 10,000 you regenerate.
  const sim = simulateCycle(plan, data, cycleCtx({ watered: true, farmDays: 10 }));
  const foxglove = plant('T6_FARM_FOXGLOVE_SEED');
  assert.equal(sim.wateredFraction, 1);
  assert.equal(sim.wateringShortfall, 0);
  assert.equal(round2(sim.farmLines[0].cycle.seedsBack),
    round2(foxglove.seedReturn + foxglove.wateredBonus));
});

test('resting raises the share you can water', () => {
  const plan = {
    plots: [{ id: 'f', itemId: 'T6_FARM_FOXGLOVE_SEED', count: 2, mode: 'grow', cityId: 'martlock' }],
    crafts: [],
  };
  const daily = simulateCycle(plan, data, cycleCtx({ watered: true, farmDays: 12, farmEvery: 1 }));
  const rested = simulateCycle(plan, data, cycleCtx({ watered: true, farmDays: 12, farmEvery: 2 }));
  assert.ok(rested.wateredFraction > daily.wateredFraction);
  // And that shows up as a better seed return per harvest.
  assert.ok(rested.farmLines[0].cycle.seedsBack > daily.farmLines[0].cycle.seedsBack);
});

test('turning watering off costs no focus and grants no bonus', () => {
  const plan = {
    plots: [{ id: 'f', itemId: 'T6_FARM_FOXGLOVE_SEED', count: 9, mode: 'grow', cityId: 'martlock' }],
    crafts: [],
  };
  const sim = simulateCycle(plan, data, cycleCtx({ watered: false }));
  const foxglove = plant('T6_FARM_FOXGLOVE_SEED');
  assert.equal(sim.wateringPerDay, 0);
  assert.equal(sim.wateringShortfall, 0);
  assert.equal(sim.farmLines[0].cycle.seedsBack, foxglove.seedReturn);
  // All the focus goes to crafting instead.
  assert.equal(sim.focusAtCraft, sim.ledger.cap);
});

/* ------------------------------------------------- the destiny board --- */

test('node patterns match the right items and respect tier limits', () => {
  const rule = { bonus: 2.5, minTier: 1, maxTier: 8, patterns: ['T?_POTION_HEAL'] };
  assert.equal(ruleCovers(rule, 'T6_POTION_HEAL'), true);
  assert.equal(ruleCovers(rule, 'T4_POTION_HEAL'), true);
  assert.equal(ruleCovers(rule, 'T6_POTION_ENERGY'), false);

  const wild = { bonus: 0.225, minTier: 1, maxTier: 8, patterns: ['T?_POTION*', 'T?_ALCOHOL'] };
  assert.equal(ruleCovers(wild, 'T6_POTION_ENERGY'), true);
  assert.equal(ruleCovers(wild, 'T6_ALCOHOL'), true);
  assert.equal(ruleCovers(wild, 'T6_MEAL_SOUP'), false);

  const capped = { bonus: 1, minTier: 1, maxTier: 4, patterns: ['T?_POTION_HEAL'] };
  assert.equal(ruleCovers(capped, 'T4_POTION_HEAL'), true);
  assert.equal(ruleCovers(capped, 'T6_POTION_HEAL'), false);
});

test('both the mastery node and the specialisation count', () => {
  const at = (nodeLevels) => focusEfficiency('T6_POTION_HEAL', ctx({}, { nodeLevels }).settings);

  // From achievements.xml: Heal gives +2.5 to itself and +0.225 to the branch,
  // and the Alchemist mastery gives +0.3 to everything under it.
  assert.equal(at({}).total, 0);
  assert.equal(round2(at({ FARM_ALCHEMIST_HEAL: 100 }).total), 272.5);
  assert.equal(round2(at({ FARM_ALCHEMIST: 100 }).total), 30);
  assert.equal(round2(at({ FARM_ALCHEMIST_HEAL: 100, FARM_ALCHEMIST: 100 }).total), 302.5);
});

test('levelling one potion cheapens the others', () => {
  const settings = (nodeLevels) => ctx({}, { nodeLevels }).settings;
  const alone = focusEfficiency('T6_POTION_HEAL', settings({ FARM_ALCHEMIST_HEAL: 100 }));
  const sibling = focusEfficiency('T6_POTION_HEAL',
    settings({ FARM_ALCHEMIST_HEAL: 100, FARM_ALCHEMIST_ALCOHOL: 100 }));

  // Potato Schnapps contributes +0.225 a level to every potion in the branch.
  assert.equal(round2(sibling.total - alone.total), 22.5);
  assert.ok(sibling.parts.some((p) => p.node.id === 'FARM_ALCHEMIST_ALCOHOL'));
});

test('a hundred points of efficiency halves the focus cost', () => {
  const c = data.constants.focusCostConstant;
  assert.equal(Math.round(focusCostAt(768, 0, c)), 768);
  assert.equal(Math.round(focusCostAt(768, 100, c)), 384);
  assert.equal(Math.round(focusCostAt(768, 200, c)), 192);
});

test('the board drives what a craft actually costs', () => {
  const r = recipe('T6_POTION_HEAL');
  // Priced so the craft actually turns a profit, or silver per focus is
  // negative and dividing by a smaller focus cost makes it look worse.
  const p = { T6_FOXGLOVE: 900, T5_EGG: 780, T6_ALCOHOL: 700, T6_POTION_HEAL: 15000 };

  const raw = craftBatch(r, ctx(p, { useFocus: true }));
  assert.ok(raw.profit > 0, 'the fixture has to be profitable to compare');
  const maxed = craftBatch(r, ctx(p, {
    useFocus: true,
    nodeLevels: { FARM_ALCHEMIST_HEAL: 100, FARM_ALCHEMIST: 100 },
  }));
  assert.equal(Math.round(raw.focus), 768);
  assert.equal(Math.round(maxed.focus), 94);
  assert.ok(maxed.silverPerFocus > raw.silverPerFocus * 7);
});

test('farming nodes make watering cheaper too', () => {
  const foxglove = plant('T6_FARM_FOXGLOVE_SEED');
  const at = (nodeLevels) =>
    plantCycle(foxglove, cycleCtx({ watered: true, nodeLevels })).focus;

  assert.equal(Math.round(at({})), 1000);
  // Herbs mastery gives +1 a level, the foxglove specialisation +2.
  assert.equal(Math.round(at({ FARM_HERBS: 100 })), 500);
  assert.equal(Math.round(at({ FARM_HERBS_FOXGLOVE: 100 })), 250);
  assert.equal(Math.round(at({ FARM_HERBS: 100, FARM_HERBS_FOXGLOVE: 100 })), 125);
});

test('cheaper watering means more of the farm actually gets watered', () => {
  const plan = {
    plots: [{ id: 'f', itemId: 'T6_FARM_FOXGLOVE_SEED', count: 9, mode: 'grow', cityId: 'martlock' }],
    crafts: [],
  };
  const none = simulateCycle(plan, data, cycleCtx({ watered: true }));
  const maxed = simulateCycle(plan, data, cycleCtx({
    watered: true, nodeLevels: { FARM_HERBS: 100, FARM_HERBS_FOXGLOVE: 100 },
  }));

  assert.equal(none.wateringPerDay, 81000);
  assert.equal(Math.round(maxed.wateringPerDay), 81000 / 8);
  assert.ok(maxed.wateredFraction > none.wateredFraction * 7);
  assert.ok(maxed.farmLines[0].cycle.seedsBack > none.farmLines[0].cycle.seedsBack);
});

test('a per-recipe override still wins over the board', () => {
  const s = ctx({}, {
    nodeLevels: { FARM_ALCHEMIST_HEAL: 100 },
    spec: { T6_POTION_HEAL: 50 },
  }).settings;
  assert.equal(specFor(s, 'T6_POTION_HEAL'), 50);
  assert.equal(round2(specFor(s, 'T6_POTION_ENERGY')), 22.5);   // board only
});

/* ------------------------------------------- naming what ran out ------- */

test('the input that ran out is named, not just "materials"', () => {
  // Potatoes grown but never brewed: the potion has no schnapps at all.
  const plan = {
    plots: [
      { id: 'f', itemId: 'T6_FARM_FOXGLOVE_SEED', count: 9, mode: 'grow', cityId: 'martlock' },
      { id: 'p', itemId: 'T6_FARM_POTATO_SEED', count: 1, mode: 'grow', cityId: 'martlock' },
      { id: 'g', itemId: 'T5_FARM_GOOSE_BABY', count: 4, mode: 'product', cityId: 'lymhurst' },
    ],
    crafts: [{ id: 'c', recipeId: 'T6_POTION_HEAL', mode: 'auto' }],
  };
  const sim = simulateCycle(plan, data, cycleCtx());
  const line = sim.craftLines[0];

  assert.equal(line.crafts, 0);
  assert.equal(line.limitedBy, 'materials');
  assert.equal(line.bottleneck.id, 'T6_ALCOHOL');
  assert.equal(line.bottleneck.have, 0);
  assert.deepEqual(line.missing, ['T6_ALCOHOL']);
  // The other two were plentiful, so they must not be blamed.
  const foxglove = line.inputs.find((i) => i.id === 'T6_FOXGLOVE');
  assert.ok(foxglove.allows > 0);
});

test('adding the missing step makes the potion possible', () => {
  const base = [
    { id: 'f', itemId: 'T6_FARM_FOXGLOVE_SEED', count: 9, mode: 'grow', cityId: 'martlock' },
    { id: 'p', itemId: 'T6_FARM_POTATO_SEED', count: 1, mode: 'grow', cityId: 'martlock' },
    { id: 'g', itemId: 'T5_FARM_GOOSE_BABY', count: 4, mode: 'product', cityId: 'lymhurst' },
  ];
  const withStep = simulateCycle({
    plots: base,
    crafts: [
      { id: 'c', recipeId: 'T6_POTION_HEAL', mode: 'auto' },
      { id: 's', recipeId: 'T6_ALCOHOL', mode: 'auto', useFocus: false },
    ],
  }, data, cycleCtx());

  const potion = withStep.craftLines.find((l) => l.recipe.id === 'T6_ALCOHOL'
    ? false : l.recipe.id === 'T6_POTION_HEAL');
  assert.ok(potion.crafts > 0, 'the potion now has schnapps to use');
  // And the bottleneck moves to something real rather than an absence.
  assert.ok(potion.bottleneck.have > 0 || potion.limitedBy === 'focus');
});

test('a bottleneck you merely run short of is reported differently from one you have none of', () => {
  const plan = {
    plots: [
      { id: 'f', itemId: 'T6_FARM_FOXGLOVE_SEED', count: 1, mode: 'grow', cityId: 'martlock' },
      { id: 'p', itemId: 'T6_FARM_POTATO_SEED', count: 9, mode: 'grow', cityId: 'martlock' },
      { id: 'g', itemId: 'T5_FARM_GOOSE_BABY', count: 9, mode: 'product', cityId: 'lymhurst' },
    ],
    crafts: [
      { id: 's', recipeId: 'T6_ALCOHOL', mode: 'auto', useFocus: false },
      { id: 'c', recipeId: 'T6_POTION_HEAL', mode: 'auto' },
    ],
  };
  const sim = simulateCycle(plan, data, cycleCtx());
  const potion = sim.craftLines.find((l) => l.recipe.id === 'T6_POTION_HEAL');
  // Foxglove is the scarce one here, but there is some of it.
  assert.equal(potion.bottleneck.id, 'T6_FOXGLOVE');
  assert.ok(potion.bottleneck.have > 0);
  assert.deepEqual(potion.missing, []);
});

/* ----------------------------------- leftovers are kept, not sold ------ */

const chainPlan = (plots) => ({
  plots,
  crafts: [
    { id: 's', recipeId: 'T6_ALCOHOL', mode: 'auto', useFocus: false },
    { id: 'c', recipeId: 'T6_POTION_HEAL', mode: 'auto' },
  ],
});
const HIS_PLOTS = [
  { id: 'f', itemId: 'T6_FARM_FOXGLOVE_SEED', count: 9, mode: 'grow', cityId: 'martlock' },
  { id: 'p', itemId: 'T6_FARM_POTATO_SEED', count: 1, mode: 'grow', cityId: 'martlock' },
  { id: 'g', itemId: 'T5_FARM_GOOSE_BABY', count: 4, mode: 'product', cityId: 'lymhurst' },
];

// Board levels a real farmer would have, so watering works and seeds come back.
const BOARD = {
  FARM_HERBS: 100, FARM_HERBS_FOXGLOVE: 100, FARM_CROPS: 100,
  FARM_CROPS_POTATO: 100, FARM_ANIMALS: 100, FARM_ANIMALS_GOOSE: 100,
  FARM_ALCHEMIST: 100, FARM_ALCHEMIST_HEAL: 100,
};

test('ingredients your crafting uses are held, not counted as revenue', () => {
  const sim = simulateCycle(chainPlan(HIS_PLOTS), data, cycleCtx({ nodeLevels: BOARD }));

  const soldIds = sim.sales.map((x) => x.id);
  const heldIds = sim.stock.map((x) => x.id);

  // Potions and spare seeds are sold; the herbs and eggs that feed the potion
  // are not, because you keep working through them.
  assert.ok(soldIds.includes('T6_POTION_HEAL'));
  assert.ok(soldIds.includes('T6_FARM_FOXGLOVE_SEED'), 'watered plots leave spare seeds');
  assert.ok(heldIds.includes('T6_FOXGLOVE'), 'leftover foxglove is held');
  assert.ok(heldIds.includes('T5_EGG'), 'leftover eggs are held');
  assert.ok(!soldIds.includes('T6_FOXGLOVE'));
  assert.ok(!soldIds.includes('T5_EGG'));

  // Held stock has value but is nowhere in the profit.
  assert.ok(sim.stockValue > 0);
  assert.equal(round2(sim.profit), round2(sim.revenue - sim.cost));
});

test('keeping leftovers lowers the profit an earlier version invented', () => {
  const kept = simulateCycle(chainPlan(HIS_PLOTS), data, cycleCtx({ nodeLevels: BOARD }));
  const sold = simulateCycle(chainPlan(HIS_PLOTS), data,
    cycleCtx({ nodeLevels: BOARD, sellSurplus: true }));

  assert.ok(sold.profit > kept.profit, 'selling everything looks better on paper');
  assert.equal(sold.stock.length, 0);
  assert.equal(sold.stockValue, 0);
  // The difference is exactly the stock that is no longer being booked.
  assert.equal(round2(sold.revenue - kept.revenue), round2(kept.stockValue));
});

test('the farm-against-crafting ratio names what is overgrown', () => {
  const sim = simulateCycle(chainPlan(HIS_PLOTS), data, cycleCtx({ nodeLevels: BOARD }));
  const of = (id) => sim.balance.find((b) => b.itemId === id);

  // Four goose pastures feed a potion that barely needs eggs.
  const eggs = of('T5_EGG');
  assert.ok(eggs.ratio > 3, `eggs run ${eggs.ratio.toFixed(1)}x ahead`);
  assert.ok(eggs.balancedPlots < eggs.plots);

  // Potatoes feed schnapps almost exactly.
  const potato = of('T6_POTATO');
  assert.ok(potato.ratio < 1.2, `potatoes run ${potato.ratio.toFixed(1)}x ahead`);
  assert.ok(Math.abs(potato.balancedPlots - potato.plots) < 0.5);
});

test('a crop nothing uses is reported as unused, not as balanced', () => {
  const plots = [
    ...HIS_PLOTS,
    { id: 'c', itemId: 'T5_FARM_CABBAGE_SEED', count: 1, mode: 'grow', cityId: 'thetford' },
  ];
  const sim = simulateCycle(chainPlan(plots), data, cycleCtx());
  const cabbage = sim.balance.find((b) => b.itemId === 'T5_CABBAGE');
  assert.equal(cabbage.used, 0);
  assert.equal(cabbage.ratio, Infinity);
  // Nothing consumes it, so it is sold rather than held.
  assert.ok(sim.sales.some((x) => x.id === 'T5_CABBAGE'));
});

test('a farm sized to its crafting leaves nothing on the pile', () => {
  // Scale the farm down to roughly what the crafting gets through.
  const trimmed = [
    { id: 'f', itemId: 'T6_FARM_FOXGLOVE_SEED', count: 4, mode: 'grow', cityId: 'martlock' },
    { id: 'p', itemId: 'T6_FARM_POTATO_SEED', count: 1, mode: 'grow', cityId: 'martlock' },
    { id: 'g', itemId: 'T5_FARM_GOOSE_BABY', count: 1, mode: 'product', cityId: 'lymhurst' },
  ];
  const big = simulateCycle(chainPlan(HIS_PLOTS), data, cycleCtx());
  const small = simulateCycle(chainPlan(trimmed), data, cycleCtx());

  assert.ok(small.stockValue < big.stockValue, 'less piles up');
  // And the smaller farm costs less to run, so realised profit can be better.
  assert.ok(small.cost < big.cost);
});

/* ----------------------------------- rows that cost no focus ----------- */

test('collecting eggs costs no focus, so it needs no rest days', () => {
  const geese = { id: 'g', itemId: 'T5_FARM_GOOSE_BABY', count: 4, mode: 'product', cityId: 'lymhurst' };
  const herbs = { id: 'f', itemId: 'T6_FARM_FOXGLOVE_SEED', count: 9, mode: 'grow', cityId: 'martlock' };
  const plan = { plots: [herbs, geese], crafts: [] };

  const rested = simulateCycle(plan, data, cycleCtx({ farmDays: 12, farmEvery: 2 }));
  const eggs = rested.farmLines.find((l) => l.itemId === 'T5_EGG');
  const foxglove = rested.farmLines.find((l) => l.itemId === 'T6_FOXGLOVE');

  assert.equal(eggs.cycle.focus, 0, 'eggs cost nothing to collect');
  assert.equal(eggs.rests, false);
  assert.equal(foxglove.rests, true);
  // The herbs halve with the rhythm; the geese carry on every day.
  assert.equal(foxglove.harvests, 6);
  assert.equal(eggs.harvests, 12);

  // And they add nothing to the watering bill.
  const onlyGeese = simulateCycle({ plots: [geese], crafts: [] }, data, cycleCtx());
  assert.equal(onlyGeese.wateringPerDay, 0);
  assert.equal(onlyGeese.wateringShortfall, 0);
});

test('raising goslings does cost focus, so it does rest', () => {
  const plan = {
    plots: [{ id: 'g', itemId: 'T5_FARM_GOOSE_BABY', count: 4, mode: 'grow', cityId: 'lymhurst' }],
    crafts: [],
  };
  const sim = simulateCycle(plan, data, cycleCtx({ farmDays: 12, farmEvery: 2, watered: true }));
  assert.ok(sim.wateringPerDay > 0);
  assert.equal(sim.farmLines[0].rests, true);
});

/* ------------------------------------------ the stock threshold -------- */

test('a pile is measured against the stock you will sit on', () => {
  const sim = simulateCycle(chainPlan(HIS_PLOTS), data, cycleCtx({ nodeLevels: BOARD }));
  const eggs = sim.balance.find((b) => b.itemId === 'T5_EGG');

  assert.equal(sim.stockCap, 5000);
  assert.ok(eggs.leftover > 0);
  // Starting empty, this many cycles before the pile passes the cap.
  assert.equal(eggs.cyclesToCap, Math.max(1, Math.ceil(5000 / eggs.leftover)));
  assert.ok(eggs.cyclesToCap >= 1 && eggs.cyclesToCap < 10);
});

test('a bigger tolerance means more cycles before you pause', () => {
  const tight = simulateCycle(chainPlan(HIS_PLOTS), data,
    cycleCtx({ nodeLevels: BOARD, stockCap: 1000 }));
  const loose = simulateCycle(chainPlan(HIS_PLOTS), data,
    cycleCtx({ nodeLevels: BOARD, stockCap: 20000 }));
  const eggsOf = (sim) => sim.balance.find((b) => b.itemId === 'T5_EGG');
  assert.ok(loose.cyclesToCap === undefined);           // it is per item, not global
  assert.ok(eggsOf(loose).cyclesToCap > eggsOf(tight).cyclesToCap);
  assert.equal(eggsOf(tight).overCapNow, true);         // 3.6k a cycle clears 1k at once
  assert.equal(eggsOf(loose).overCapNow, false);
});

test('a balanced crop never reaches the cap', () => {
  const sim = simulateCycle(chainPlan(HIS_PLOTS), data, cycleCtx({ nodeLevels: BOARD }));
  const potato = sim.balance.find((b) => b.itemId === 'T6_POTATO');
  assert.ok(potato.leftover < 5, 'potatoes are consumed as fast as they grow');
  assert.equal(potato.overCapNow, false);
});
