// The craft-to-order engine: weapons, armour, refining and the Black Market.
//
// These read the real dumps, so a number here is either the game's or a bug.

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bestCityFor, craftPnL, haulOf, mixFor, qualityMix, qualityPoints, returnRate,
  taxRate,
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
