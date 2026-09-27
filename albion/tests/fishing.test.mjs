// Fishing: the engine, not the tables.
//
// tests/gather.test.mjs already asserts what the game files say about fishing -
// the forty-one fish, the pack ladder, the bait charges, the two board nodes.
// This is the other half: what js/fish.js does with them, and above all what it
// refuses to do, because the whole risk in fishing is a number that does not
// exist being quietly supplied.

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const disk = new Map();
globalThis.localStorage = {
  getItem: (k) => (disk.has(k) ? disk.get(k) : null),
  setItem: (k, v) => disk.set(k, String(v)),
  removeItem: (k) => disk.delete(k),
};
const data = JSON.parse(
  readFileSync(new URL('../data/gamedata.json', import.meta.url), 'utf8'));
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => data });

const store = await import('../js/store.js');
const F = await import('../js/fish.js');
store.hydrate(await store.loadGameData());

const COMMON = 'T5_FISH_FRESHWATER_ALL_COMMON';
const RARE = 'T7_FISH_FRESHWATER_SWAMP_RARE';
const AVALON = 'T7_FISH_FRESHWATER_AVALON_RARE';
const SHARK = 'T8_FISH_SALTWATER_ALL_BOSS_SHARK';

const fresh = (fish = {}) => {
  store.wipe();
  store.setGather({ fish: { rodTier: 8, ...fish } });
  return store.state.settings;
};

/* ------------------------------------------------------- the refusals -- */

test('with no rod there is no run, and the reason is the ask', () => {
  store.wipe();
  const run = F.fishRun(COMMON, { settings: store.state.settings });
  assert.equal(run.impossible, true);
  assert.match(run.why, /rod/);
  // And it is a refusal, not a zero: nothing here could be mistaken for silver.
  assert.equal(run.perHour, undefined);
  assert.equal(run.hours, undefined);
});

test('an hour does not exist until you have timed one', () => {
  const s = fresh();
  const run = F.fishRun(COMMON, { qty: 999, settings: s });
  assert.equal(run.hours, null, 'null, not zero and not a ceiling');
  assert.equal(run.perHour, 0);
  assert.ok(run.assumed.some((a) => /no game file/.test(a)));
  // Everything that needs no clock is there and is a real number.
  assert.ok(run.weight > 0);
  assert.ok(run.fame > 0);
  assert.equal(run.chops, 999 * 6);
});

test('a timed count belongs to the common, and is never lent to a rare', () => {
  /* A count is "what bit in ten minutes", and what bites is overwhelmingly the
   * common. How often a rare takes the hook instead is in no file, so handing
   * the common's rate to a rare would claim you can catch 600 clams an hour
   * because you once caught 600 trout. */
  const s = fresh({ water: 'freshwater', bait: '' });
  store.setFishMeasured(F.fishRateKey(5, F.fishKitOf(s)), 100);
  const common = F.fishRun(COMMON, { qty: 999, settings: store.state.settings });
  assert.equal(common.perHour, 600);
  assert.equal(common.hours, 999 / 600);

  store.setFishMeasured(F.fishRateKey(7, F.fishKitOf(store.state.settings)), 100);
  const rare = F.fishRun(RARE, { qty: 999, settings: store.state.settings });
  assert.equal(rare.hours, null, 'a rare has no hour however much you timed');
  assert.equal(rare.perHour, 0);
  assert.ok(rare.assumed.some((a) => /how often a rare bites/.test(a)));
  // And the stack and the load stay exact for it.
  assert.ok(rare.weight > 0 && rare.fame > 0);
});

test('the boss shark is its own case, not a rare and not a common', () => {
  const s = fresh({ water: 'saltwater' });
  store.setFishMeasured(F.fishRateKey(8, F.fishKitOf(s)), 100);
  const run = F.fishRun(SHARK, { qty: 10, settings: store.state.settings });
  assert.equal(run.rarity, 'boss');
  assert.equal(run.hours, null);
  assert.ok(run.assumed.some((a) => /how often a boss bites/.test(a)));
  assert.equal(run.chops, 2000, 'two hundred chops each');
});

test('every published speed bonus is shown and none of it is usable', () => {
  const s = fresh({ bait: 'T5_FISHINGBAIT' });
  store.setNodeLevel('GATHER_FISH', 100);
  store.setNodeLevel('GATHER_FISH_FISH', 100);
  const speed = F.fishSpeed(store.state.settings);
  assert.equal(speed.usable, false, 'permanently');
  assert.match(speed.why, /no cast time/);
  assert.equal(speed.capped, false);
  const what = speed.parts.map((p) => p.what);
  assert.ok(what.some((w) => /rod/i.test(w)));
  assert.ok(what.some((w) => /bait/i.test(w)));
  assert.ok(what.some((w) => /with a rod/.test(w)), 'the board half names its condition');
  // +5% rod, +250% bait, +15% and +35% board.
  assert.equal(Number(speed.total.toFixed(2)), 3.05);
});

test('with no rod in hand the board pays no speed, because the file says so', () => {
  store.wipe();
  store.setNodeLevel('GATHER_FISH', 100);
  store.setNodeLevel('GATHER_FISH_FISH', 100);
  const speed = F.fishSpeed(store.state.settings);
  assert.equal(speed.total, 0);
  // The yield half has no item gate at all, so it still pays.
  store.setGather({ fish: { rodTier: 0 } });
  assert.equal(Number(F.fishYield(store.state.settings, COMMON).spec.toFixed(2)), 0.5);
});

/* ------------------------------------------------------------ the kit -- */

test('the fishing kit is its own, and a land set never leaks into it', () => {
  store.wipe();
  store.setGather({ toolTier: 8, toolAvalon: true, gear: { head: 8, armor: 8, shoes: 8, backpack: 8 } });
  const kit = F.fishKitOf(store.state.settings);
  assert.equal(kit.rodTier, 0, 'a T8 axe is not a rod');
  assert.deepEqual(kit.gear, { head: 0, armor: 0, shoes: 0, backpack: 0 });
  // The pie and premium ARE shared, because they are the same items.
  store.setGather({ food: 'T7_MEAL_PIE' });
  assert.equal(F.fishKitOf(store.state.settings).food, 'T7_MEAL_PIE');
  assert.equal(F.fishYield(store.state.settings, COMMON).food, 0.15);
});

test('the fishing set is worth what the land set is worth', () => {
  const s = fresh({ gear: { head: 8, armor: 8, shoes: 8 }, rodAvalon: true });
  const y = F.fishYield(store.state.settings, COMMON);
  assert.equal(Number(y.gear.toFixed(3)), 0.7, 'a full T8 set is +70% either way');
  assert.equal(y.rod, 0.2, 'and an Avalonian rod adds its own');
  // A plain rod has no passive slot, so it adds no yield at all.
  store.setGather({ fish: { rodAvalon: false } });
  assert.equal(F.fishYield(store.state.settings, COMMON).rod, 0);
});

test('a T1 fish gets the set that a T1 tree could not', () => {
  // The one real difference from land: the floor is T1, not T2.
  const s = fresh({ gear: { armor: 4 } });
  assert.ok(F.fishYield(store.state.settings, 'T1_FISH_FRESHWATER_ALL_COMMON').gear > 0);
});

/* ------------------------------------------------------- what it weighs -- */

test('the pack carries the swamp rare and refuses the Avalonian one', () => {
  const s = fresh({ gear: { backpack: 8 } });
  const carried = F.fishWeight(store.state.settings, RARE);
  assert.equal(carried.cut, 0.4);
  assert.equal(Number(carried.each.toFixed(4)), Number((1.04 * 0.6).toFixed(4)));
  assert.equal(carried.why, '');

  const refused = F.fishWeight(store.state.settings, AVALON);
  assert.equal(refused.cut, 0, 'no pack names it at any tier');
  assert.equal(refused.each, 1.04, 'so it weighs what it weighs');
  assert.match(refused.why, /Avalonian and dragon-area/);
  // Same tier, same weight, opposite answer - which is the whole point.
  assert.equal(data.gathering.fishing.fish[AVALON].weight,
    data.gathering.fishing.fish[RARE].weight);
});

test('a pack under the fish s tier carries nothing', () => {
  const s = fresh({ gear: { backpack: 4 } });
  const w = F.fishWeight(store.state.settings, RARE);
  assert.equal(w.cut, 0);
  assert.match(w.why, /tier/);
});

/* ---------------------------------------------------------- the books -- */

test('a book is chosen by the land convention, never by lootFrom', () => {
  const s = fresh();
  assert.equal(F.fishJournal(store.state.settings, 5).tier, 5);
  assert.equal(F.fishJournal(store.state.settings, 8).tier, 8);
  /* A T1 catch gets the T2 book, because the published ladder starts at T2 -
   * and NOT because lootFrom says the T2 book loots T1 fish. Which catches
   * fill a fisherman's book is in no file at all. */
  assert.equal(F.fishJournal(store.state.settings, 1).tier, 2);
  assert.equal(F.fishJournal(store.state.settings, 5).fame, 3680);
  assert.equal(F.fishJournal(store.state.settings, 5).emptyId, 'T5_JOURNAL_FISHING_EMPTY');
});

/* ------------------------------------------------------------- the key -- */

test('a count is filed under the water and the bait, and nothing else', () => {
  const s = fresh({ water: 'freshwater', bait: '' });
  const plain = F.fishRateKey(5, F.fishKitOf(store.state.settings));
  assert.equal(plain, 'FISH:5:freshwater:none');
  store.setGather({ fish: { bait: 'T5_FISHINGBAIT' } });
  const baited = F.fishRateKey(5, F.fishKitOf(store.state.settings));
  assert.notEqual(baited, plain, 'bait is +250% speed — a different measurement');
  store.setGather({ fish: { water: 'saltwater' } });
  assert.notEqual(F.fishRateKey(5, F.fishKitOf(store.state.settings)), baited);
  // The set and the rod are NOT in the key: they change what a catch gives,
  // not how often one comes.
  store.setGather({ fish: { water: 'freshwater', bait: '', gear: { head: 8 } } });
  assert.equal(F.fishRateKey(5, F.fishKitOf(store.state.settings)), plain);
});

/* ----------------------------------------------------------- the bait -- */

test('bait is ten casts, and the pile needs whichever bound bites first', () => {
  const s = fresh({ bait: 'T5_FISHINGBAIT', water: 'freshwater' });
  const run = F.fishRun(COMMON, { qty: 1000, settings: store.state.settings });
  assert.equal(run.baitsByCast, 100, 'a thousand fish is at least a hundred baits');
  assert.equal(run.baitsByClock, null, 'and the clock bound needs a timed run');
  assert.equal(run.baits, 100);
  assert.equal(run.baitBound, 'casts');
  // Time it slowly enough and ten minutes runs out before ten casts do.
  store.setFishMeasured(F.fishRateKey(5, F.fishKitOf(store.state.settings)), 5);
  const slow = F.fishRun(COMMON, { qty: 1000, settings: store.state.settings });
  assert.ok(slow.baitsByClock > slow.baitsByCast);
  assert.equal(slow.baits, slow.baitsByClock);
  assert.equal(slow.baitBound, 'clock');
});

test('a bait a save remembers and the game does not cannot crash the sheet', () => {
  /* normalizeFish deliberately keeps an unknown bait id - it runs before the
   * game file is hydrated, and throwing one away would lose a real setting. So
   * every reader has to cope, and this is the one that did not. */
  const s = fresh({ bait: 'T9_FISHINGBAIT' });
  store.setPrice(COMMON, 34);
  store.setPrice('T9_FISHINGBAIT', 900);
  const ctx = {
    settings: store.state.settings, priceOf: store.priceOf, costOf: store.costOf,
  };
  const even = F.baitBreakEven(COMMON, ctx);
  assert.ok(even, 'answers rather than throwing');
  assert.equal(even.fromSpeed, 0, 'an unknown bait is worth nothing, not undefined');
  for (const r of even.rows) {
    if (!r.missing) assert.ok(Number.isFinite(r.fishPerHour));
  }
});

test('the break-even is a count to check, not a prediction', () => {
  const s = fresh({ bait: '' });
  store.setPrice(COMMON, 40);
  store.setPrice('T5_FISHINGBAIT', 3000);
  const ctx = {
    settings: store.state.settings, priceOf: store.priceOf, costOf: store.costOf,
  };
  const even = F.baitBreakEven(COMMON, ctx);
  const best = even.rows.find((r) => r.id === 'T5_FISHINGBAIT');
  // 3000 over ten casts is 300 a cast; a fish nets 40 less tax.
  assert.equal(best.perCast, 300);
  assert.ok(best.fishPerHour > 0);
  assert.equal(Math.round(best.fishPerHour), Math.round(300 / even.perFish * 60));
  assert.match(even.why, /not a prediction/);
});

/* ----------------------------------------------------------- the exits -- */

test('every way out of a pile of fish, and what each one is missing', () => {
  const s = fresh({ bait: '' });
  store.setPrice(COMMON, 40);
  const ctx = {
    settings: store.state.settings, priceOf: store.priceOf, costOf: store.costOf,
    sellPriceOf: store.priceOf, recipeOf: () => null,
  };
  const rows = F.fishExits(COMMON, ctx, { qty: 999 });
  assert.equal(rows.length, 4, 'sell it, and three grades of sauce');
  const raw = rows.find((r) => r.key === 'raw');
  assert.deepEqual(raw.missing, [], 'the catch has a price');
  const sauce = rows.find((r) => r.key === 'sauce1');
  assert.ok(sauce.missing.length, 'and the sauce has none yet');
  // 999 commons at six chops each is 5,994 chops, which is 399 basic sauces.
  assert.equal(sauce.made, Math.floor(999 * 6 / 15));
  assert.ok(sauce.assumed.some((a) => /return rate/.test(a)),
    'the station is not assumed to give anything back');
});

test('the kit share is what your entries bought, and it is never applied twice', () => {
  const s = fresh({ gear: { head: 8, armor: 8, shoes: 8 }, rodAvalon: true, bait: '' });
  store.setFishMeasured(F.fishRateKey(5, F.fishKitOf(store.state.settings)), 100);
  const run = F.fishRun(COMMON, { qty: 999, settings: store.state.settings });
  const mult = F.fishYield(store.state.settings, COMMON).multiplier;
  assert.ok(mult > 1.5);
  assert.equal(run.kitShare, 1 - 1 / mult);
  /* And the count itself is untouched by it. A count you took already had the
   * set on; multiplying it again would pay every bonus twice. */
  assert.equal(run.perHour, 600);
  assert.equal(run.qty, 999);
});

test('a rod under the fish is a warning on the run, never a run that is missing', () => {
  /* No file says what an undersized rod costs you - there is no rod tier table
   * for fishing at all - so this cannot be a refusal. It also cannot be an
   * object with the warning and nothing else: every other figure is still
   * exact, and a caller that read them found undefined. */
  const s = fresh({ rodTier: 5, water: 'saltwater' });
  const run = F.fishRun('T8_FISH_SALTWATER_ALL_COMMON', { qty: 999, settings: store.state.settings });
  assert.equal(run.impossible, undefined);
  assert.match(run.warn, /T5 rod is under a T8 fish/);
  assert.ok(Array.isArray(run.assumed), 'and the honest list is still a list');
  assert.ok(run.weight > 0 && run.fame > 0 && run.chops === 999 * 14);
  // A rod at or over the tier carries no warning at all.
  store.setGather({ fish: { rodTier: 8 } });
  assert.equal(F.fishRun('T8_FISH_SALTWATER_ALL_COMMON',
    { qty: 1, settings: store.state.settings }).warn, '');
});

test('the exits of an undersized-rod run are still exits', () => {
  const s = fresh({ rodTier: 5, water: 'saltwater' });
  store.setPrice('T8_FISH_SALTWATER_ALL_COMMON', 120);
  const ctx = {
    settings: store.state.settings, priceOf: store.priceOf, costOf: store.costOf,
    sellPriceOf: store.priceOf, recipeOf: () => null,
  };
  const rows = F.fishExits('T8_FISH_SALTWATER_ALL_COMMON', ctx, { qty: 999 });
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => Array.isArray(r.assumed)));
});
