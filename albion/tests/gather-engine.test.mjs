// The gathering engine: turning a kit and a target into swings, minutes and
// resources. The data it reads is locked down in gather.test.mjs; this is
// about the arithmetic on top of it.

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  gatherRate, gatherRun, gatherSpeed, gatherYield, rawIdOf, rawId,
  refinedOf, enchantUp, tierUp, measuredPerHour,
} from '../js/gather.js';
import { craftPnL } from '../js/calc.js';
import { resourceExits } from '../js/exits.js';

const data = JSON.parse(
  readFileSync(new URL('../data/gamedata.json', import.meta.url), 'utf8'));
const equip = JSON.parse(
  readFileSync(new URL('../data/equipment.json', import.meta.url), 'utf8'));

const all = new Map([...data.recipes, ...equip.recipes.map((r) => ({
  enchant: 0, amount: 1, silver: 0, refine: false, ...r,
}))].map((r) => [r.id, r]));
const recipeOf = (id) => all.get(id) || null;

/** A kit, with nothing switched on unless the test asks for it. */
const kit = (over = {}) => ({
  ...data.constants,
  cities: data.cities,
  gathering: data.gathering,
  focusNodes: data.focusNodes,
  nodeLevels: {}, spec: {}, stationFee: {},
  premium: false, useFocus: true,
  ...over,
  gather: { toolTier: 5, ...(over.gather || {}) },
});

const MIN = (seconds) => Math.round(seconds / 60 * 10) / 10;

/* --------------------------------------------------------------- ids -- */

test('a resource id says its family, tier and grade', () => {
  assert.deepEqual(rawIdOf('T5_WOOD'), { family: 'WOOD', tier: 5, enchant: 0 });
  assert.deepEqual(rawIdOf('T8_HIDE_LEVEL3'), { family: 'HIDE', tier: 8, enchant: 3 });
  assert.equal(rawIdOf('T5_PLANKS'), null);
  assert.equal(rawIdOf('T4_MAIN_SWORD'), null);
  assert.equal(rawId('WOOD', 5, 0), 'T5_WOOD');
  assert.equal(rawId('WOOD', 5, 2), 'T5_WOOD_LEVEL2');
});

/* -------------------------------------------------------- the swing -- */

test('the tool, and only the tool, decides how long a swing takes', () => {
  const at = (toolTier) => gatherRate('WOOD', 5, 0, kit({ gather: { toolTier } }));
  assert.equal(at(5).secondsPerSwing, 6, 'a matching tool is the plain number');
  assert.equal(at(6).secondsPerSwing, 6 * 0.7);
  assert.equal(at(7).secondsPerSwing, 3);
  assert.equal(at(8).secondsPerSwing, 6 * 0.35);
  assert.equal(at(4).secondsPerSwing, 9, 'one tier down is half again as long');
  assert.equal(at(3).impossible, true, 'two down and the game refuses');
  assert.equal(at(3).needTool, 4);
});

test('999 T5 logs, swing time only, by axe', () => {
  // The floor the game files give exactly. Travel, respawn and competition
  // are on top of this and are not in any dump.
  const floor = (toolTier) => MIN(
    gatherRun('T5_WOOD', { qty: 999, settings: kit({ gather: { toolTier } }) }).swingSeconds);
  assert.equal(floor(4), 149.9);
  assert.equal(floor(5), 99.9);
  assert.equal(floor(6), 69.9);
  assert.equal(floor(7), 50);
  assert.equal(floor(8), 35);
});

/* -------------------------------------------------------- the yield -- */

test('every bonus adds into one number, and each one is tier-gated', () => {
  const full = kit({
    premium: true,
    gather: {
      toolTier: 8, toolAvalon: true,
      gear: { head: 8, armor: 8, shoes: 8 },
      food: 'T7_MEAL_PIE', foodEnchant: 3,
      specLevels: { GATHER_WOOD_T5: 100 },
    },
  });
  const y = gatherYield('WOOD', 5, 0, full);
  assert.equal(round(y.gear), 0.7, 'a full T8 set');
  assert.equal(round(y.tool), 0.2, 'the Avalonian axe at its own tier');
  assert.equal(round(y.food), 0.225, 'a pristine pork pie');
  assert.equal(round(y.spec), 0.5, 'the board at 100');
  assert.equal(round(y.premium), 0.5);
  assert.equal(round(y.multiplier), 3.125, '1 + 2.125, added');
  // And the other reading of premium, which the game does not settle.
  const mult = gatherYield('WOOD', 5, 0, kit({
    premium: true,
    gather: { ...full.gather, premiumMode: 'multiply' },
  }));
  assert.equal(round(mult.multiplier), 3.9375, '(1 + 1.625) x 1.5');
  assert.ok(y.assumed.some((a) => a.includes('does not publish')));
});

test('a T5 set is worth nothing on a T6 node', () => {
  const five = { toolTier: 8, gear: { head: 5, armor: 5, shoes: 5 } };
  assert.equal(round(gatherYield('WOOD', 5, 0, kit({ gather: five })).gear), 0.2);
  assert.equal(gatherYield('WOOD', 6, 0, kit({ gather: five })).gear, 0);
  // A T8 set covers everything below it.
  const eight = { toolTier: 8, gear: { head: 8, armor: 8, shoes: 8 } };
  assert.equal(round(gatherYield('WOOD', 6, 0, kit({ gather: eight })).gear), 0.7);
});

test('a plain tool gives no yield, however good it is', () => {
  const plain = kit({ gather: { toolTier: 8, toolAvalon: false } });
  assert.equal(gatherYield('WOOD', 5, 0, plain).tool, 0);
  const avalon = kit({ gather: { toolTier: 8, toolAvalon: true } });
  assert.equal(round(gatherYield('WOOD', 5, 0, avalon).tool), 0.2);
});

test('the set takes five minutes to reach the number on its tooltip', () => {
  const at = (wornSeconds) => round(gatherYield('WOOD', 5, 0, kit({
    gather: { toolTier: 5, gear: { head: 5, armor: 5, shoes: 5 }, wornSeconds },
  })).gear);
  assert.equal(at(0), 0, 'nothing at all on the first swing');
  assert.equal(at(150), 0.1, 'half the stacks after two and a half minutes');
  assert.equal(at(300), 0.2, 'full at five');
  assert.equal(at(3000), 0.2, 'and no further');
  // Left unsaid, a run is long enough that the cap is the right answer.
  assert.equal(round(gatherYield('WOOD', 5, 0, kit({
    gather: { toolTier: 5, gear: { head: 5, armor: 5, shoes: 5 } },
  })).gear), 0.2);
});

test('the pie and the board reach an enchanted node; the gear may not', () => {
  const both = {
    toolTier: 8, toolAvalon: true, gear: { head: 8, armor: 8, shoes: 8 },
    food: 'T7_MEAL_PIE', specLevels: { GATHER_WOOD_T5: 100 },
  };
  const on = gatherYield('WOOD', 5, 1, kit({ gather: { ...both, gearCoversEnchanted: true } }));
  const off = gatherYield('WOOD', 5, 1, kit({ gather: { ...both, gearCoversEnchanted: false } }));
  assert.equal(round(on.gear), 0.7);
  assert.equal(off.gear, 0, 'the gear names the plain resource type exactly');
  assert.equal(off.tool, 0);
  // The pie has no resource filter at all and the board matches by glob.
  assert.equal(round(off.food), 0.15);
  assert.equal(round(off.spec), 0.5);
  assert.ok(on.assumed.some((a) => a.includes('enchanted')));
});

/* -------------------------------------------------------- the speed -- */

test('speed has two sources and a hard cap', () => {
  const bare = gatherSpeed('WOOD', 5, kit({}));
  assert.equal(bare.total, 0, 'gear, tools, pies and premium have no speed at all');
  const specced = gatherSpeed('WOOD', 5, kit({
    gather: { specLevels: { GATHER_WOOD_T5: 100 } },
  }));
  assert.equal(specced.raw, 0.5);
  assert.equal(specced.total, 0.4, 'capped');
  assert.equal(specced.capped, true);
  // So a potion on top of a specced gatherer buys no more speed at all.
  const both = gatherSpeed('WOOD', 5, kit({
    gather: { specLevels: { GATHER_WOOD_T5: 100 }, potion: 'T8_POTION_GATHER' },
  }));
  assert.equal(both.total, 0.4);
});

/* ---------------------------------------------------------- the run -- */

test('a full kit turns a two-hour stack into a quarter of an hour of swinging', () => {
  const run = gatherRun('T5_WOOD', {
    qty: 999,
    settings: kit({
      premium: true,
      gather: {
        toolTier: 8, toolAvalon: true,
        gear: { head: 8, armor: 8, shoes: 8 },
        food: 'T7_MEAL_PIE', foodEnchant: 3,
        specLevels: { GATHER_WOOD_T5: 100 },
      },
    }),
  });
  assert.equal(round(run.rate.yield.multiplier), 3.125);
  assert.equal(Math.round(run.swings), 320, '999 at 3.125 a swing');
  // The board pays in speed as well as yield, and at 100 its half a second
  // is clipped to the cap - so the swing itself is 6 x 0.35 / 1.4 = 1.5s.
  assert.equal(run.rate.speed.total, 0.4);
  assert.equal(round(run.rate.secondsPerSwing), 1.5);
  assert.equal(MIN(run.swingSeconds), 8);
  // Against 99.9 minutes with a matching axe and nothing else on.
  const bare = gatherRun('T5_WOOD', { qty: 999, settings: kit({}) });
  assert.equal(MIN(bare.swingSeconds), 99.9);
});

test('the run refuses to quote hours it cannot know', () => {
  const bare = gatherRun('T5_WOOD', { qty: 999, settings: kit({}) });
  assert.equal(bare.hours, null);
  assert.ok(bare.swingSeconds > 0, 'but the swing floor is exact');
  assert.ok(bare.assumed.some((a) => a.includes('ten-minute run')));

  // Once you have timed one, it says so and stops guessing.
  const timed = kit({
    gather: { toolTier: 5, measured: { 'WOOD:5:static:royal': { per10min: 90, on: '2026-09-24' } } },
  });
  assert.equal(measuredPerHour('WOOD', 5, timed), 540);
  const run = gatherRun('T5_WOOD', { qty: 999, settings: timed });
  assert.equal(round(run.hours, 3), 1.85);
  assert.ok(run.uptime > 0 && run.uptime < 1, 'and what share of it is swinging');
  assert.ok(!run.assumed.some((a) => a.includes('ten-minute run')));
});

test('a node only holds so many charges, and the grades it rolls are the game\'s', () => {
  const run = gatherRun('T5_WOOD', { qty: 999, settings: kit({}) });
  assert.equal(run.rate.unitsPerNode, 5, 'five charges, one log each');
  assert.equal(Math.ceil(run.nodes), 200, 'so a stack is two hundred trees');
  // Royal odds: one node in twenty is uncommon, one in two hundred rare.
  const shares = Object.fromEntries(run.mix.map((m) => [m.grade, round(m.share, 4)]));
  assert.deepEqual(shares, { 0: 0.9445, 1: 0.05, 2: 0.005, 3: 0.0005 });
  assert.equal(round(run.mix.reduce((t, m) => t + m.share, 0)), 1);
  assert.equal(run.mix.find((m) => m.grade === 1).id, 'T5_WOOD_LEVEL1');
  // Four times as many uncommon nodes in a good Outlands zone.
  const out = gatherRun('T5_WOOD', { qty: 999, settings: kit({ gather: { zone: 'outlandsHigh' } }) });
  assert.equal(round(out.mix.find((m) => m.grade === 1).share), 0.2);
});

test('fame follows the zone and premium, and weight follows the stack', () => {
  const run = gatherRun('T5_WOOD', {
    qty: 999, settings: kit({ premium: true, gather: { danger: 'black6' } }),
  });
  // 22.5 fame a log, half again for the deepest black, half again for premium.
  assert.equal(Math.round(run.fame), Math.round(999 * 22.5 * 1.5 * 1.5));
  assert.equal(round(run.weight, 1), round(999 * 0.76, 1));
  const safe = gatherRun('T5_WOOD', { qty: 999, settings: kit({ gather: { danger: 'yellow' } }) });
  assert.equal(Math.round(safe.fame), Math.round(999 * 22.5));
});

/* --------------------------------------------------------- the exits -- */

test('what a raw can become', () => {
  assert.equal(refinedOf('T5_WOOD'), 'T5_PLANKS');
  assert.equal(refinedOf('T5_WOOD_LEVEL2'), 'T5_PLANKS_LEVEL2');
  assert.equal(refinedOf('T5_ORE'), 'T5_METALBAR');
  // Enchanted rock has no enchanted block, so it buys extra plain ones.
  assert.equal(refinedOf('T5_ROCK_LEVEL1'), 'T5_STONEBLOCK#1');
  assert.ok(recipeOf(refinedOf('T5_ROCK_LEVEL1')), 'and that row exists');
  assert.equal(enchantUp('T5_WOOD'), 'T5_WOOD_LEVEL1');
  assert.equal(enchantUp('T5_WOOD_LEVEL4'), null);
  assert.equal(enchantUp('T5_ROCK_LEVEL3'), null, 'rock stops at exceptional');
  assert.equal(tierUp('T5_WOOD'), 'T6_WOOD');
  assert.equal(tierUp('T8_WOOD'), null);
});

/* ----------------------------------------------- gather it or buy it -- */

test('gathering a material costs no silver and does cost time', () => {
  const prices = { T5_WOOD: 260, T4_PLANKS: 700, T5_PLANKS: 1100 };
  const base = {
    recipeOf, qty: 999, priceOf: (id) => prices[id] ?? 0,
    settings: kit({ premium: true, gather: { toolTier: 8 } }),
    cityId: 'fortsterling',
  };
  const bought = craftPnL('T5_PLANKS', base);
  const gathered = craftPnL('T5_PLANKS', { ...base, gather: new Set(['T5_WOOD']) });

  // Same plan, same focus, same planks bought. Only the logs change hands.
  assert.equal(gathered.focus, bought.focus);
  assert.equal(gathered.buys.find((b) => b.id === 'T4_PLANKS').cost,
    bought.buys.find((b) => b.id === 'T4_PLANKS').cost);
  assert.equal(gathered.buys.find((b) => b.id === 'T5_WOOD').cost, 0);
  assert.equal(Math.round(gathered.buyCost),
    Math.round(bought.buyCost - bought.buys.find((b) => b.id === 'T5_WOOD').cost));
  assert.ok(gathered.profit > bought.profit);

  // And the time shows up where silver used to be.
  assert.equal(bought.gatherSwingSeconds, 0);
  assert.ok(gathered.gatherSwingSeconds > 0);
  assert.equal(gathered.gatherHours, null, 'nothing measured, so nothing quoted');
  assert.ok(gathered.gatherFame > 0);
  assert.ok(gathered.gathered.T5_WOOD.qty > 1381, 'the logs the run really needs');
  assert.ok(gathered.assumed.length > 0);
});

test('a run with nothing gathered is byte for byte what it always was', () => {
  const prices = { T5_WOOD: 260, T4_PLANKS: 700, T5_PLANKS: 1100 };
  const run = craftPnL('T5_PLANKS', {
    recipeOf, qty: 999, priceOf: (id) => prices[id] ?? 0,
    settings: kit({ premium: true }), cityId: 'fortsterling',
  });
  assert.equal(run.gatherSwingSeconds, 0);
  assert.equal(run.gatherHours, 0);
  assert.deepEqual(run.gathered, {});
  assert.deepEqual(run.assumed, []);
  assert.equal(Math.round(run.focus), 93906);
});

function round(n, places = 4) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/* ---------------------------------------------- what to do with it --- */

test('every way out of a pile of logs, costed the same way', () => {
  const prices = {
    T5_WOOD: 260, T5_WOOD_LEVEL1: 1900, T6_WOOD: 700,
    T4_PLANKS: 700, T5_PLANKS: 1100, T4_PLANKS_LEVEL1: 2400, T5_PLANKS_LEVEL1: 6200,
  };
  const ctx = {
    recipeOf, priceOf: (id) => prices[id] ?? 0,
    settings: kit({ premium: true, gather: { toolTier: 8 } }),
    cityId: 'fortsterling',
  };
  const rows = resourceExits('T5_WOOD', ctx, { qty: 999 });
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));

  // All five routes are on the table, and each one really is a route.
  assert.deepEqual(rows.map((r) => r.key).sort(),
    ['enchant', 'enchantRefine', 'raw', 'refine', 'tier']);
  assert.equal(by.raw.made, 999);
  assert.equal(by.refine.id, 'T5_PLANKS');
  assert.equal(by.enchant.id, 'T5_WOOD_LEVEL1');
  assert.equal(by.tier.id, 'T6_WOOD');
  assert.equal(by.enchantRefine.id, 'T5_PLANKS_LEVEL1');

  // Every row started from about the same pile of logs, which is the whole
  // point of the comparison.
  for (const row of rows) {
    assert.ok(Math.abs(row.rawsUsed - 999) / 999 < 0.02, `${row.key} used ${row.rawsUsed}`);
  }
  // Refining eats focus; transmuting does not; selling raw does neither.
  assert.ok(by.refine.focus > 0);
  assert.equal(by.enchant.focus, 0);
  assert.equal(by.raw.focus, 0);
  assert.equal(by.raw.silverPerFocus, null);
  // Sorted best first, on a figure that exists without a measured rate.
  assert.ok(rows[0].silverPerSwingSecond >= rows[rows.length - 1].silverPerSwingSecond);
  for (const row of rows) {
    assert.ok(row.swingSeconds > 0, `${row.key} costs swinging`);
    assert.equal(row.silverPerHour, null, 'until a run has been timed');
  }
});

test('once a run is timed, the exits are worth silver an hour', () => {
  const prices = { T5_WOOD: 260, T4_PLANKS: 700, T5_PLANKS: 1100 };
  const rows = resourceExits('T5_WOOD', {
    recipeOf, priceOf: (id) => prices[id] ?? 0,
    settings: kit({
      premium: true,
      gather: {
        toolTier: 8,
        measured: { 'WOOD:5:static:royal': { per10min: 90, on: '2026-09-24' } },
      },
    }),
    cityId: 'fortsterling',
  }, { qty: 999 });
  for (const row of rows) {
    assert.ok(row.hours > 0, `${row.key} takes hours`);
    assert.ok(Number.isFinite(row.silverPerHour), row.key);
  }
});
