// The store: what a save turns into when it is read back.
//
// Every other test in here works on pure functions with data handed to them.
// This one is about the module that holds the user's real, only copy of their
// own numbers, so it is about the boring half: does a file written by an older
// version of the app still open, does a hand-edited backup reach the engine as
// nonsense, and does anything that is game data survive a save it should not
// have been in.

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

/* The module reads and writes localStorage at import time, so it needs one.
 * A plain Map is enough and it lets a test say what was on the phone before
 * the app started, which is the whole point of the exercise. */
const disk = new Map();
globalThis.localStorage = {
  getItem: (k) => (disk.has(k) ? disk.get(k) : null),
  setItem: (k, v) => disk.set(k, String(v)),
  removeItem: (k) => disk.delete(k),
};

const data = JSON.parse(
  readFileSync(new URL('../data/gamedata.json', import.meta.url), 'utf8'));

/* The app boots by fetching the game data and then hydrating with it, and the
 * module keeps its own handle on what came back - which is what a restore and
 * a wipe rebuild the constants from. Booting it the same way here rather than
 * calling hydrate alone is the difference between testing the store and
 * testing a store that has never seen a game file. */
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => data });

const store = await import('../js/store.js');
const { hydrate, importJSON, exportJSON, setGather, setMeasured, state, wipe } = store;

hydrate(await store.loadGameData());

/** Read a save back the way the app does on a cold start. */
const reopen = (raw) => { importJSON(JSON.stringify(raw)); return state; };

const freshKit = () => {
  wipe();
  return state.settings.gather;
};

/* ------------------------------------------------------- the defaults -- */

test('a brand new install assumes no gathering kit at all', () => {
  const kit = freshKit();
  // A full set and a pork pie is most of a second run's worth of resources.
  // Assuming any of it would double every figure for someone who owns none.
  assert.equal(kit.toolTier, 0);
  assert.deepEqual(kit.gear, { head: 0, armor: 0, shoes: 0, backpack: false });
  assert.equal(kit.food, '');
  assert.equal(kit.potion, '');
  assert.deepEqual(kit.measured, {});
  // Except the two readings of an unpublished rule, which need a default.
  assert.equal(kit.premiumMode, 'add', 'the conservative reading');
  assert.equal(kit.gearCoversEnchanted, true);
});

/* ------------------------------------------------------ old save files -- */

test('a save written before gathering existed still opens', () => {
  const old = {
    schema: 2,
    settings: { premium: true, craftCity: 'martlock', useFocus: true },
    prices: { T5_WOOD: 260 },
    nodeLevels: { FARM_ALCHEMIST: 50 },
    goal: { recipeId: 'T4_POTION_HEAL', plots: 9 },
    farm: [{ id: 'a', cityId: 'martlock', kind: 'farm', count: 9 }],
    plan: { plots: [], crafts: [] },
  };
  const s = reopen(old);
  assert.equal(s.settings.premium, true, 'nothing else was disturbed');
  assert.equal(s.prices.T5_WOOD, 260);
  assert.equal(s.nodeLevels.FARM_ALCHEMIST, 50);
  // And the kit it never had is the default one rather than undefined, which
  // would reach the yield engine as a crash.
  assert.equal(s.settings.gather.toolTier, 0);
  assert.deepEqual(s.settings.gather.measured, {});
});

test('a save written half way through keeps what it had and fills the rest', () => {
  // The tool arrived before the gear slots did, so a save from between the two
  // has one and not the other. Losing the tool would be silent and annoying.
  const s = reopen({
    schema: 2,
    settings: { gather: { toolTier: 7, toolAvalon: true } },
  });
  assert.equal(s.settings.gather.toolTier, 7);
  assert.equal(s.settings.gather.toolAvalon, true);
  assert.deepEqual(s.settings.gather.gear, { head: 0, armor: 0, shoes: 0, backpack: false });
  assert.equal(s.settings.gather.kind, 'static');
});

test('a hand-edited backup cannot smuggle nonsense into the yield engine', () => {
  const s = reopen({
    schema: 2,
    settings: {
      gather: {
        toolTier: 99,
        gear: { head: -3, armor: 'eight', shoes: 8, backpack: 'yes' },
        foodEnchant: 9,
        potionEnchant: -1,
        premiumMode: 'compound',
        measured: {
          'WOOD:5:static:royal': { per10min: 90 },
          'ORE:5:static:royal': { per10min: -5 },
          'HIDE:5:static:royal': { per10min: 'lots' },
        },
      },
    },
  });
  const kit = s.settings.gather;
  assert.equal(kit.toolTier, 0, 'a tier the game does not have is no tier');
  assert.equal(kit.gear.head, 0);
  assert.equal(kit.gear.armor, 0);
  assert.equal(kit.gear.shoes, 8, 'and a real one is kept');
  /* Gatherer gear starts at T4 - the game sells no T3 cap - so a save with
   * one in it is not a small bonus, it is a piece that does not exist, and
   * keeping it would put a row on the screen worth nothing. */
  const low = reopen({
    schema: 2,
    settings: { gather: { toolTier: 3, toolAvalon: true, gear: { head: 3, armor: 4 } } },
  }).settings.gather;
  assert.equal(low.gear.head, 0);
  assert.equal(low.gear.armor, 4);
  // A T3 tool is real and decides the swing; an Avalonian one at T3 is not.
  assert.equal(low.toolTier, 3);
  assert.equal(low.toolAvalon, false);
  // And T1, which is a real tool for the tiers you can take bare-handed.
  assert.equal(reopen({ schema: 2, settings: { gather: { toolTier: 1 } } })
    .settings.gather.toolTier, 1);
  assert.equal(kit.gear.backpack, true);
  assert.equal(kit.foodEnchant, 3, 'clamped to the grades that exist');
  assert.equal(kit.potionEnchant, 0);
  assert.equal(kit.premiumMode, 'add', 'one of the two readings, or the default');
  assert.deepEqual(Object.keys(kit.measured), ['WOOD:5:static:royal'],
    'a rate that is not a positive number is not a rate');
});

test('game data never comes back out of a save', () => {
  /* The gathering tables are regenerated from the game files every boot. A
   * copy that rode in on a backup would be the one the engine reads, and a
   * patch that changed a node would then never reach the person who restored
   * from it. Same rule the cities table already follows. */
  const s = reopen({
    schema: 2,
    settings: {
      gathering: { speedCap: 9, nodes: {}, board: [], rareOdds: {} },
      cities: [{ id: 'nowhere', name: 'Nowhere' }],
    },
  });
  assert.equal(s.settings.gathering.speedCap, data.gathering.speedCap);
  assert.equal(s.settings.gathering.board.length, data.gathering.board.length);
  assert.ok(!s.settings.cities.some((c) => c.id === 'nowhere'));
});

/* ------------------------------------------------------------ setters -- */

test('changing one part of the kit keeps the rest of it', () => {
  wipe();
  setGather({ toolTier: 8, gear: { head: 8, armor: 8, shoes: 8, backpack: false } });
  setGather({ food: 'T7_MEAL_PIE' });
  const kit = state.settings.gather;
  assert.equal(kit.toolTier, 8, 'setting the pie did not drop the tool');
  assert.equal(kit.gear.head, 8, 'nor the set');
  assert.equal(kit.food, 'T7_MEAL_PIE');
  // And a setter goes through the same clamp as a save does.
  setGather({ toolTier: 12 });
  assert.equal(state.settings.gather.toolTier, 0);
});

test('a measured rate is kept, corrected and cleared through one door', () => {
  wipe();
  setMeasured('WOOD:5:static:royal', 90);
  assert.deepEqual(state.settings.gather.measured['WOOD:5:static:royal'], { per10min: 90 });
  setMeasured('WOOD:5:static:royal', 112.4);
  assert.equal(state.settings.gather.measured['WOOD:5:static:royal'].per10min, 112);
  // Zero is how you say you no longer stand behind it, and then the app goes
  // back to refusing to quote hours rather than quoting a stale number.
  setMeasured('WOOD:5:static:royal', 0);
  assert.equal(state.settings.gather.measured['WOOD:5:static:royal'], undefined);
  // Another resource's rate is untouched by any of that.
  setMeasured('ORE:6:critter:outlandsHigh', 40);
  setMeasured('WOOD:5:static:royal', 90);
  assert.equal(state.settings.gather.measured['ORE:6:critter:outlandsHigh'].per10min, 40);
});

/* ------------------------------------------------------- price age ----- */

test('a price remembers when it was last a real observation', () => {
  wipe();
  const { setPrice, setPrices, priceSeenAt } = store;
  assert.equal(priceSeenAt('T5_WOOD'), 0, 'nothing known yet');

  setPrice('T5_WOOD', 260);
  const first = priceSeenAt('T5_WOOD');
  assert.ok(first > 0 && Math.abs(Date.now() - first) < 120000, 'typed just now');

  /* The price sheet saves on every open, on Enter in three boxes and before
   * every fetch. Re-saving the SAME number must not mark it fresh, or the
   * staleness warning could never fire for anyone who opened the sheet. */
  setPrice('T5_WOOD', 260);
  assert.equal(priceSeenAt('T5_WOOD'), first, 'unchanged means unobserved');

  // A different number is a new observation.
  setPrice('T5_WOOD', 280);
  assert.ok(priceSeenAt('T5_WOOD') >= first);

  /* A fetch carries the market's OWN date, not the moment of the fetch. A
   * quote the data project saw three weeks ago is three weeks old however
   * long ago you pressed the button. */
  const threeWeeks = Date.now() - 21 * 24 * 3600e3;
  setPrices({ T5_PLANKS: 1100 }, { T5_PLANKS: threeWeeks });
  const aged = priceSeenAt('T5_PLANKS');
  assert.ok(Math.abs(aged - threeWeeks) < 120000, 'kept the market\'s date');
  assert.ok(Date.now() - aged > 20 * 24 * 3600e3);

  // Clearing a price forgets its date too.
  setPrice('T5_WOOD', 0);
  assert.equal(priceSeenAt('T5_WOOD'), 0);
});

test('prices saved before dates existed are unknown, not fresh', () => {
  /* Back-dating them to the moment of the upgrade would be inventing a
   * number, and calling them fresh would be worse: it would silence the one
   * warning that exists to catch them. */
  const s = reopen({
    schema: 2,
    settings: {},
    prices: { T5_WOOD: 260, T5_PLANKS: 1100 },
  });
  assert.equal(s.prices.T5_WOOD, 260, 'the price itself survives');
  assert.deepEqual(s.priceSeen, {});
  assert.equal(store.priceSeenAt('T5_WOOD'), 0);
  // And a hand-edited date that is not a number is dropped, not trusted.
  const junk = reopen({
    schema: 2,
    prices: { T5_WOOD: 260, T5_ORE: 240 },
    priceSeen: { T5_WOOD: 'yesterday', T5_ORE: 29000000 },
  });
  assert.equal(junk.priceSeen.T5_WOOD, undefined);
  assert.equal(junk.priceSeen.T5_ORE, 29000000);
});

/* ----------------------------------------------------- round tripping -- */

test('a backup taken now opens as itself', () => {
  wipe();
  setGather({
    toolTier: 6, toolAvalon: true, kind: 'critter', zone: 'outlandsHigh',
    danger: 'black3', food: 'T5_MEAL_PIE', foodEnchant: 2,
    gear: { head: 6, armor: 5, shoes: 6, backpack: true },
    premiumMode: 'multiply', gearCoversEnchanted: false,
  });
  setMeasured('WOOD:6:critter:outlandsHigh', 140);
  const before = JSON.parse(JSON.stringify(state.settings.gather));
  const backup = exportJSON();
  wipe();
  assert.equal(state.settings.gather.toolTier, 0, 'really wiped');
  importJSON(backup);
  assert.deepEqual(state.settings.gather, before);
});
