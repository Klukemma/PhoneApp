// Reminders: what gets an alarm, and what deliberately does not.
//
// An alarm is an assertion about the world that arrives while you are not
// looking at the app, so it is the one place a guess costs most. These cover
// the refusals as hard as the schedulings.

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
globalThis.window = {};

const store = await import('../js/store.js');
const N = await import('../js/notify.js');
const R = await import('../js/rounds.js');
store.hydrate(await store.loadGameData());

const CARROT = 'T1_FARM_CARROT_SEED';
const OX = data.animals.find((a) => a.maxCycles >= 4).id;
const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);
const min = (ms) => Math.floor(ms / 60000);

const ctx = (over = {}) => ({
  settings: { ...store.state.settings, ...over },
  plants: data.plants,
  animals: data.animals,
});
const island = (plots) => [{ id: 'i1', name: 'Home', cityId: 'martlock', plots }];

test('a browser can set no alarm, and says so rather than pretending', () => {
  /* No web page can schedule one - the browser feature that would have allowed
   * it was dropped by Chrome and never existed in Safari. The module is a
   * no-op rather than a silent failure. */
  assert.equal(N.canRemind(), false);
});

test('an alarm per growing plot, at the moment it is ready', () => {
  const plots = [
    { id: 'a', kind: 'farm', itemId: CARROT, plantedMin: min(T0), caredMin: [] },
  ];
  const want = N.plannedReminders(ctx(), island(plots), T0 + 3600e3);
  assert.equal(want.length, 1);
  assert.equal(want[0].at, min(T0) + 22 * 60, 'the published 22 hours, from your tap');
  assert.match(want[0].title, /Carrots is ready/);
  assert.match(want[0].body, /Home/);
});

test('nothing is scheduled off a moment nobody gave', () => {
  const plots = [
    { id: 'a', kind: 'farm', itemId: CARROT, plantedMin: 0, caredMin: [] },
    { id: 'b', kind: 'farm', itemId: '', plantedMin: 0, caredMin: [] },
  ];
  assert.deepEqual(N.plannedReminders(ctx(), island(plots), T0), [],
    'an untimed plot and an empty one are both silent');
});

test('a plot it has stopped asserting about gets no alarm either', () => {
  /* One whole growth overdue is where the app stops claiming to know what is
   * in a plot. Ringing a phone about it would be claiming it again, in the one
   * place the user cannot see the caveat. */
  const plots = [{ id: 'a', kind: 'farm', itemId: CARROT, plantedMin: min(T0), caredMin: [] }];
  assert.equal(N.plannedReminders(ctx(), island(plots), T0 + 10 * 3600e3).length, 1,
    'still growing: an alarm');
  assert.equal(N.plannedReminders(ctx(), island(plots), T0 + 23 * 3600e3).length, 0,
    'already ready: nothing left to announce');
  assert.equal(N.plannedReminders(ctx(), island(plots), T0 + 50 * 3600e3).length, 0,
    'stale: it does not know, so it does not ring');
});

test('a watering window rings before it shuts, not when it opens', () => {
  const c = ctx({ premium: true, watered: true });
  const every = R.nurturePlan(c, data.animals.find((a) => a.id === OX)).every;
  const plots = [{ id: 'z', kind: 'pasture', itemId: OX, plantedMin: min(T0), caredMin: [] }];
  const want = N.plannedReminders(c, island(plots), T0 + 60000);
  const water = want.find((n) => /Water/.test(n.title));
  assert.ok(water, 'there is one');
  assert.equal(water.at, min(T0) + every - 60, 'an hour before the window shuts');
  assert.match(water.body, /an hour left/);
});

test('a window about to shut anyway is not worth ringing about', () => {
  const c = ctx({ premium: true, watered: true });
  const every = R.nurturePlan(c, data.animals.find((a) => a.id === OX)).every;
  const plots = [{ id: 'z', kind: 'pasture', itemId: OX, plantedMin: min(T0), caredMin: [] }];
  // Ten minutes before it closes: an alarm now would be noise.
  const want = N.plannedReminders(c, island(plots), T0 + (every - 10) * 60000);
  assert.equal(want.filter((n) => /Water/.test(n.title)).length, 0);
});

test('ids are stable, and a plot\'s two alarms never collide', () => {
  /* The ids are how a stale alarm gets cancelled when you harvest early. One
   * that changed between launches would leave the old one to fire anyway. */
  assert.equal(N.idFor('abc', 'ready'), N.idFor('abc', 'ready'));
  assert.notEqual(N.idFor('abc', 'ready'), N.idFor('abc', 'water'));
  assert.notEqual(N.idFor('abc', 'ready'), N.idFor('abd', 'ready'));
  for (const id of ['a', 'zzzzzzzzzzzz', '', '12345', 'p-9']) {
    const n = N.idFor(id, 'ready');
    assert.ok(Number.isInteger(n) && n > 0 && n < 2147483648, `${id} -> ${n}`);
  }
});

test('soonest first, and capped at what a person can use', () => {
  const plots = Array.from({ length: 60 }, (_, i) => ({
    id: `p${i}`, kind: 'farm', itemId: CARROT, plantedMin: min(T0) - i, caredMin: [],
  }));
  const want = N.plannedReminders(ctx(), island(plots), T0 + 3600e3);
  assert.equal(want.length, 48, 'capped');
  for (let i = 1; i < want.length; i += 1) {
    assert.ok(want[i].at >= want[i - 1].at, 'in the order they will happen');
  }
});

test('with no islands there is nothing to say', () => {
  assert.deepEqual(N.plannedReminders(ctx(), [], T0), []);
  assert.deepEqual(N.plannedReminders(ctx(), null, T0), []);
});

test('syncing in a browser is a no-op with a reason, never a throw', async () => {
  const out = await N.syncReminders(ctx(), island([]), T0);
  assert.equal(out.scheduled, 0);
  assert.match(out.why, /packaged/);
  await N.clearReminders();          // must not throw either
  assert.equal(await N.reminderState(), 'unavailable');
});
