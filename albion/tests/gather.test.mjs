// Gathering: what a node gives, how long a swing takes, and every bonus
// that changes either.
//
// These read the real dumps, so a number here is either the game's or a bug.
// Where the game does not publish something - how many nodes a map holds,
// how premium's advertised 50% combines - the test says so rather than
// pinning an invention.

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const data = JSON.parse(
  readFileSync(new URL('../data/gamedata.json', import.meta.url), 'utf8'));
const G = data.gathering;

/* ------------------------------------------------------- the nodes --- */

test('a node gives what the game says it gives', () => {
  // The user's own question: T5 wood. Six seconds a swing, one log a swing,
  // five swings to empty a full tree, and twelve minutes for it to come back.
  assert.deepEqual(G.nodes.WOOD.static['5'], {
    seconds: 6, yield: 1, charges: 5, perNode: 5, perHarvest: 1,
    startCharges: 1, respawn: 720, rare: [1, 2, 3],
  });
  /* And the tree you actually walk up to holds one charge, not five: a static
   * node starts at one and charges up over time, slowly at the high tiers.
   * The difference is the whole gap between "212 trees" and "1,058 trees". */
  assert.equal(G.nodes.WOOD.static['5'].startCharges, 1);
  assert.equal(G.nodes.WOOD.critter['5'].startCharges, 5, 'a critter carries the lot');
  assert.equal(G.nodes.WOOD.treasure['5'].startCharges, 30);
  // Every family, every tier it exists at.
  for (const family of G.families) {
    for (let tier = 2; tier <= 8; tier++) {
      const n = G.nodes[family].static[String(tier)];
      assert.ok(n, `${family} T${tier}`);
      assert.ok(n.seconds > 0 && n.yield > 0 && n.charges > 0);
    }
  }
  // The low tiers hand over three at a time and the high ones one at a time,
  // which is why a T8 stack is so much slower than the seconds alone suggest.
  assert.equal(G.nodes.ORE.static['2'].yield, 3);
  assert.equal(G.nodes.ORE.static['4'].yield, 2);
  assert.equal(G.nodes.ORE.static['8'].yield, 1);
  assert.equal(G.nodes.ORE.static['8'].seconds, 15);
  // Hide is the one family with its own numbers, and only at the low tiers.
  assert.equal(G.nodes.HIDE.static['3'].seconds, 2.25);
  assert.equal(G.nodes.WOOD.static['3'].seconds, 3);
  assert.equal(G.nodes.HIDE.static['5'].seconds, G.nodes.WOOD.static['5'].seconds);
});

test('a giant tree is not one charge worth three', () => {
  /* The one node in the game with more than one yielding charge row: the
   * first gives three logs and the nine above it give one each. Reading only
   * the first row said "one charge, worth three", which was a twelve-log tree
   * described as a three-log one. The rows are summed now, and the simple
   * case - every other node in the game - comes out exactly as before. */
  const g2 = G.nodes.WOOD.giant['2'];
  assert.equal(g2.perNode, 12, 'three off the first charge and one off each of nine');
  assert.equal(g2.perHarvest, 3, 'and a swing takes three charges at once');
  assert.equal(g2.charges, 4, 'so four swings empty it');
  assert.equal(g2.yield, 3, 'twelve logs over four swings');
  // A guardian is the other extreme: ten a swing, two hundred and fifty six
  // swings, two and a half thousand resources standing in one place.
  const guard = G.nodes.WOOD.guardian['6'];
  assert.equal(guard.perNode, 2560);
  assert.equal(guard.perHarvest, 10);
  assert.equal(guard.yield, 10);
  // And the ordinary node is still a plain multiplication.
  for (const family of G.families) {
    for (const [tier, n] of Object.entries(G.nodes[family].static)) {
      assert.equal(n.perNode, n.yield * n.charges, `${family} T${tier}`);
    }
  }
});

test('the tiers you can take bare-handed say so, and say how much slower', () => {
  assert.equal(G.nodes.WOOD.static['1'].noTool, true);
  assert.equal(G.nodes.WOOD.static['1'].noToolFactor, 2);
  assert.equal(G.nodes.WOOD.static['2'].noTool, undefined, 'and T2 needs one');
  // The Avalonian tool has a floor of its own: it pays from T2 up and gives
  // nothing at all on a T1 node, whatever tool you are holding.
  assert.equal(G.toolYieldMinTier, 2);
});

test('the other kinds of node, and what is different about them', () => {
  assert.equal(G.kindLabels.static, 'Static node');
  // A living resource is half the swing of a static node and does not respawn.
  assert.equal(G.nodes.WOOD.critter['5'].seconds, 3);
  assert.equal(G.nodes.WOOD.critter['5'].respawn, undefined);
  // The Roads elite critters are the outlier the whole mode is built on.
  assert.equal(G.nodes.WOOD.roadsElite['5'].charges, 261);
  assert.equal(G.nodes.WOOD.static['5'].charges, 5);
  // A guardian hands over ten charges in one action.
  assert.equal(G.nodes.WOOD.guardian['6'].perHarvest, 10);
  // A giant tree is a minute a swing and only wood has them.
  assert.equal(G.nodes.WOOD.giant['5'].seconds, 60);
  assert.equal(G.nodes.ORE.giant, undefined);
  // Only a treasure node can roll a pristine resource - and not in rock,
  // because pristine rock does not exist.
  assert.deepEqual(G.nodes.WOOD.treasure['5'].rare, [1, 2, 3, 4]);
  assert.deepEqual(G.nodes.ROCK.treasure['5'].rare, [1, 2, 3]);
  assert.deepEqual(G.nodes.WOOD.static['5'].rare, [1, 2, 3]);
});

test('tool tier is the only thing in the game that changes gathering speed', () => {
  // A tool above the node cuts the swing hard; one below makes it half again
  // as long; two below and the game refuses to harvest at all.
  assert.deepEqual(G.toolTimeFactor, {
    '-1': 1.5, 0: 1, 1: 0.7, 2: 0.5, 3: 0.35, 4: 0.25, 5: 0.15, 6: 0.15, 7: 0.15,
  });
  assert.equal(G.toolTimeFactor['-2'], undefined);
  // And the speed attribute is capped, while yield has no cap row at all.
  assert.equal(G.speedCap, 0.4);
});

/* ------------------------------------------------------- the stack --- */

test('gatherer gear is a ramp, not a flat percentage', () => {
  // A little every 30 seconds, ten times, so the number on the tooltip only
  // exists after five minutes of wearing it.
  assert.equal(G.gearInterval, 30);
  assert.equal(G.gear.head['5'].maxCharges, 10);
  const at = (slot, tier) => G.gear[slot][String(tier)].perCharge * G.gear[slot][String(tier)].maxCharges;
  // The chest piece is worth double the head and the shoes.
  assert.equal(Math.round(at('head', 5) * 1000) / 1000, 0.05);
  assert.equal(Math.round(at('armor', 5) * 1000) / 1000, 0.1);
  assert.equal(Math.round(at('shoes', 5) * 1000) / 1000, 0.05);
  // A full set, tier by tier.
  const set = (tier) => Math.round((at('head', tier) + at('armor', tier) + at('shoes', tier)) * 1000) / 1000;
  assert.equal(set(4), 0.1);
  assert.equal(set(5), 0.2);
  assert.equal(set(6), 0.3);
  assert.equal(set(7), 0.5);
  assert.equal(set(8), 0.7);
  // And it is hard tier-gated: a T5 piece is worth nothing on a T6 node.
  assert.equal(G.gear.head['5'].maxTier, 5);
  assert.equal(G.gear.head['8'].maxTier, 8);
  assert.equal(G.gear.head['5'].minTier, 2);
});

test('a plain tool gives no yield, and an Avalonian one does', () => {
  // There is no plain-tool row at all, because the item has no passive slot.
  assert.equal(G.toolYield['5'], 0.125);
  assert.equal(G.toolYield['8'], 0.2);
  assert.equal(G.toolYield['4'], 0.1);
  assert.equal(Object.keys(G.toolYield).length, 5, 'T4 to T8, Avalonian only');
});

test('the pie, which is the one bonus with no resource filter on it', () => {
  const pie = G.food.T7_MEAL_PIE;
  assert.equal(pie.name, 'Pork Pie');
  assert.equal(pie.grades['0'].gatheringyield, 0.15);
  assert.equal(pie.grades['0'].maxloadbonus, 0.3);
  assert.equal(pie.grades['0'].seconds, 1800, 'half an hour');
  assert.equal(pie.grades['3'].gatheringyield, 0.225);
  // The ladder runs down the tiers too.
  assert.equal(G.food.T5_MEAL_PIE.grades['0'].gatheringyield, 0.1);
  // The omelette is a cast-speed food and must never appear here.
  assert.ok(!Object.keys(G.food).some((id) => id.includes('OMELETTE')));
});

test('the gathering potion is mostly speed, and it is brief', () => {
  const p = G.potions.T8_POTION_GATHER.grades['0'];
  assert.ok(p.gatheringspeed > p.gatheringyield, 'speed is the point of it');
  assert.ok(p.seconds <= 60, 'a minute at most, against a 30-minute pie');
});

test('the destiny board is the biggest single lever, and it is per family', () => {
  assert.equal(G.board.length, 25, 'five families, T4 to T8');
  const wood5 = G.board.find((n) => n.id === 'GATHER_WOOD_T5');
  assert.equal(wood5.name, 'Expert Lumberjack');
  assert.equal(wood5.family, 'WOOD');
  assert.equal(wood5.tier, 5);
  assert.equal(wood5.yieldPerLevel, 0.005);
  assert.equal(wood5.maxLevel, 100);
  // Half again on yield at 100, which beats every other single source.
  assert.equal(wood5.yieldPerLevel * wood5.maxLevel, 0.5);
});

/* ------------------------------------------------- enchanted nodes --- */

test('how often a node is enchanted, by cluster quality and not by colour', () => {
  for (const [where, odds] of Object.entries(G.rareOdds)) {
    assert.equal(odds.length, 5, where);
    assert.ok(Math.abs(odds.reduce((a, b) => a + b, 0) - 1) < 1e-6, where);
    assert.equal(odds[4], 0, 'a pristine node is not a roll, it is a treasure');
  }
  // The whole royal continent rolls the same odds as the worst Outlands zone.
  assert.deepEqual(G.rareOdds.royal, G.rareOdds.outlandsLow);
  assert.deepEqual(G.rareOdds.royal.slice(0, 4), [0.9445, 0.05, 0.005, 0.0005]);
  // Four times the uncommon rate in a high-quality Outlands zone.
  assert.equal(G.rareOdds.outlandsHigh[1], 0.2);
});

test('zone colour changes gathering fame and nothing else', () => {
  for (const colour of ['safe', 'yellow', 'orange', 'red', 'black']) {
    assert.equal(G.fameFactor[colour], 1, colour);
  }
  assert.equal(G.fameFactor.black6, 1.5);
  // There is no yield, speed or respawn factor by zone anywhere in the dumps.
  assert.equal(G.fameFactor.yieldFactor, undefined);
});

test('premium is the one number here the game does not publish', () => {
  assert.equal(G.premiumYield, 0.5);
  // Flagged, because it comes from the client's store copy rather than from
  // a table, and the app has to say so wherever it shows it.
  assert.equal(G.premiumYieldSource, 'localization');
});
