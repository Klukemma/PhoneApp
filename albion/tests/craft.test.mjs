// The craft-to-order engine: weapons, armour, refining and the Black Market.
//
// These read the real dumps, so a number here is either the game's or a bug.

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bestCityFor, cityBonus, craftPnL, haulOf, mixFor, outputOf, qualityMix,
  qualityPoints, returnRate, simulateCycle, taxRate,
} from '../js/calc.js';

const data = JSON.parse(
  readFileSync(new URL('../data/gamedata.json', import.meta.url), 'utf8'));
const raw = JSON.parse(
  readFileSync(new URL('../data/equipment.json', import.meta.url), 'utf8'));

// The app rebuilds the stripped rows on load; the tests use the same shape.
const gear = raw.recipes.map((r) => ({
  enchant: 0, amount: 1, silver: 0, refine: false, ...r,
  name: raw.items[r.id]?.name || r.id,
  tier: raw.items[r.id]?.tier ?? 0,
  group: raw.groups[r.category] || 'gear',
}));
const all = new Map([...data.recipes, ...gear].map((r) => [r.id, r]));
const recipeOf = (id) => all.get(id) || null;

const PRICES = {
  T4_ORE: 200, T3_ORE: 120, T4_METALBAR: 700, T3_METALBAR: 400,
  T4_HIDE: 220, T3_HIDE: 130, T4_LEATHER: 760, T3_LEATHER: 420,
  T4_MAIN_SWORD: 22000,
};
const BLACK = { T4_MAIN_SWORD: 31000 };

const ctx = (over = {}) => ({
  recipeOf,
  priceOf: (id) => PRICES[id] ?? 0,
  settings: {
    ...data.constants,
    cities: data.cities,
    focusNodes: [...data.focusNodes, ...raw.focusNodes],
    quality: data.quality,
    nodeLevels: {}, spec: {}, specLevel: 0,
    premium: true, useFocus: true, stationFee: {},
    ...(over.settings || {}),
  },
  cityId: over.cityId || 'lymhurst',
  qty: over.qty ?? 100,
  make: over.make || new Set(),
  sellPriceOf: over.sellPriceOf,
  sellInstant: over.sellInstant,
});

/* ------------------------------------------------- the recipes exist --- */

test('weapons and armour are in the list, with the materials the game names', () => {
  const sword = recipeOf('T4_MAIN_SWORD');
  assert.ok(sword, 'the sword recipe exists');
  assert.equal(sword.category, 'sword');
  assert.equal(sword.group, 'weapon');
  assert.equal(sword.focus, 1286);
  assert.deepEqual(sword.inputs, [
    { id: 'T4_METALBAR', count: 16 },
    { id: 'T4_LEATHER', count: 8 },
  ]);

  // Armour enchants to .4, one level further than a potion does, and each
  // level swaps the material for its own enchanted version rather than
  // stirring an extract into the same one.
  const plate = recipeOf('T4_ARMOR_PLATE_SET1@3');
  assert.ok(plate);
  assert.equal(plate.enchant, 3);
  assert.deepEqual(plate.inputs, [{ id: 'T4_METALBAR_LEVEL3', count: 16 }]);
  assert.ok(recipeOf('T4_ARMOR_PLATE_SET1@4'), 'equipment goes to .4');

  // Refining eats the raw resource AND one of the tier below.
  const bar = recipeOf('T4_METALBAR');
  assert.equal(bar.refine, true);
  assert.deepEqual(bar.inputs, [
    { id: 'T4_ORE', count: 2 },
    { id: 'T3_METALBAR', count: 1 },
  ]);
});

test('an artefact is charged in full, because the game never hands one back', () => {
  // items.xml marks the artefact maxreturnamount="0" on every weapon that
  // needs one, and on a T8 that artefact is most of the bill.
  const artefact = gear.filter((r) => r.inputs.some((i) => i.noReturn));
  assert.ok(artefact.length > 100, 'plenty of recipes have one');
  const one = artefact.find((r) => r.group === 'weapon');
  const marked = one.inputs.find((i) => i.noReturn);
  assert.ok(marked, `${one.id} has an input the game keeps`);
});

/* ------------------------------------------------------- the costing --- */

test('a run of swords costs what the return rate says it costs', () => {
  const run = craftPnL('T4_MAIN_SWORD', ctx());
  // Lymhurst specialises in swords: 18 base + 15 specialty + 59 focus.
  const rrr = returnRate(18 + 15 + 59);
  assert.equal(Math.round(run.steps[0].batch.rrr * 10000), Math.round(rrr * 10000));

  // 100 swords is 100 crafts; materials are the nominal count less what
  // comes back.
  assert.equal(run.crafts, 100);
  assert.equal(run.focus, 1286 * 100);
  const bars = run.buys.find((b) => b.id === 'T4_METALBAR');
  const leather = run.buys.find((b) => b.id === 'T4_LEATHER');
  assert.equal(Math.round(bars.qty), Math.round(16 * 100 * (1 - rrr)));
  assert.equal(Math.round(leather.qty), Math.round(8 * 100 * (1 - rrr)));
  assert.equal(Math.round(run.buyCost),
    Math.round(bars.qty * 700 + leather.qty * 760));

  // And the money adds up the way the screen prints it.
  assert.equal(run.gross, 100 * 22000);
  assert.equal(Math.round(run.revenue),
    Math.round(run.gross * (1 - taxRate(ctx().settings))));
  assert.equal(Math.round(run.profit),
    Math.round(run.revenue - run.buyCost - run.fees));
});

test('the city you stand in moves the bill', () => {
  const lym = craftPnL('T4_MAIN_SWORD', ctx({ cityId: 'lymhurst' }));   // sword city
  const mar = craftPnL('T4_MAIN_SWORD', ctx({ cityId: 'martlock' }));   // not
  assert.ok(lym.buyCost < mar.buyCost, 'the specialty city buys fewer bars');
  assert.equal(lym.focus, mar.focus, 'and the focus is the same either way');
});

test('refining your own bars trades silver for focus', () => {
  const buy = craftPnL('T4_MAIN_SWORD', ctx());
  const make = craftPnL('T4_MAIN_SWORD',
    ctx({ make: new Set(['T4_METALBAR', 'T4_LEATHER']) }));

  assert.ok(make.buyCost < buy.buyCost, 'ore is cheaper than bars');
  assert.ok(make.focus > buy.focus, 'but refining costs focus of its own');
  // The shopping list moves one level down the tree: ore and the tier below,
  // not bars.
  const ids = make.buys.map((b) => b.id).sort();
  assert.deepEqual(ids,
    ['T3_LEATHER', 'T3_METALBAR', 'T4_HIDE', 'T4_ORE'].sort());
  // And the steps are ordered so you do the refining before the smithing.
  assert.equal(make.steps.at(-1).recipe.id, 'T4_MAIN_SWORD');
  assert.equal(make.steps.at(-1).target, true);
});

test('making it yourself only goes as deep as you asked', () => {
  const one = craftPnL('T4_MAIN_SWORD', ctx({ make: new Set(['T4_METALBAR']) }));
  assert.ok(one.buys.some((b) => b.id === 'T3_METALBAR'),
    'the tier below is bought, not refined');
  const two = craftPnL('T4_MAIN_SWORD',
    ctx({ make: new Set(['T4_METALBAR', 'T3_METALBAR']) }));
  assert.ok(two.buys.some((b) => b.id === 'T3_ORE'), 'until you say otherwise');
  assert.ok(!two.buys.some((b) => b.id === 'T3_METALBAR'));
});

/* --------------------------------------------------- the black market -- */

test('the Black Market pays no setup fee, because you are taking an order', () => {
  const market = craftPnL('T4_MAIN_SWORD', ctx());
  const black = craftPnL('T4_MAIN_SWORD', ctx({
    sellPriceOf: (id) => BLACK[id] ?? 0, sellInstant: true,
  }));
  const s = ctx().settings;
  // Premium halves the transaction tax: 8 -> 4. Listing adds the 2.5 setup.
  assert.equal(Math.round(market.tax * 1000) / 10, 6.5);
  assert.equal(Math.round(black.tax * 1000) / 10, 4);
  assert.equal(black.tax, taxRate(s, { instant: true }));
  assert.equal(market.tax, taxRate(s));

  assert.equal(black.unitPrice, 31000);
  assert.equal(Math.round(black.revenue), Math.round(100 * 31000 * 0.96));
  assert.ok(black.profit > market.profit, 'which is why it is worth the walk');
  assert.equal(black.buyCost, market.buyCost, 'the making costs the same');
});

/* -------------------------------------------------------- honesty ------ */

test('a run with an unpriced thing in it says so rather than reading as free', () => {
  const run = craftPnL('T4_MAIN_SWORD', ctx({
    settings: {}, sellPriceOf: () => 0,
  }));
  assert.ok(run.missing.includes('T4_MAIN_SWORD'), 'the output has no price');
  assert.equal(run.revenue, 0);

  // An unpriced input is caught the same way.
  const bare = craftPnL('T4_MAIN_SWORD', {
    ...ctx(), priceOf: (id) => (id === 'T4_MAIN_SWORD' ? 22000 : 0),
  });
  assert.ok(bare.missing.includes('T4_METALBAR'));
});

test('a potion is costed by the same engine as a sword', () => {
  // This is the "buy the materials and only brew" case: no farm anywhere in
  // it, just a shopping list and a focus bill.
  const run = craftPnL('T6_POTION_HEAL', {
    ...ctx({ cityId: 'brecilien' }),
    priceOf: (id) => ({
      T6_POTION_HEAL: 2400, T6_FOXGLOVE: 260, T6_ALCOHOL: 900, T5_EGG: 320,
    })[id] ?? 0,
    qty: 100,
  });
  assert.equal(run.missing.length, 0);
  // The recipe makes five at a time, so a hundred potions is twenty crafts.
  assert.equal(run.crafts, 20);
  assert.equal(run.qty, 100);
  assert.ok(run.buys.length === 3, 'all three ingredients are bought');
  assert.equal(Math.round(run.profit),
    Math.round(run.revenue - run.buyCost - run.fees));
});

test('the station fee follows the item, not a flat number per craft', () => {
  const free = craftPnL('T4_MAIN_SWORD', ctx());
  const paid = craftPnL('T4_MAIN_SWORD',
    ctx({ settings: { stationFee: { lymhurst: 400 } } }));
  assert.equal(free.fees, 0, 'nothing posted, nothing charged');
  assert.ok(paid.fees > 0);
  assert.equal(Math.round(paid.profit),
    Math.round(paid.revenue - paid.buyCost - paid.fees));
});

/* ------------------------------------------------------------ quality -- */

test('the quality table and the points that move it come from the game', () => {
  // gamedata.xml <CraftingQualityChances>: 689/250/50/10/1 out of a thousand.
  assert.deepEqual(data.quality.weights,
    { 1: 689, 2: 250, 3: 50, 4: 10, 5: 1 });
  // <ActionFocus><CraftingQuality bonus="50"/>
  assert.equal(data.constants.focusQualityBonus, 50);
  // <QualityLevels>, which is the only thing the dumps say a level DOES.
  assert.deepEqual(data.quality.itemPowerBonus, { 2: 20, 3: 40, 4: 60, 5: 100 });

  // The same nodes that cheapen focus also raise quality, in the same shape.
  const swords = raw.focusNodes.find((n) => n.id === 'CRAFT_SWORDS');
  assert.ok(swords.rules.length, 'it cheapens focus');
  assert.ok(swords.qualityRules.length, 'and it raises quality');
  assert.equal(swords.qualityRules[0].bonus, 0.75);
  assert.equal(swords.qualityRules[0].minTier, 4, 'nothing below T4 gets any');
  // Farming has none of it: a potion has no quality.
  assert.ok(data.focusNodes.every((n) => !n.qualityRules));
});

test('quality points add up from the board and from focus', () => {
  const s = (nodeLevels, useFocus) => ({ ...ctx().settings, nodeLevels, useFocus });
  const at = (nodeLevels, useFocus) =>
    qualityPoints('T4_MAIN_SWORD', s(nodeLevels, useFocus)).total;

  assert.equal(at({}, false), 0);
  assert.equal(at({}, true), 50, 'focus alone is the published 50');
  // Mastery is 0.75 a level, so 100 levels is 75, plus the 50 from focus.
  assert.equal(at({ CRAFT_SWORDS: 100 }, true), 125);
  // The specialisation is 6 a level on its own item plus 0.75 to the branch.
  assert.equal(at({ CRAFT_SWORDS: 100, CRAFT_SWORDS_SWORD: 100 }, true), 800);
  // And a tier the rules do not cover gets nothing from the board.
  assert.equal(qualityPoints('T3_MAIN_SWORD',
    s({ CRAFT_SWORDS: 100, CRAFT_SWORDS_SWORD: 100 }, false)).total, 0);
});

test('the mix stays sane at every level of investment', () => {
  const s = ctx().settings;
  const shares = (points) => qualityMix(points, s);
  const sum = (m) => Object.values(m).reduce((a, b) => a + b, 0);

  const none = shares(0);
  assert.equal(Math.round(sum(none) * 1000), 1000, 'it is a distribution');
  // With no bonus it is the published table exactly.
  assert.equal(Math.round(none[1] * 1000) / 10, 68.9);
  assert.equal(Math.round(none[2] * 1000) / 10, 25);

  // More points always means less plain and more of everything else, and
  // plain never goes negative however deep the investment.
  let last = none;
  for (const p of [50, 125, 400, 800, 5000]) {
    const now = shares(p);
    assert.equal(Math.round(sum(now) * 1000), 1000);
    assert.ok(now[1] < last[1], `${p}: less plain than before`);
    assert.ok(now[1] > 0, `${p}: plain never goes to zero`);
    assert.ok(now[5] > last[5], `${p}: more masterpieces than before`);
    last = now;
  }
});

test('your own mix beats the model, and blank means use the model', () => {
  const base = ctx().settings;
  const modelled = mixFor('T4_MAIN_SWORD', base);
  assert.equal(modelled.source, 'model');

  const mine = mixFor('T4_MAIN_SWORD',
    { ...base, qualityMix: { 1: 20, 2: 50, 3: 20, 4: 8, 5: 2 } });
  assert.equal(mine.source, 'yours');
  // Entered as shares of anything, normalised to a distribution.
  assert.equal(Math.round(mine.mix[1] * 100), 20);
  assert.equal(Math.round(mine.mix[5] * 100), 2);

  // Counts off a crafting log work as well as percentages.
  const counted = mixFor('T4_MAIN_SWORD',
    { ...base, qualityMix: { 1: 40, 2: 100, 3: 40, 4: 16, 5: 4 } });
  assert.equal(Math.round(counted.mix[1] * 100), 20);

  // An empty one falls back rather than dividing by zero.
  assert.equal(mixFor('T4_MAIN_SWORD', { ...base, qualityMix: {} }).source, 'model');
});

test('quality is most of the money on a sword, and it is never invented', () => {
  const s = {
    ...ctx().settings,
    nodeLevels: { CRAFT_SWORDS: 100, CRAFT_SWORDS_SWORD: 100 },
  };
  const { mix } = mixFor('T4_MAIN_SWORD', s);
  const byQuality = { 1: 22000, 2: 26000, 3: 34000, 4: 48000, 5: 90000 };
  const run = (over) => craftPnL('T4_MAIN_SWORD', {
    ...ctx(), settings: s, qty: 100, ...over,
  });

  const plain = run({});
  const graded = run({ sellMix: mix, sellPriceAt: (id, q) => byQuality[q] ?? 0 });
  assert.equal(plain.unitPrice, 22000);
  assert.ok(graded.unitPrice > plain.unitPrice);
  assert.ok(graded.qualityUplift > 0.15, 'worth more than a sixth again');
  assert.equal(Math.round(graded.profit),
    Math.round(graded.revenue - graded.buyCost - graded.fees));

  // A level nobody has priced is counted at the plain price, which understates
  // the run rather than reading as free — and it says which ones it guessed.
  const partial = run({
    sellMix: mix,
    sellPriceAt: (id, q) => (q <= 2 ? byQuality[q] : 0),
  });
  assert.deepEqual(partial.qualityGuessed, [3, 4, 5]);
  assert.ok(partial.unitPrice < graded.unitPrice);
  assert.ok(partial.unitPrice > plain.unitPrice);
});

/* --------------------------------------------------------- many cities - */

test('a city specialises in refining or in smithing, never in both', () => {
  const s = ctx().settings;
  // craftingmodifiers.xml: ore is Thetford at +40, swords are Lymhurst at +15.
  assert.equal(bestCityFor('ore', s).id, 'thetford');
  assert.equal(bestCityFor('hide', s).id, 'martlock');
  assert.equal(bestCityFor('fiber', s).id, 'lymhurst');
  assert.equal(bestCityFor('wood', s).id, 'fortsterling');
  assert.equal(bestCityFor('rock', s).id, 'bridgewatch');
  // So a sword made of your own bars is genuinely more than one city.
  assert.notEqual(bestCityFor('sword', s).id, bestCityFor('ore', s).id);
});

test('spreading a run across cities buys less and carries more', () => {
  const make = new Set(['T4_METALBAR', 'T4_LEATHER']);
  const s = { ...ctx().settings, items: { ...data.items, ...raw.items }, carryWeight: 1500 };
  const run = (cityOf) => craftPnL('T4_MAIN_SWORD', {
    ...ctx(), settings: s, qty: 100, make, cityId: 'lymhurst', cityOf,
  });

  const one = run(null);
  const best = run((r) => bestCityFor(r.category, s).id);

  // Every step in one place: nothing moves, and the refining pays the flat base.
  assert.ok(one.steps.every((x) => x.cityId === 'lymhurst'));
  assert.deepEqual(one.legs, []);

  // Each step where it is best: the bars are smelted in Thetford and the
  // leather tanned in Martlock, and both have to be carried to the forge.
  const at = (id) => best.steps.find((x) => x.recipe.id === id).cityId;
  assert.equal(at('T4_METALBAR'), 'thetford');
  assert.equal(at('T4_LEATHER'), 'martlock');
  assert.equal(at('T4_MAIN_SWORD'), 'lymhurst');
  assert.ok(best.buyCost < one.buyCost, 'a better return rate buys fewer materials');
  assert.equal(best.legs.length, 2);
  assert.ok(best.legs.every((l) => l.to === 'lymhurst'));
  assert.ok(best.legs.every((l) => l.weight > 0 && l.trips >= 1));
});

test('the weight is the game’s and the price of a ride is yours', () => {
  const items = { ...data.items, ...raw.items };
  // items.xml gives a steel bar 0.51 and a broadsword 5.1.
  assert.equal(items.T4_METALBAR.weight, 0.51);
  assert.equal(items.T4_MAIN_SWORD.weight, 5.1);

  const lines = [{ id: 'T4_METALBAR', qty: 1000 }, { id: 'T4_MAIN_SWORD', qty: 10 }];
  const free = haulOf(lines, { items });
  assert.equal(Math.round(free.weight), Math.round(1000 * 0.51 + 10 * 5.1));
  assert.equal(free.cost, 0, 'nothing is charged until you say what a ride costs');
  assert.equal(free.trips, null, 'and no trips until you say what you can carry');
  // Heaviest first, so the list opens with what actually fills the bags.
  assert.equal(free.items[0].id, 'T4_METALBAR');

  const paid = haulOf(lines, { items, carryWeight: 200, haulSilverPerWeight: 5 });
  assert.equal(paid.trips, Math.ceil(free.weight / 200));
  assert.equal(Math.round(paid.cost), Math.round(free.weight * 5));

  // An item with no published weight is not a free ride, it is an unknown,
  // and it simply does not add to the load rather than counting as zero kilos
  // of something real.
  assert.equal(haulOf([{ id: 'NOT_A_REAL_ITEM', qty: 99 }], { items }).weight, 0);
});

/* ------------------------------------------------ what quality cannot do */

test('a tool can never come out above plain, so it is never quoted an uplift', () => {
  // items.xml pins 72 recipes at maxqualitylevel="1" - every tool and every
  // piece of gathering gear.
  const pick = recipeOf('T4_2H_TOOL_PICK');
  assert.ok(pick);
  assert.equal(pick.maxQuality, 1);
  assert.equal(recipeOf('T4_MAIN_SWORD').maxQuality, undefined, 'a sword is not capped');

  const s = {
    ...ctx().settings,
    nodeLevels: { CRAFT_TOOL: 100, CRAFT_TOOL_PICK: 100 },
  };
  const capped = mixFor('T4_2H_TOOL_PICK', s, 1);
  assert.equal(capped.mix[1], 1, 'all of it is plain');
  assert.equal(capped.mix[5], 0);
  // Even a mix you typed in yourself cannot conjure a quality the item has no
  // room for.
  const forced = mixFor('T4_2H_TOOL_PICK',
    { ...s, qualityMix: { 1: 10, 5: 90 } }, 1);
  assert.equal(forced.mix[5], 0);
  assert.equal(forced.mix[1], 1);
});

/* ------------------------------------------------- batches, not fractions */

test('a batch is a batch: potions come five at a time', () => {
  // items.xml T6_POTION_HEAL: amountcrafted="5", 72 foxglove + 18 egg +
  // 18 alcohol, 768 focus. Asking for seven is two batches and ten potions,
  // because there is no button for four fifths of a craft.
  const potion = data.recipes.find((r) => r.id === 'T6_POTION_HEAL');
  assert.equal(potion.amount, 5);
  assert.deepEqual(potion.inputs, [
    { id: 'T6_FOXGLOVE', count: 72 },
    { id: 'T5_EGG', count: 18 },
    { id: 'T6_ALCOHOL', count: 18 },
  ]);

  const run = (qty) => craftPnL('T6_POTION_HEAL', {
    recipeOf: (id) => data.recipes.find((r) => r.id === id) || null,
    qty,
    priceOf: (id) => ({
      T6_FOXGLOVE: 260, T5_EGG: 320, T6_ALCOHOL: 900, T6_POTION_HEAL: 2400,
    })[id] ?? 0,
    settings: ctx().settings,
    cityId: 'brecilien',
  });

  for (const [asked, crafts, made] of [[1, 1, 5], [5, 1, 5], [7, 2, 10],
    [10, 2, 10], [100, 20, 100]]) {
    const r = run(asked);
    assert.equal(r.crafts, crafts, `${asked} asked -> ${crafts} batches`);
    assert.equal(r.qty, made, `${asked} asked -> ${made} made`);
    assert.equal(r.asked, asked);
    assert.equal(r.perBatch, 5);
    assert.ok(Number.isInteger(r.crafts), 'never a fraction of a batch');
  }
});

test('you must bring the whole recipe, because the return comes back after', () => {
  /* The station takes the full amount every time and hands the return over
   * once the craft finishes - localization.xml "Saved {0} x{1}!", and
   * "Inventory full, saved resources are lost!" if there is no room. So the
   * returns fund later batches and never the first one: one batch of Major
   * Healing Potion is 72 foxglove in your bags whatever your rate is. */
  const run = (qty) => craftPnL('T6_POTION_HEAL', {
    recipeOf: (id) => data.recipes.find((r) => r.id === id) || null,
    qty,
    priceOf: (id) => ({
      T6_FOXGLOVE: 260, T5_EGG: 320, T6_ALCOHOL: 900, T6_POTION_HEAL: 2400,
    })[id] ?? 0,
    settings: ctx().settings,
    cityId: 'brecilien',
  });

  const one = run(5);
  const fox = one.buys.find((b) => b.id === 'T6_FOXGLOVE');
  assert.equal(fox.perCraft, 72, 'what the station demands per press');
  assert.equal(fox.qty, 72, 'and so what you have to turn up with');
  assert.ok(fox.net < fox.qty, 'though the batch does not consume all of it');
  // The bill is still the net figure, because the rest is yours at the end.
  assert.equal(Math.round(fox.cost), Math.round(fox.net * 260));

  // Once the run is long enough for the returns to circulate, what you buy is
  // simply what the run consumes.
  const many = run(100);
  const fox100 = many.buys.find((b) => b.id === 'T6_FOXGLOVE');
  assert.equal(Math.round(fox100.qty), Math.round(fox100.net));
  assert.equal(Math.round(fox100.qty), Math.round(72 * 20 * (1 - many.steps[0].batch.rrr)));
  // And never less than one batch, whatever the rate.
  assert.ok(fox100.qty >= fox100.perCraft);
});

test('a pile smaller than one batch is worth no crafts at all', () => {
  // Over a run the return rate stretches a pile; it cannot conjure the first
  // batch out of less than the recipe asks for.
  const plan = {
    plots: [],
    crafts: [{ id: 'c1', recipeId: 'T6_POTION_HEAL', mode: 'fill' }],
  };
  const c = (prices) => ({
    priceOf: (id) => prices[id] ?? 0,
    settings: { ...ctx().settings, craftCity: 'brecilien', cycleDays: 1, farmDays: 1 },
  });
  const P = { T6_FOXGLOVE: 260, T5_EGG: 320, T6_ALCOHOL: 900, T6_POTION_HEAL: 2400 };
  // Nothing on the pile and no buying: fill mode makes nothing.
  const sim = simulateCycle(plan, data, c(P));
  const line = sim.craftLines.find((l) => l.recipe.id === 'T6_POTION_HEAL');
  const short = line.inputs.find((i) => i.have < i.count);
  if (short) assert.equal(short.allows, 0, `${short.id}: under one batch is zero crafts`);
});

/* --------------------------------------------- moving where you craft -- */

test('a craft job with no city of its own follows the setting', () => {
  /* simulateCycle prefers a job's own cityId to the craftCity setting, so a
   * job carrying one is welded to that city - which made "tap to move" quote
   * the same profit for all eleven cities and collapse to one dead row. */
  const plots = [{
    id: 'f', itemId: 'T6_FARM_FOXGLOVE_SEED', count: 5, mode: 'grow', cityId: 'martlock',
  }];
  const job = { id: 'c1', recipeId: 'T6_POTION_HEAL', mode: 'fixed', perCycle: 100 };
  const P = {
    T6_FOXGLOVE: 260, T6_FARM_FOXGLOVE_SEED: 2200, T6_ALCOHOL: 449,
    T5_EGG: 320, T6_POTION_HEAL: 2400,
  };
  const run = (plan, craftCity) => simulateCycle(plan, data, {
    priceOf: (id) => P[id] ?? 0,
    settings: { ...ctx().settings, craftCity, watered: false, cycleDays: 14, farmDays: 14 },
  }).profit;

  const loose = { plots, crafts: [job] };
  const pinned = { plots, crafts: [{ ...job, cityId: 'brecilien' }] };

  // Left alone, the setting decides - Brecilien specialises in potions and
  // the island gives no bonus at all, so they cannot come out the same.
  assert.notEqual(Math.round(run(loose, 'brecilien')), Math.round(run(loose, 'island')));
  assert.ok(run(loose, 'brecilien') > run(loose, 'island'));

  // Pinned, the job ignores the setting entirely. That is the behaviour the
  // job editor relies on, and the reason the solver must not stamp it.
  assert.equal(Math.round(run(pinned, 'brecilien')), Math.round(run(pinned, 'island')));
});

/* ------------------------------------------------------------- mounts -- */

test('a grown horse can be saddled, and the horse never comes back', () => {
  // items.xml <mount> T5_MOUNT_HORSE: 1x T5_FARM_HORSE_GROWN maxreturnamount="0"
  // + 20x T5_LEATHER, craftingfocus 1876, silver 0, no craftingcategory.
  const horse = recipeOf('T5_MOUNT_HORSE');
  assert.ok(horse, 'the saddler recipe exists');
  assert.equal(horse.group, 'mount');
  assert.equal(horse.category, 'mount');
  assert.equal(horse.focus, 1876);
  assert.deepEqual(horse.inputs, [
    { id: 'T5_FARM_HORSE_GROWN', count: 1, noReturn: true },
    { id: 'T5_LEATHER', count: 20 },
  ]);
  assert.deepEqual(recipeOf('T8_MOUNT_OX').inputs, [
    { id: 'T8_FARM_OX_GROWN', count: 1, noReturn: true },
    { id: 'T8_PLANKS', count: 30 },
  ]);
  // Only what a farmer can make: no skins, upgrades, battle or faction mounts.
  const mounts = gear.filter((r) => r.group === 'mount');
  assert.equal(mounts.length, 27);
  assert.ok(mounts.every((r) => r.inputs.some((i) => i.id.includes('_FARM_'))));
  assert.ok(mounts.every((r) => !r.inputs.some((i) => i.id.includes('TOKEN'))));
  // The drake is the one mount pinned at plain quality.
  assert.equal(recipeOf('T8_MOUNT_DRAKE_FIRE').maxQuality, 1);
  assert.equal(horse.maxQuality, undefined);
});

test('no city specialises in saddlery, so a mount pays the flat base everywhere', () => {
  const s = ctx().settings;
  for (const c of s.cities) {
    if (c.id === 'island') continue;
    const b = bestCityFor('mount', s);
    assert.equal(b.craftSpecialties?.mount, undefined);
  }
  const run = craftPnL('T5_MOUNT_HORSE', {
    ...ctx({ cityId: 'lymhurst' }),
    priceOf: (id) => ({ T5_FARM_HORSE_GROWN: 60000, T5_LEATHER: 1200, T5_MOUNT_HORSE: 120000 })[id] ?? 0,
    qty: 10,
  });
  assert.equal(Math.round(run.steps[0].batch.rrr * 1000) / 10, 43.5, '18 base + 59 focus');
  // The horse is charged in full: ten crafts, ten horses, none returned.
  const horses = run.buys.find((b) => b.id === 'T5_FARM_HORSE_GROWN');
  assert.equal(horses.qty, 10);
  assert.equal(horses.net, 10);
  const leather = run.buys.find((b) => b.id === 'T5_LEATHER');
  assert.ok(leather.net < 200, 'while the leather comes back at the rate');
  assert.equal(Math.round(run.profit), Math.round(run.revenue - run.buyCost - run.fees));
});

/* =============================================== refining, in full ==== */

test('a refined item carries the enchant level the game puts on it', () => {
  // The enchant sits on the item element itself, not in an <enchantments>
  // block, so reading only the block filed all five grades as "plain" and
  // left the .1 and .2 slices of the Craft tab permanently empty.
  assert.equal(recipeOf('T5_PLANKS').enchant, 0);
  assert.equal(recipeOf('T5_PLANKS_LEVEL1').enchant, 1);
  assert.equal(recipeOf('T5_PLANKS_LEVEL4').enchant, 4);
  assert.deepEqual(recipeOf('T5_PLANKS_LEVEL1').inputs, [
    { id: 'T5_WOOD_LEVEL1', count: 3 },
    { id: 'T4_PLANKS_LEVEL1', count: 1 },
  ]);
  // Every enchanted grade of every family, and none missing.
  const graded = gear.filter((r) => r.refine && r.enchant);
  assert.equal(graded.length, 80, '4 families x T4-T8 x .1-.4');
});

test('the refining ladder is the same shape in every family', () => {
  // Raw count is a function of tier and never of enchant, and the lower
  // tier's refined output is always exactly one.
  const RAW_BY_TIER = { 2: 1, 3: 2, 4: 2, 5: 3, 6: 4, 7: 5, 8: 5 };
  const REFINED = { wood: 'PLANKS', ore: 'METALBAR', fiber: 'CLOTH', hide: 'LEATHER' };
  for (const [family, word] of Object.entries(REFINED)) {
    for (let tier = 2; tier <= 8; tier++) {
      const r = recipeOf(`T${tier}_${word}`);
      assert.ok(r, `T${tier}_${word} exists`);
      assert.equal(r.category, family);
      assert.equal(r.refine, true);
      const raw = r.inputs.find((i) => !i.id.includes(word));
      assert.equal(raw.count, RAW_BY_TIER[tier], `T${tier} ${family} raw count`);
      if (tier > 2) {
        const lower = r.inputs.find((i) => i.id.includes(word));
        assert.equal(lower.count, 1, `T${tier} ${family} takes one of the tier below`);
      }
    }
  }
});

test('enchanted rock pays in extra blocks, because enchanted blocks do not exist', () => {
  // There is no T5_STONEBLOCK_LEVEL1 item anywhere in the game. Enchanted
  // rock instead buys 2, 4 or 8 plain blocks for the same focus, and those
  // rows share an output, so they carry an id of their own.
  assert.equal(recipeOf('T5_STONEBLOCK_LEVEL1'), null);
  const one = recipeOf('T5_STONEBLOCK#1');
  const three = recipeOf('T5_STONEBLOCK#3');
  assert.equal(one.out, 'T5_STONEBLOCK');
  assert.equal(one.amount, 2);
  assert.equal(three.amount, 8);
  assert.equal(one.focus, recipeOf('T5_STONEBLOCK').focus, 'same focus as plain');
  assert.ok(one.inputs.some((i) => i.id === 'T5_ROCK_LEVEL1'));
  assert.ok(three.inputs.some((i) => i.id === 'T5_ROCK_LEVEL3'));
  // And the enchanted rock is a known item now, which it was not before.
  assert.equal(raw.items.T5_ROCK_LEVEL1.name, 'Uncommon Granite');
  // Five tiers times three enchant levels, in rock and nowhere else.
  const variants = gear.filter((r) => r.out);
  assert.equal(variants.length, 15);
  assert.ok(variants.every((r) => r.category === 'rock'));
});

test('a variant is priced and mastered by what it makes, not by its id', () => {
  const run = craftPnL('T5_STONEBLOCK#1', {
    ...ctx({ cityId: 'bridgewatch' }),
    qty: 8,
    priceOf: (id) => ({ T5_ROCK_LEVEL1: 900, T4_STONEBLOCK: 300, T5_STONEBLOCK: 700 })[id] ?? 0,
  });
  // Nothing is "missing": the output has a price under its real name.
  assert.deepEqual(run.missing, []);
  assert.ok(run.revenue > 0, 'it sells as T5_STONEBLOCK');
  // Two blocks a craft, so eight of them is four crafts.
  assert.equal(run.crafts, 4);
});

test('the market groups every refined material together', () => {
  // Planks and leather used to come out "material" because a tool recipe
  // listed them before the refining recipe did.
  for (const id of ['T3_PLANKS', 'T5_PLANKS', 'T5_CLOTH', 'T5_LEATHER',
    'T5_METALBAR', 'T5_STONEBLOCK', 'T8_LEATHER']) {
    assert.equal(raw.items[id].cat, 'refined', id);
  }
  assert.equal(raw.items.T5_WOOD.cat, 'material');
});

/* ------------------------------------------------ where you refine --- */

test('a refining bench reads the refining bonus, which is not the crafting one', () => {
  const s = ctx().settings;
  const city = (id) => s.cities.find((c) => c.id === id);
  // Royal cities give the same either way, so nothing moves there.
  for (const id of ['thetford', 'lymhurst', 'bridgewatch', 'martlock',
    'fortsterling', 'caerleon', 'brecilien']) {
    assert.equal(city(id).craftBase, 18);
    assert.equal(city(id).refineBase, 18, id);
  }
  // The three Rests do not: 18 to a crafter, 15 to a refiner.
  for (const id of ['arthurs', 'merlyns', 'morganas']) {
    assert.equal(city(id).craftBase, 18);
    assert.equal(city(id).refineBase, 15, id);
  }
  assert.equal(city('island').refineBase, 0, 'no bonus at home, either way');

  assert.equal(cityBonus(city('arthurs'), 'wood', s, { refine: true }).base, 15);
  assert.equal(cityBonus(city('arthurs'), 'wood', s).base, 18);
  // The specialty table is shared, and it is +40 for a resource family.
  assert.equal(cityBonus(city('fortsterling'), 'wood', s, { refine: true }).total, 58);
  assert.equal(cityBonus(city('martlock'), 'wood', s, { refine: true }).total, 18);
});

test('the return rate a refiner actually gets, city by city', () => {
  const s = { ...ctx().settings, useFocus: true };
  const at = (id) => {
    const city = s.cities.find((c) => c.id === id);
    const b = cityBonus(city, 'wood', s, { refine: true });
    return Math.round(returnRate(b.total + s.focusCraftBonus) * 10000) / 100;
  };
  assert.equal(at('fortsterling'), 53.92, '18 + 40 + 59');
  assert.equal(at('martlock'), 43.5, '18 + 59');
  assert.equal(at('arthurs'), 42.53, '15 + 59');
  assert.equal(at('island'), 37.11, '0 + 59');
});

test('a stack of planks costs what the game charges for it', () => {
  // The regression guard for the whole refining half: 999 crafts, the focus
  // ladder, and a shopping list net of the return rate.
  const run = craftPnL('T5_PLANKS', {
    ...ctx({ cityId: 'fortsterling' }),
    qty: 999,
    priceOf: (id) => ({ T5_WOOD: 260, T4_PLANKS: 700, T5_PLANKS: 1100 })[id] ?? 0,
  });
  assert.equal(run.crafts, 999);
  assert.equal(Math.round(run.focus), 93906, '94 focus a craft at zero mastery');
  const wood = run.buys.find((b) => b.id === 'T5_WOOD');
  const lower = run.buys.find((b) => b.id === 'T4_PLANKS');
  assert.equal(Math.round(wood.net * 10) / 10, 1381.1, '2997 less 53.92% back');
  assert.equal(Math.round(lower.net * 10) / 10, 460.4);
});
