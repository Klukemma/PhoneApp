// The craft-to-order engine: weapons, armour, refining and the Black Market.
//
// These read the real dumps, so a number here is either the game's or a bug.

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { craftPnL, returnRate, taxRate } from '../js/calc.js';

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
