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
  /* The floor the game files give exactly. Travel, respawn and competition
   * are on top of this and are not in any dump.
   *
   * It is 1058 harvests rather than 999 because a twentieth of them come up
   * enchanted, and an enchanted log is not a plain one. */
  const floor = (toolTier) => MIN(
    gatherRun('T5_WOOD', { qty: 999, settings: kit({ gather: { toolTier } }) }).swingSeconds);
  assert.equal(floor(4), 158.7);
  assert.equal(floor(5), 105.8);
  assert.equal(floor(6), 74);
  assert.equal(floor(7), 52.9);
  assert.equal(floor(8), 37);
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
  assert.equal(Math.round(run.harvests), 1058, '999 plain means 1058 harvests');
  assert.equal(Math.round(run.swings), 338, '1058 at 3.125 a swing');
  // The board pays in speed as well as yield, and at 100 its half a second
  // is clipped to the cap - so the swing itself is 6 x 0.35 / 1.4 = 1.5s.
  assert.equal(run.rate.speed.total, 0.4);
  assert.equal(round(run.rate.secondsPerSwing), 1.5);
  assert.equal(MIN(run.swingSeconds), 8.5);
  // Against 105.8 minutes with a matching axe and nothing else on.
  const bare = gatherRun('T5_WOOD', { qty: 999, settings: kit({}) });
  assert.equal(MIN(bare.swingSeconds), 105.8);
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
  assert.equal(round(run.hours, 3), 1.959);
  assert.ok(run.uptime > 0 && run.uptime < 1, 'and what share of it is swinging');
  assert.ok(!run.assumed.some((a) => a.includes('ten-minute run')));
});

test('a node only holds so many charges, and the grades it rolls are the game\'s', () => {
  const run = gatherRun('T5_WOOD', { qty: 999, settings: kit({}) });
  assert.equal(run.rate.unitsPerNode, 5, 'five charges, one log each');
  assert.equal(Math.ceil(run.nodes), 212, 'so a stack is 212 trees');
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
  /* 22.5 fame a log, half again for the deepest black, half again for premium
   * - over everything the run picks up, not only the plain logs. The 58
   * enchanted ones are worth double, quadruple and eight times as much each,
   * so they are 13% of the fame off 5.5% of the harvests. */
  const naive = 999 * 22.5 * 1.5 * 1.5;
  assert.equal(Math.round(run.fame), 57214);
  assert.ok(run.fame > naive * 1.12 && run.fame < naive * 1.14);
  assert.equal(round(run.weight, 1), round(1057.7 * 0.76, 1));
  const safe = gatherRun('T5_WOOD', { qty: 999, settings: kit({ gather: { danger: 'yellow' } }) });
  assert.equal(Math.round(safe.fame), 25428);
});

test('a stack of one grade takes the swings that grade really costs', () => {
  /* The thing every gathering calculator gets wrong. You cannot aim at an
   * enchanted node: it is a roll on an ordinary one. So a stack of T5.1 logs
   * is not a stack of logs with a different label on it, it is twenty stacks
   * of plain gathering with the plain ones kept aside. Thirty-three hours of
   * swinging against one and three quarters, off the same tree. */
  const plain = gatherRun('T5_WOOD', { qty: 999, settings: kit({}) });
  const up = gatherRun('T5_WOOD_LEVEL1', { qty: 999, settings: kit({}) });
  assert.equal(round(plain.share, 4), 0.9445);
  assert.equal(up.share, 0.05);
  assert.equal(Math.round(up.harvests), 19980);
  assert.equal(round(up.swingSeconds / plain.swingSeconds), round(0.9445 / 0.05));
  assert.ok(up.assumed.some((a) => a.includes('5.0% of harvests')));
  // And the plain run says what the extra 5.5% of harvests left you holding.
  assert.deepEqual(plain.byproducts.map((b) => b.id),
    ['T5_WOOD_LEVEL1', 'T5_WOOD_LEVEL2', 'T5_WOOD_LEVEL3']);
  assert.equal(Math.round(plain.byproducts[0].qty), 53);
  // A better zone is four times the enchanted, for the same swings.
  const rich = gatherRun('T5_WOOD_LEVEL1', {
    qty: 999, settings: kit({ gather: { zone: 'outlandsHigh' } }),
  });
  assert.equal(round(rich.swingSeconds / up.swingSeconds, 3), 0.25);
});

test('a grade a node never rolls is refused, not quoted', () => {
  // Pristine only exists on a resource treasure, and the published weights
  // give it zero even there, so there is no honest number to print.
  const run = gatherRun('T5_WOOD_LEVEL4', { qty: 10, settings: kit({}) });
  assert.equal(run.impossible, true);
  assert.equal(run.ungatherable, true);
  assert.equal(run.swingSeconds, 0);
  assert.match(run.why, /never rolls grade \.4/);
  // As is a node two tiers over your tool, which the game will not let you hit.
  const low = gatherRun('T5_WOOD', { qty: 10, settings: kit({ gather: { toolTier: 3 } }) });
  assert.equal(low.impossible, true);
  assert.equal(low.ungatherable, undefined);
  assert.match(low.why, /T3 tool is too small.*takes a T4/);
  // And having said nothing at all is a question, not a refusal to answer.
  const none = gatherRun('T5_WOOD', { qty: 10, settings: kit({ gather: { toolTier: 0 } }) });
  assert.equal(none.impossible, true);
  assert.equal(none.why, 'no tool set yet');
});

test('a node the game does not have at that tier is a reason, not a null', () => {
  /* There is no T2 living resource and no guardian outside T6, so a kit set to
   * one of those and pointed at the wrong tier used to hand every caller a
   * null - and the screen that ranked five ways out of a pile fell over on it
   * rather than saying there was no pile. */
  const critter2 = gatherRun('T2_WOOD', { qty: 10, settings: kit({ gather: { kind: 'critter' } }) });
  assert.equal(critter2.impossible, true);
  assert.equal(critter2.ungatherable, true);
  assert.match(critter2.why, /no T2 living resource/);
  assert.equal(critter2.swingSeconds, 0);
  assert.deepEqual(critter2.byproducts, []);
  // And nothing to rank, said by an empty list rather than by an exception.
  const rows = resourceExits('T2_WOOD', {
    recipeOf, priceOf: () => 100,
    settings: kit({ gather: { kind: 'critter' } }), cityId: 'fortsterling',
  }, { qty: 999 });
  assert.deepEqual(rows, []);
  // Something that is not a resource at all is still not this engine's business.
  assert.equal(gatherRun('T4_MAIN_SWORD', { qty: 10, settings: kit({}) }), null);
});

test('what the run picked up is never priced at the Black Market', () => {
  /* The Black Market buys equipment and nothing else - it makes no offer on a
   * log at any price. Pricing the byproducts at whatever the run itself sells
   * into meant a Black Market sale silently valued every enchanted log it dug
   * up at zero. */
  const market = (id) => ({
    T5_WOOD: 260, T5_WOOD_LEVEL1: 900, T5_WOOD_LEVEL2: 3000, T5_WOOD_LEVEL3: 9000,
    T4_PLANKS: 700, T5_PLANKS: 1100,
  }[id] ?? 0);
  const base = {
    recipeOf, qty: 500, priceOf: market, costOf: market,
    settings: kit({ gather: { toolTier: 8 } }), cityId: 'fortsterling',
    gather: new Set(['T5_WOOD']),
  };
  const onMarket = craftPnL('T5_PLANKS', base);
  // The Black Market quotes the planks and has never heard of a log.
  const onBlack = craftPnL('T5_PLANKS', {
    ...base, sellPriceOf: (id) => (id === 'T5_PLANKS' ? 1400 : 0), sellInstant: true,
  });
  assert.ok(onMarket.byproductValue > 0);
  assert.equal(round(onBlack.byproductValue), round(onMarket.byproductValue));
  assert.equal(onBlack.byproducts.length, 3);
});

test('what fell out of the gathering is counted, and counted separately', () => {
  const prices = {
    T5_WOOD: 260, T4_PLANKS: 700, T5_PLANKS: 1100,
    T5_WOOD_LEVEL1: 900, T5_WOOD_LEVEL2: 3000, T5_WOOD_LEVEL3: 9000,
  };
  const base = {
    recipeOf, qty: 999, priceOf: (id) => prices[id] ?? 0,
    settings: kit({ gather: { toolTier: 8 } }), cityId: 'fortsterling',
  };
  const run = craftPnL('T5_PLANKS', { ...base, gather: new Set(['T5_WOOD']) });
  const ids = run.byproducts.map((b) => b.id);
  assert.deepEqual(ids.sort(), ['T5_WOOD_LEVEL1', 'T5_WOOD_LEVEL2', 'T5_WOOD_LEVEL3']);
  assert.ok(run.byproductValue > 0);
  // In the revenue, and never in the recipe's own gross.
  assert.equal(round(run.revenue), round(run.gross * (1 - run.tax) + run.byproductRevenue));
  assert.ok(run.gross > 0 && run.byproductRevenue > 0);
  // Tax is paid on both sides of it.
  assert.ok(run.taxPaid > 0);
  assert.equal(round(run.taxPaid),
    round((run.gross + run.byproductValue) - run.revenue));
  // Nothing gathered, nothing on the side.
  const bought = craftPnL('T5_PLANKS', base);
  assert.deepEqual(bought.byproducts, []);
  assert.equal(bought.byproductValue, 0);
});

test('a gather the game would refuse is bought instead of being free', () => {
  const prices = { T5_WOOD: 260, T4_PLANKS: 700, T5_PLANKS: 1100 };
  const base = {
    recipeOf, qty: 100, priceOf: (id) => prices[id] ?? 0,
    settings: kit({ gather: { toolTier: 3 } }), cityId: 'fortsterling',
  };
  const run = craftPnL('T5_PLANKS', { ...base, gather: new Set(['T5_WOOD']) });
  const bought = craftPnL('T5_PLANKS', base);
  assert.equal(run.gathered.T5_WOOD.impossible, true, 'recorded, so the screen can say why');
  assert.equal(run.gatherSwingSeconds, 0);
  assert.equal(round(run.buyCost), round(bought.buyCost), 'and paid for at the market');
  assert.equal(round(run.profit), round(bought.profit));
});

test('a node is counted twice over: full, and as you find it', () => {
  /* A static tree sits at one charge of five and fills up over time, so the
   * same 1,058 harvests are 212 trees if every one is full and 1,058 if every
   * one is fresh. Quoting only the first number said a stack of logs was two
   * hundred trees when it can be a thousand. */
  const run = gatherRun('T5_WOOD', { qty: 999, settings: kit({}) });
  assert.equal(Math.ceil(run.nodes), 212);
  assert.equal(Math.ceil(run.nodeVisits), 1058);
  // A critter carries all its charges, so for it the two are the same number.
  const crit = gatherRun('T5_WOOD', { qty: 999, settings: kit({ gather: { kind: 'critter' } }) });
  assert.equal(Math.ceil(crit.nodes), Math.ceil(crit.nodeVisits));
});

test('a giant tree and a guardian are not ordinary nodes', () => {
  // Twelve logs over four swings, three at a time, twenty seconds a swing.
  const giant = gatherRun('T2_WOOD', { qty: 120, settings: kit({ gather: { kind: 'giant' } }) });
  assert.equal(giant.rate.unitsPerSwing, 3);
  assert.equal(giant.rate.unitsPerNode, 12);
  assert.equal(giant.rate.unitsPerFreshNode, 3, 'and it starts on one charge of ten');
  // A guardian is two and a half thousand resources standing in one place.
  const guard = gatherRun('T6_WOOD', {
    qty: 999, settings: kit({ gather: { toolTier: 8, kind: 'guardian' } }),
  });
  assert.equal(guard.rate.unitsPerSwing, 10);
  assert.equal(guard.rate.unitsPerNode, 2560);
  assert.ok(guard.nodes < 1, 'one of them is more than a stack');
});

test('the tiers the game lets you take bare-handed', () => {
  // T1 needs no tool; it is simply twice as slow without one.
  const bare = gatherRun('T1_WOOD', { qty: 100, settings: kit({ gather: { toolTier: 0 } }) });
  assert.equal(bare.impossible, undefined);
  assert.equal(bare.rate.bare, true);
  assert.equal(bare.rate.secondsPerSwing, 2, 'one second, doubled');
  assert.equal(bare.rate.unitsPerSwing, 2, 'and it hands over both charges at once');
  // T2 does need one, and says so rather than quoting a doubled time.
  assert.equal(gatherRun('T2_WOOD', { qty: 100, settings: kit({ gather: { toolTier: 0 } }) })
    .impossible, true);
  // With a tool in hand, T1 is the tool's time like anything else: four tiers
  // over the node is a quarter of the swing.
  assert.equal(gatherRun('T1_WOOD', { qty: 100, settings: kit({ gather: { toolTier: 5 } }) })
    .rate.secondsPerSwing, 0.25);
});

test('the Avalonian tool has a floor of its own', () => {
  // Its buff names every tier it pays on and T1 is not among them, however
  // good the tool is. The gear already had a minimum tier; this did not.
  const avalon = { toolTier: 8, toolAvalon: true };
  assert.equal(gatherYield('WOOD', 1, 0, kit({ gather: avalon })).tool, 0);
  assert.equal(round(gatherYield('WOOD', 2, 0, kit({ gather: avalon })).tool), 0.2);
  assert.equal(round(gatherYield('WOOD', 8, 0, kit({ gather: avalon })).tool), 0.2);
});

test('keeping the bonuses up costs consumables, once you have timed a run', () => {
  const on = {
    toolTier: 8, food: 'T7_MEAL_PIE', potion: 'T8_POTION_GATHER',
    measured: { 'WOOD:5:static:royal': { per10min: 90 } },
  };
  const run = gatherRun('T5_WOOD', { qty: 999, settings: kit({ gather: on }) });
  assert.equal(run.pies, 4, 'a pie lasts half an hour');
  /* And the answer nobody expects: a gathering potion lasts under a minute
   * and comes off cooldown exactly as it ends, so holding it for two hours is
   * a hundred and sixty of them. It is why a permanent speed buff is not a
   * thing anyone actually runs. */
  assert.equal(run.potions, 161);
  // And the run says out loud that it assumed the potion never lapsed.
  assert.ok(run.assumed.some((a) => a.includes('potion is up the whole run')));
  // Both are about wall-clock, so neither is quoted before a run is timed.
  const untimed = gatherRun('T5_WOOD', {
    qty: 999, settings: kit({ gather: { ...on, measured: {} } }),
  });
  assert.equal(untimed.pies, 0);
  assert.equal(untimed.potions, 0);
});

test('one trip for the lot, however many branches wanted it', () => {
  /* A log wanted by two branches of the same run is one trip, not two. It was
   * two, and the second overwrote the first - so the Gather section reported
   * whichever branch happened to be walked last and the totals beside it did
   * not match. The grade odds are per harvest, so this is arithmetic and not
   * only tidiness. */
  const prices = { T5_WOOD: 260, T4_PLANKS: 700, T5_PLANKS: 1100, T4_WOOD: 90 };
  const run = craftPnL('T5_PLANKS', {
    recipeOf, qty: 300, priceOf: (id) => prices[id] ?? 0,
    make: new Set(['T4_PLANKS']),
    gather: new Set(['T5_WOOD', 'T4_WOOD']),
    settings: kit({ gather: { toolTier: 8 } }), cityId: 'fortsterling',
  });
  // Both leaves gathered, each as one run, and the totals are their sum.
  assert.deepEqual(Object.keys(run.gathered).sort(), ['T4_WOOD', 'T5_WOOD']);
  assert.equal(round(run.gatherSwingSeconds),
    round(run.gathered.T4_WOOD.swingSeconds + run.gathered.T5_WOOD.swingSeconds));
  assert.equal(round(run.gatherFame),
    round(run.gathered.T4_WOOD.fame + run.gathered.T5_WOOD.fame));
  // And what the run says it needs is what it billed itself for.
  for (const id of ['T4_WOOD', 'T5_WOOD']) {
    assert.equal(round(run.gathered[id].qty),
      round(run.buys.find((b) => b.id === id).qty));
  }
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

test('a two-step route is sized from the same pile as a one-step one', () => {
  /* The bug this is here to keep out. Every row is sized by asking for one
   * unit and reading what it ate, and a station takes whole crafts at every
   * step - so on a two-step chain the rounding at the bottom is most of a
   * unit, and the row came out a third short. A comparison between routes
   * that started from different piles is not a comparison at all. */
  const prices = {
    T5_WOOD: 260, T5_WOOD_LEVEL1: 1900, T6_WOOD: 700,
    T4_PLANKS: 700, T5_PLANKS: 1100, T4_PLANKS_LEVEL1: 2400, T5_PLANKS_LEVEL1: 6200,
  };
  const ctx = {
    recipeOf, priceOf: (id) => prices[id] ?? 0,
    settings: kit({ premium: true, gather: { toolTier: 8 } }),
    cityId: 'fortsterling',
  };
  /* The floor is one whole craft: the station will not make three fifths of a
   * plank, so a route can only land on a multiple of what one craft eats. That
   * is 2% of a hundred-log pile and a fifth of a percent of a stack, and the
   * test says so rather than pretending the rounding is not there. */
  for (const [qty, tol] of [[100, 0.02], [999, 0.005], [5000, 0.005]]) {
    const rows = resourceExits('T5_WOOD', ctx, { qty });
    const two = rows.find((r) => r.key === 'enchantRefine');
    const one = rows.find((r) => r.key === 'refine');
    assert.ok(Math.abs(two.rawsUsed - qty) / qty < tol,
      `two-step at ${qty} used ${two.rawsUsed}`);
    assert.ok(Math.abs(one.rawsUsed - qty) / qty < tol,
      `one-step at ${qty} used ${one.rawsUsed}`);
    // And having started from the same pile, they cost the same swings.
    assert.ok(Math.abs(two.swingSeconds / one.swingSeconds - 1) < tol * 2);
  }
  /* Before the correction the two-step route was sized off a single-unit probe
   * and came back a third light, which made refining-after-transmuting look
   * worse than it is for a reason that had nothing to do with refining. */
  const stack = resourceExits('T5_WOOD', ctx, { qty: 999 });
  assert.ok(stack.find((r) => r.key === 'enchantRefine').rawsUsed > 900);
});

test('the gathering board is the destiny board, not a second list', () => {
  /* A gathering node is a board node like any other, so its levels live with
   * the rest of your board. Keeping them anywhere else would mean filling the
   * same number in twice and the two drifting apart. */
  const viaBoard = kit({ nodeLevels: { GATHER_WOOD_T5: 100 } });
  const viaKit = kit({ gather: { specLevels: { GATHER_WOOD_T5: 100 } } });
  assert.equal(round(gatherYield('WOOD', 5, 0, viaBoard).spec), 0.5);
  assert.equal(round(gatherYield('WOOD', 5, 0, viaKit).spec), 0.5);
  assert.equal(gatherSpeed('WOOD', 5, viaBoard).raw, 0.5);
  // A level on one family is no help on another, or at another tier.
  assert.equal(gatherYield('ORE', 5, 0, viaBoard).spec, 0);
  assert.equal(gatherYield('WOOD', 6, 0, viaBoard).spec, 0);
  // And over the node's own cap is still the cap.
  assert.equal(round(gatherYield('WOOD', 5, 0, kit({
    nodeLevels: { GATHER_WOOD_T5: 400 },
  })).spec), 0.5);
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
