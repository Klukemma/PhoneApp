// Open world farming: the pure parts of the screen.
//
// The shell has no test coverage by construction - there is no DOM here - so
// these cover the builders the screen stands on, and in particular the one
// claim it makes in its own headline: that the destiny board and the gatherer
// set are worth something, and that the something is fewer swings.

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
const wild = await import('../js/wild.js');
const { gatherRun } = await import('../js/gather.js');
store.hydrate(await store.loadGameData());

const kitted = () => {
  store.wipe();
  store.setGather({
    toolTier: 8, toolAvalon: true, kind: 'static', zone: 'royal', danger: 'black',
    gear: { head: 8, armor: 8, shoes: 8, backpack: 8 }, food: 'T7_MEAL_PIE',
    fish: { rodTier: 8, gear: { head: 8, armor: 8, shoes: 8, backpack: 8 },
      water: 'freshwater', zone: 'swamp' },
  });
  store.setNodeLevel('GATHER_WOOD_T5', 100);
  return store.state.settings;
};

/* -------------------------------------------------------- the payoff -- */

test('what the board and the set actually buy is swings, and only swings', () => {
  /* The claim the hero makes. Worth a test that breaks if it stops being true,
   * because the obvious units are all blind to it: level the board and put on
   * a full set and the pile, the fame and the hours do not move at all. */
  store.wipe();
  store.setGather({ toolTier: 8, kind: 'static', zone: 'royal' });
  const bare = gatherRun('T5_WOOD', { qty: 999, settings: store.state.settings });

  kitted();
  const real = gatherRun('T5_WOOD', { qty: 999, settings: store.state.settings });

  assert.equal(real.qty, bare.qty, 'a stack is a stack');
  assert.equal(real.fame, bare.fame, 'and the fame off it does not move');
  assert.ok(real.weight < bare.weight, 'and the pack takes weight off');

  /* 2.85x, and every part of it is published: a full T8 set is +70% a swing,
   * an Avalonian tool +20%, a pork pie +15% and the board +50%, which together
   * halve the swings; and the board's speed half takes the swing itself down
   * by the 40% the attribute table caps it at. */
  const pay = wild.kitPayoff('T5_WOOD');
  assert.equal(Number(pay.times.toFixed(2)), 2.85);
  assert.ok(real.swingSeconds < bare.swingSeconds / 2.8, 'the swinging collapses');
  assert.equal(Number(pay.realSeconds.toFixed(4)), Number(real.swingSeconds.toFixed(4)));
  assert.equal(Number(pay.bareSeconds.toFixed(4)), Number(bare.swingSeconds.toFixed(4)));
});

test('a bare kit is worth nothing, and the line says nothing rather than 1.0x', () => {
  store.wipe();
  store.setGather({ toolTier: 5, kind: 'static', zone: 'royal' });
  const pay = wild.kitPayoff('T5_WOOD');
  assert.equal(pay.times, 1, 'the same tool twice is the same run twice');
  /* And premium is deliberately not in the comparison. It is a subscription
   * rather than something you levelled or bought for this, and the line it
   * feeds names the board, the set, the tool and the pie. */
  assert.equal(store.state.settings.premium, true);
  assert.equal(pay.realSeconds, pay.bareSeconds);
});

test('a resource you cannot gather has no payoff to report', () => {
  store.wipe();
  store.setGather({ toolTier: 2, kind: 'static', zone: 'royal' });
  // Two tiers under the node and the game refuses the swing outright.
  assert.equal(wild.kitPayoff('T8_WOOD'), null);
});

/* --------------------------------------------------------- the units -- */

test('a unit is offered when your own entries have earned it, never before', () => {
  store.wipe();
  assert.equal(wild.unitsAvailable().load, false, 'no kilos typed');
  store.setSettings({ carryWeight: 1000 });
  const avail = wild.unitsAvailable();
  assert.equal(avail.load, true);
  assert.equal(avail.capacity.typed, 1000);
  // A pie raises what you can carry, and the figure says so.
  store.setGather({ food: 'T7_MEAL_PIE' });
  assert.equal(wild.unitsAvailable().capacity.total, 1300);
  // There is no third state to earn: a stack always works.
  assert.equal(wild.unitsAvailable().stack, true);
});

/* -------------------------------------------------------- the ranking -- */

test('land and water come back in one list, on one tier', () => {
  kitted();
  const { tier, rows } = wild.wildRank(5);
  assert.equal(tier, 5);
  const land = rows.filter((r) => r.kind === 'land');
  const fish = rows.filter((r) => r.kind === 'fish');
  assert.equal(land.length, 5, 'the five families');
  /* Two fish at T5: the common of your water and the ONE rare your landscape
   * carries. Listing all seven freshwater rares would be honest about the file
   * and useless on the glass - at a tier they are identical in every published
   * number. */
  assert.equal(fish.length, 2);
  assert.ok(fish.some((r) => r.id === 'T5_FISH_FRESHWATER_ALL_COMMON'));
  assert.ok(fish.some((r) => r.id === 'T5_FISH_FRESHWATER_SWAMP_RARE'));
  for (const r of rows) {
    assert.ok(r.kind && r.id && Array.isArray(r.missing), 'every row is shaped the same');
  }
});

test('the landscape picks which rare, and saltwater has only the one', () => {
  kitted();
  store.setGather({ fish: { zone: 'highlands' } });
  const fresh = wild.wildRank(5).rows.filter((r) => r.kind === 'fish').map((r) => r.id);
  assert.ok(fresh.includes('T5_FISH_FRESHWATER_HIGHLANDS_RARE'));
  assert.ok(!fresh.includes('T5_FISH_FRESHWATER_SWAMP_RARE'));

  store.setGather({ fish: { water: 'saltwater' } });
  const salt = wild.wildRank(5).rows.filter((r) => r.kind === 'fish').map((r) => r.id);
  assert.deepEqual(salt.sort(), [
    'T5_FISH_SALTWATER_ALL_COMMON', 'T5_FISH_SALTWATER_ALL_RARE',
  ]);
});

test('a tier with no rare shows no rare, and T8 shows the shark instead', () => {
  kitted();
  const six = wild.wildRank(6).rows.filter((r) => r.kind === 'fish').map((r) => r.id);
  assert.deepEqual(six, ['T6_FISH_FRESHWATER_ALL_COMMON'], 'rares are T3, T5, T7 only');
  store.setGather({ fish: { water: 'saltwater' } });
  const eight = wild.wildRank(8).rows.filter((r) => r.kind === 'fish').map((r) => r.id);
  assert.ok(eight.includes('T8_FISH_SALTWATER_ALL_BOSS_SHARK'),
    'the most valuable catch in the game is not silently absent');
});

test('a tool too small is a row with a reason, not a row missing', () => {
  store.wipe();
  store.setGather({ toolTier: 4, kind: 'static', zone: 'royal' });
  const rows = wild.wildRank(8).rows.filter((r) => r.kind === 'land');
  assert.equal(rows.length, 5, 'all five still appear');
  assert.ok(rows.every((r) => r.blocked && r.why !== ''), 'each carrying its reason');
  assert.match(rows[0].blocked.why, /tool/);
});

test('the ids the screen needs priced are the ids it shows', () => {
  kitted();
  const ids = wild.wildMissingIds(5);
  assert.ok(ids.length > 0, 'a fresh install has priced nothing');
  assert.ok(ids.includes('T5_WOOD'));
  assert.ok(ids.some((id) => id.startsWith('T5_FISH_')));
  // And every one of them is an id the app can name, or the fetch screen
  // would show a column of raw ids.
  for (const id of ids) {
    assert.ok(store.itemMeta(id), `${id} has no name`);
  }
});

test('it opens on the tier you are equipped for, unless you have never priced it', () => {
  /* Your tool's tier is the one you are equipped for, so that is first. But a
   * screen that opens on seven rows of "needs a price" has answered nothing,
   * and the tier you have prices for is the tier you have been shopping in. */
  store.wipe();
  store.setGather({ toolTier: 8, kind: 'static', zone: 'royal' });
  assert.equal(wild.wildRank().tier, 8, 'nothing priced anywhere: the tool wins');

  store.setPrice('T5_WOOD', 260);
  store.setPrice('T5_ORE', 240);
  store.setPrice('T5_PLANKS', 1100);
  assert.equal(wild.wildRank().tier, 5, 'the only tier with anything in it');

  store.setPrice('T8_WOOD', 900);
  assert.equal(wild.wildRank().tier, 8, 'and the tool takes it back the moment it can');

  // An explicit tap always wins over both.
  assert.equal(wild.wildRank(3).tier, 3);
});
