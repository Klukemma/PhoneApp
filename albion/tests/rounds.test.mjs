// Your rounds: what the app is willing to say about a plot, and what it is not.
//
// The whole feature rests on one claim - that one tap plus the game's own
// published durations is enough to know when something is ready - and on one
// discipline: never asserting a state nobody reported. These test both, against
// the real game file.

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
const R = await import('../js/rounds.js');
store.hydrate(await store.loadGameData());

const CARROT = 'T1_FARM_CARROT_SEED';
const CHICKEN = 'T3_FARM_CHICKEN_BABY';
const OX = data.animals.find((a) => a.maxCycles >= 4).id;

/** A context in the shape calc.js is handed. */
const ctx = (over = {}) => ({
  settings: { ...store.state.settings, ...over },
  plants: data.plants,
  animals: data.animals,
});

const T0 = Date.UTC(2026, 8, 27, 12, 0, 0);
const HOURS = (n) => T0 + n * 3600e3;
const plot = (over = {}) => ({
  id: 'p1', kind: 'farm', itemId: CARROT,
  plantedMin: Math.floor(T0 / 60000), caredMin: [], checkedMin: 0, ...over,
});

/* ---------------------------------------------------- the published half -- */

test('every crop is 22 hours, and premium does not change that', () => {
  /* Premium doubles a crop's YIELD, not its speed - the store copy says
   * "Double crop yield from farming" and says nothing about growth. Getting
   * this backwards would put every crop reminder 11 hours early. */
  for (const p of data.plants) {
    assert.equal(p.growSeconds, 79200, p.name);
    assert.equal(R.growMinutes(ctx({ premium: false }), p), 22 * 60, p.name);
    assert.equal(R.growMinutes(ctx({ premium: true }), p), 22 * 60, p.name);
  }
});

test('an animal halves with premium, and says where that came from', () => {
  const chicken = data.animals.find((a) => a.id === CHICKEN);
  assert.equal(chicken.growSeconds, 158400, '44 hours');
  assert.equal(R.growMinutes(ctx({ premium: false }), chicken), 44 * 60);
  assert.equal(R.growMinutes(ctx({ premium: true }), chicken), 22 * 60);
  // And the halving is store copy rather than a table row, so it is flagged.
  const st = R.plotStatus(ctx({ premium: true }), plot({ itemId: CHICKEN }), HOURS(1));
  assert.ok(st.assumed.some((a) => /store copy/.test(a)));
  const plain = R.plotStatus(ctx({ premium: false }), plot({ itemId: CHICKEN }), HOURS(1));
  assert.deepEqual(plain.assumed, [], 'nothing assumed without premium');
});

test('one tap plus published data gives an exact due time', () => {
  const st = R.plotStatus(ctx(), plot(), HOURS(1));
  assert.equal(st.state, 'growing');
  assert.equal(st.span, 22 * 60);
  assert.equal(R.minToMs(st.readyMin), T0 + 22 * 3600e3, 'to the minute');
  assert.equal(R.whenWords(st.readyMin, HOURS(1)), 'in 21h');
  assert.equal(R.whenWords(st.readyMin, HOURS(23)), '1h ago');
});

/* ------------------------------------------------- what it refuses to say -- */

test('a plot nobody has told it about says nothing', () => {
  const st = R.plotStatus(ctx(), plot({ itemId: '' }), HOURS(1));
  assert.equal(st.state, 'empty');
  assert.equal(st.readyMin, undefined, 'no due time out of thin air');
});

test('a crop with no planting time gets no due time, and says why', () => {
  /* The honest half of "I do not know when". Counting from now would be the
   * app inventing the one number the whole feature exists to carry. */
  const st = R.plotStatus(ctx(), plot({ plantedMin: 0 }), HOURS(1));
  assert.equal(st.state, 'untimed');
  assert.equal(st.readyMin, undefined);
  assert.match(st.why, /not going to guess/);
});

test('an id the game data no longer has is said out loud, not treated as bare', () => {
  const st = R.plotStatus(ctx(), plot({ itemId: 'T9_FARM_UNOBTAINIUM_SEED' }), HOURS(1));
  assert.equal(st.state, 'unknown');
  assert.match(st.why, /no T9_FARM_UNOBTAINIUM_SEED/);
});

test('one whole growth overdue and it stops asserting', () => {
  /* Before this point, "ready and you have not said otherwise" is a fair
   * reading of silence. After it, silence could equally mean you harvested and
   * replanted two days ago without telling it, and nothing can tell the two
   * apart - so it asks instead of claiming. */
  assert.equal(R.plotStatus(ctx(), plot(), HOURS(23)).state, 'ready');
  assert.equal(R.plotStatus(ctx(), plot(), HOURS(43)).state, 'ready');
  const stale = R.plotStatus(ctx(), plot(), HOURS(45));
  assert.equal(stale.state, 'stale');
  assert.match(stale.why, /no longer know/);
});

test('an overdue task never rolls itself forward', () => {
  // A week later it is still the same planting, still overdue, and the app has
  // not quietly decided a harvest happened.
  const week = R.plotStatus(ctx(), plot(), HOURS(24 * 7));
  assert.equal(week.state, 'stale');
  assert.equal(week.readyMin, Math.floor(T0 / 60000) + 22 * 60, 'the same due time');
  assert.ok(week.overdue > 0);
});

/* ------------------------------------------------------------ nurturing -- */

test('no task is raised for something the game will not let you do', () => {
  /* Watering and nurturing need Premium, and calc.js already gates every focus
   * cost on exactly this pair. Telling a non-premium player to water their
   * carrots would be asking for something the game refuses. */
  assert.equal(R.canNurture(ctx({ premium: false, watered: true })), false);
  assert.equal(R.canNurture(ctx({ premium: true, watered: false })), false);
  assert.equal(R.canNurture(ctx({ premium: true, watered: true })), true);
  const off = R.plotStatus(ctx({ premium: false, watered: true }), plot(), HOURS(1));
  assert.equal(off.nurture, null);
});

test('a mount wants several nurtures, and they are counted not assumed', () => {
  const ox = data.animals.find((a) => a.id === OX);
  const c = ctx({ premium: true, watered: true });
  const plan = R.nurturePlan(c, ox);
  assert.equal(plan.allowed, ox.maxCycles);
  assert.ok(plan.allowed >= 4, 'the whole point of a mount');
  // With premium the 22h gap halves along with the growth.
  assert.equal(plan.every, Math.round(ox.careSeconds / 2 / 60));

  const p = plot({ itemId: OX, kind: 'pasture' });
  /* A WINDOW, opening at the start of its period rather than the end. Putting
   * it at the end made a crop's only watering unreachable, because a crop's
   * single period ends exactly when the crop is ready. */
  const first = R.plotStatus(c, p, HOURS(0.5));
  assert.equal(first.nurture.done, 0);
  assert.equal(first.nurture.ready, true, 'the first window is open from planting');
  assert.equal(first.nurture.opensMin, Math.floor(T0 / 60000));
  assert.equal(first.nurture.closesMin, Math.floor(T0 / 60000) + plan.every);

  // Say you did it, and the next window is the next period - not yet open.
  const p2 = { ...p, caredMin: [Math.floor(T0 / 60000)] };
  const afterDoing = R.plotStatus(c, p2, HOURS(0.6));
  assert.equal(afterDoing.nurture.done, 1);
  assert.equal(afterDoing.nurture.ready, false, 'one per period, and this one is used');
  const nextPeriod = R.plotStatus(c, p2, T0 + (plan.every + 1) * 60000);
  assert.equal(nextPeriod.nurture.ready, true);

  // Every period used, so nothing is open however long you look at it.
  const spent = { ...p, caredMin: Array.from({ length: plan.allowed },
    (_, i) => Math.floor(T0 / 60000) + i * plan.every) };
  const done = R.plotStatus(c, spent, T0 + plan.every * plan.allowed * 60000 + 60000);
  assert.equal(done.nurture.done, plan.allowed);
  assert.equal(done.nurture.ready, false, 'this period is already used');
});

test('a window you missed does not lock out the ones after it', () => {
  /* The bug this exists to catch: counting off RECORDED nurtures to find the
   * open window meant one forgotten feed held period one open forever while
   * the clock walked away from it, and a Master's Ox was never offered the
   * other three. What is open is the period the clock is in. */
  const c = ctx({ premium: true, watered: true });
  const ox = data.animals.find((a) => a.id === OX);
  const every = R.nurturePlan(c, ox).every;
  const p = plot({ itemId: OX, kind: 'pasture', caredMin: [] });

  // Two whole periods went by with nothing recorded.
  const late = R.plotStatus(c, p, T0 + (2 * every + 30) * 60000);
  assert.equal(late.nurture.done, 0, 'you really did miss them');
  assert.equal(late.nurture.period, 2, 'and the open one is the one you are in');
  assert.equal(late.nurture.ready, true, 'still feedable now');
  assert.equal(late.nurture.opensMin, Math.floor(T0 / 60000) + 2 * every);

  // The missed ones are not offered back and are not counted as done either.
  assert.ok(late.nurture.done < late.nurture.allowed);
});

test('nothing is nurturable once it is ready to take', () => {
  const c = ctx({ premium: true, watered: true });
  const st = R.plotStatus(c, plot(), HOURS(23));
  assert.equal(st.state, 'ready');
  assert.equal(st.nurture.ready, false);
  assert.equal(st.nurture.opensMin, null, 'the growth is over, there is no period');
});

/* ------------------------------------------------------------ the rounds -- */

const islands = [{
  id: 'i1', name: 'Home', cityId: 'martlock',
  plots: [
    { id: 'a', kind: 'farm', itemId: CARROT, plantedMin: Math.floor(T0 / 60000), caredMin: [] },
    { id: 'b', kind: 'farm', itemId: CARROT, plantedMin: Math.floor(T0 / 60000) - 60 * 60, caredMin: [] },
    { id: 'c', kind: 'herbgarden', itemId: '', plantedMin: 0, caredMin: [] },
    { id: 'd', kind: 'farm', itemId: CARROT, plantedMin: 0, caredMin: [] },
  ],
}];

test('the list puts what it cannot reason about first', () => {
  const rows = R.rounds(ctx(), islands, HOURS(23));
  // b was planted 60h before T0, so at T0+23h it is 61h past a 22h growth: stale.
  assert.equal(rows[0].task, 'check');
  assert.equal(rows[0].plotId, 'b');
  // then the one that is actually ready
  assert.equal(rows[1].task, 'harvest');
  assert.equal(rows[1].plotId, 'a');
  const sum = R.roundsSummary(rows);
  assert.equal(sum.harvest, 1);
  assert.equal(sum.stale, 1);
  assert.equal(sum.empty, 1);
  assert.equal(sum.untimed, 1);
  assert.equal(sum.due, 4, 'everything here wants a decision');
});

test('nothing is due when nothing is due, and it says what is next', () => {
  const one = [{ id: 'i1', name: 'Home', plots: [islands[0].plots[0]] }];
  const rows = R.rounds(ctx(), one, HOURS(1));
  assert.equal(R.roundsSummary(rows).due, 0);
  const next = R.roundsSummary(rows).next;
  assert.equal(next.plotId, 'a');
  assert.equal(R.whenWords(next.dueMin, HOURS(1)), 'in 21h');
});

test('a plot can want two things at once and gets a row for each', () => {
  const c = ctx({ premium: true, watered: true });
  const ox = data.animals.find((a) => a.id === OX);
  const every = R.nurturePlan(c, ox).every;
  const one = [{
    id: 'i1', name: 'Home',
    plots: [{ id: 'z', kind: 'pasture', itemId: OX, plantedMin: Math.floor(T0 / 60000), caredMin: [] }],
  }];
  const rows = R.rounds(c, one, T0 + 60000);
  assert.equal(rows.length, 2, 'a nurture row and the plot itself');
  assert.equal(rows[0].task, 'nurture');
  assert.equal(rows[1].task, 'wait', 'still growing, just wants feeding');
  // The nurture row carries when the window shuts, not a deadline it is past.
  assert.equal(rows[0].closesMin, Math.floor(T0 / 60000) + every);
  assert.ok(rows[0].lateMin > 0, 'time left, rather than time overdue');
  void every;
});

/* --------------------------------------------------------------- saving -- */

test('an island survives a save, and a save without one is not broken by it', () => {
  store.wipe();
  const home = store.addIsland('Home', 'martlock');
  const p = store.addIslandPlot(home.id, 'herbgarden', 'Top left');
  store.setPlotCrop(home.id, p.id, CARROT, T0);
  const backup = store.exportJSON();
  store.wipe();
  assert.equal(store.state.islands.length, 0, 'really wiped');
  store.importJSON(backup);
  assert.equal(store.state.islands.length, 1);
  assert.equal(store.state.islands[0].name, 'Home');
  assert.equal(store.state.islands[0].plots[0].itemId, CARROT);
  assert.equal(store.state.islands[0].plots[0].plantedMin, Math.floor(T0 / 60000));

  /* And the thing that would have been a silent disaster: a save written
   * before islands existed must open unchanged. The land kinds in particular -
   * raising LAND_SCHEMA to carry islands would have sent every existing save
   * back through the legacy rewrite and turned every Farm into a 'plant'. */
  store.importJSON(JSON.stringify({
    schema: 2,
    farm: [{ id: 'f1', cityId: 'martlock', kind: 'farm', count: 3 },
      { id: 'f2', cityId: 'martlock', kind: 'pasture', count: 1 }],
    settings: { premium: true },
  }));
  assert.deepEqual(store.state.islands, []);
  assert.equal(store.state.farm[0].kind, 'farm', 'not "plant"');
  assert.equal(store.state.farm[1].kind, 'pasture', 'not "animal"');
});

test('a hand-edited backup cannot smuggle a moment into the engine', () => {
  store.importJSON(JSON.stringify({
    schema: 2,
    islands: [{
      id: 'i1', name: 'x'.repeat(200), cityId: 'martlock',
      plots: [
        { id: 'p1', kind: 'volcano', itemId: CARROT, plantedMin: -5 },
        { id: 'p2', kind: 'farm', itemId: 42, plantedMin: 'yesterday' },
        { id: 'p3', kind: 'farm', itemId: CARROT, plantedMin: 29000000, caredMin: ['x', 7, -1] },
      ],
    }],
  }));
  const [h] = store.state.islands;
  assert.equal(h.name.length, 40, 'a name is a name, not a payload');
  assert.equal(h.plots[0].kind, 'farm', 'a plot kind the game does not have is not a plot kind');
  assert.equal(h.plots[0].plantedMin, 0, 'a negative moment is no moment');
  assert.equal(h.plots[1].itemId, '', 'an itemId that is not a string is nothing');
  assert.equal(h.plots[1].plantedMin, 0);
  assert.equal(h.plots[2].plantedMin, 29000000, 'and a real one survives');
  assert.deepEqual(h.plots[2].caredMin, [7]);
});

/* -------------------------------------------------------------- setters -- */

test('harvest and replant stamps the tap, never the moment it became ready', () => {
  /* Backdating to "you must have replanted the instant it was done" widens the
   * error by the length of every real gap, every cycle, until the due times
   * are fiction. */
  store.wipe();
  const home = store.addIsland('Home');
  const p = store.addIslandPlot(home.id, 'farm');
  store.setPlotCrop(home.id, p.id, CARROT, T0);
  const late = T0 + 30 * 3600e3;            // you came back 8 hours late
  store.harvestPlot(home.id, p.id, { replant: true, at: late });
  const row = store.state.islands[0].plots[0];
  assert.equal(row.itemId, CARROT, 'the same thing went back in');
  assert.equal(row.plantedMin, Math.floor(late / 60000), 'stamped at the tap');
  assert.notEqual(row.plantedMin, Math.floor((T0 + 22 * 3600e3) / 60000));
  // Harvesting and leaving it bare is the other button, and it empties the plot.
  store.harvestPlot(home.id, p.id, { replant: false, at: late });
  assert.equal(store.state.islands[0].plots[0].itemId, '');
  assert.equal(store.state.islands[0].plots[0].plantedMin, 0);
});

test('the panel countdown recovers a moment nobody recorded', () => {
  store.wipe();
  const home = store.addIsland('Home');
  const p = store.addIslandPlot(home.id, 'farm');
  // You never tapped planted, but the game says 3h left of a 22h crop.
  store.setPlotCrop(home.id, p.id, CARROT, 0);
  assert.equal(store.state.islands[0].plots[0].plantedMin, 0, 'no guess yet');
  store.setPlotRemaining(home.id, p.id, 3 * 60, 22 * 60, T0);
  const row = store.state.islands[0].plots[0];
  assert.equal(row.plantedMin, Math.floor(T0 / 60000) - 19 * 60, 'it went in 19h ago');
  const st = R.plotStatus(ctx(), { ...row, id: p.id }, T0);
  assert.equal(R.whenWords(st.readyMin, T0), 'in 3h', 'which is what the panel said');
});

test('checking on a plot is an observation, not an action', () => {
  store.wipe();
  const home = store.addIsland('Home');
  const p = store.addIslandPlot(home.id, 'farm');
  store.setPlotCrop(home.id, p.id, CARROT, T0);
  store.checkedPlot(home.id, p.id, T0 + 3600e3);
  const row = store.state.islands[0].plots[0];
  assert.equal(row.itemId, CARROT, 'still the same crop');
  assert.equal(row.plantedMin, Math.floor(T0 / 60000), 'and the same planting');
  assert.ok(row.checkedMin > 0, 'only that you looked');
});

test('a nurture is only offered while the thing is still growing', () => {
  /* A crop's single nurture window IS its whole 22 hours, so the arithmetic
   * alone says "due" the moment the crop finishes. Offering to water a crop
   * that is already standing there ready is offering something the game has no
   * use for, and it showed up on every ready row before this. */
  const c = ctx({ premium: true, watered: true });
  const growing = R.plotStatus(c, plot(), HOURS(21));
  assert.equal(growing.nurture.ready, true, 'open, and still worth doing');
  assert.equal(growing.nurture.opensMin, Math.floor(T0 / 60000),
    'a crop can be watered any time it is growing, which is all the files say');
  const ready = R.plotStatus(c, plot(), HOURS(23));
  assert.equal(ready.state, 'ready');
  assert.equal(ready.nurture.ready, false, 'the window has closed');
  // And it never reappears later.
  assert.equal(R.plotStatus(c, plot(), HOURS(40)).nurture.ready, false);
});

test('an untimed plot still knows how long its crop takes', () => {
  /* The "panel says N left" box turns a countdown back into a planting moment,
   * and it needs the span to do it. The plot with no time is exactly where
   * that box matters most, and it was the one place the span was missing. */
  const st = R.plotStatus(ctx(), plot({ plantedMin: 0 }), HOURS(1));
  assert.equal(st.state, 'untimed');
  assert.equal(st.span, 22 * 60, 'known, even though the due time is not');
  assert.equal(st.readyMin, undefined, 'and still no due time invented');
  // An animal's span on an untimed plot follows the same premium reading.
  const chick = R.plotStatus(ctx({ premium: true }), plot({ itemId: CHICKEN, plantedMin: 0 }), HOURS(1));
  assert.equal(chick.span, 22 * 60);
});
