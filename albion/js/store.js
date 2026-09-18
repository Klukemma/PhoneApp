// Local-only state: your prices, your plan, your settings.
// Game data (gamedata.json) is read-only and never stored here.

import { uid } from './util.js';

const KEY = 'albionfarm.v1';

export let DATA = null;          // gamedata.json, loaded once at boot

export async function loadGameData() {
  const res = await fetch('data/gamedata.json');
  if (!res.ok) throw new Error(`Could not load game data (${res.status})`);
  DATA = await res.json();
  return DATA;
}

function defaults() {
  return {
    schema: 1,
    settings: {
      premium: true,
      watered: false,          // water plots with focus
      favouriteFood: true,     // feed animals their favourite plant
      useFocus: true,          // craft with focus
      craftCity: 'brecilien',  // where you craft by default; a job can override
      farmCity: 'martlock',    // where your farm or island is; a plot can override
      specLevel: 0,            // default mastery, when a recipe has none of its own
      cadenceHours: 24,        // how often you actually log in to harvest
      // One batch cycle: farm for a while, let focus build to the cap, then
      // craft it all in one go.
      cycleDays: 14,
      farmDays: 10,
      farmEvery: 1,            // 1 = every day, 2 = every other day, and so on
      startFocus: 0,           // focus in hand when a cycle begins
      hideMounts: false,
      sellSurplus: false,      // true = sell leftover ingredients instead of keeping them
      stockCap: 5000,          // spare units you are willing to sit on before pausing
      stationFeePerCraft: 0,
      feedItemId: 'T3_WHEAT',
      server: 'americas',      // Albion Americas, Asia or Europe
      priceCity: 'Caerleon',
      // These come from gamedata.json constants at first run; kept here so
      // they stay editable when a patch changes them.
      ...{},
    },
    prices: {},                // what a thing sells for
    buyPrices: {},             // what it costs you, when that differs
    spec: {},                  // recipe id -> a flat efficiency override
    nodeLevels: {},            // destiny board node id -> level
    // What you are trying to make, and how much land you have to do it with.
    // The solver works from these two and writes the plan below.
    // cycleDays 0 means "you decide" — any other number pins the cycle to the
    // rhythm you actually play to, and the solver works inside it.
    goal: { recipeId: '', plots: 9, cycleDays: 0 },
    // The land you actually own: so many plots of one sort in one city.
    // Empty means you have not said, and the plan treats your plot count as
    // one undifferentiated heap in your default farming city.
    farm: [],
    plan: { plots: [], crafts: [] },
  };
}

/** Copy the game constants into settings the first time, then leave them alone. */
function withConstants(state, data) {
  for (const [k, v] of Object.entries(data.constants)) {
    if (state.settings[k] === undefined) state.settings[k] = v;
  }
  // calc reads these through settings, so keep them joined.
  state.settings.spec = state.spec;
  state.settings.nodeLevels = state.nodeLevels;
  state.settings.focusNodes = data.focusNodes;
  // Cities live outside constants and are always taken fresh from the game
  // data, never from a saved copy.
  state.settings.cities = data.cities;
  // Seeds have a fixed NPC price — a sane starting value for every seed.
  for (const p of data.plants) {
    if (state.prices[p.seedId] === undefined) state.prices[p.seedId] = p.seedNpc;
  }
  for (const a of data.animals) {
    if (state.prices[a.babyId] === undefined) state.prices[a.babyId] = a.babyNpc;
  }
  return state;
}

function normalize(raw) {
  const base = defaults();
  const s = {
    ...base, ...raw,
    settings: { ...base.settings, ...(raw.settings || {}) },
    prices: { ...(raw.prices || {}) },
    buyPrices: { ...(raw.buyPrices || {}) },
    spec: { ...(raw.spec || {}) },
    nodeLevels: { ...(raw.nodeLevels || {}) },
    goal: { ...base.goal, ...(raw.goal || {}) },
    farm: (Array.isArray(raw.farm) ? raw.farm : [])
      .map((h) => ({
        id: h.id || uid(),
        cityId: h.cityId || 'island',
        kind: h.kind === 'pasture' ? 'pasture' : 'farm',
        count: Math.max(0, Math.round(Number(h.count)) || 0),
      }))
      .filter((h) => h.count > 0),
    plan: {
      plots: Array.isArray(raw.plan?.plots) ? raw.plan.plots : [],
      crafts: (Array.isArray(raw.plan?.crafts) ? raw.plan.crafts : []).map((c) => {
        // Craft jobs used to be "so many per day" before the cycle existed.
        // Carry that number over rather than silently resetting it to zero.
        if (c.perCycle === undefined && c.craftsPerDay !== undefined) {
          return { ...c, mode: c.mode || 'fixed', perCycle: c.craftsPerDay };
        }
        return c;
      }),
    },
  };
  for (const map of [s.prices, s.buyPrices]) {
    for (const [k, v] of Object.entries(map)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) delete map[k];
    }
  }
  for (const map of [s.spec, s.nodeLevels]) {
    for (const [k, v] of Object.entries(map)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) delete map[k];
    }
  }
  // Older saves carried one global "am I in a bonus city" flag, which applied
  // the specialty to every recipe. The city now decides, per item.
  delete s.settings.citySpecialty;
  // The cities table is regenerated from the game files, so never keep a
  // stale copy from an old save or an old backup.
  delete s.settings.cities;
  // Server ids used to be the data project's hostnames.
  const RENAMED = { west: 'americas', east: 'asia' };
  if (RENAMED[s.settings.server]) s.settings.server = RENAMED[s.settings.server];
  return s;
}

export const state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch (err) {
    console.warn('Saved data unreadable, starting fresh.', err);
  }
  return defaults();
}

export function hydrate(data) {
  withConstants(state, data);
  commit();
}

const listeners = new Set();
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

let timer = null;

export function commit() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (err) {
      console.error('Save failed', err);
    }
  }, 120);
  for (const fn of listeners) fn(state);
}

/* ------------------------------------------------------------ prices --- */

export const priceOf = (id) => Number(state.prices[id]) || 0;

/**
 * What one costs you.
 *
 * Buying and selling are not the same price: you take the cheapest offer on
 * the shelf and you sell into whatever is left after fees, and in another city
 * both numbers move. Where no separate buy price is kept the two collapse into
 * one, which is what most items want and what every old save has.
 */
export const costOf = (id) => Number(state.buyPrices[id]) || priceOf(id);

/** True when this item is being costed differently from how it is sold. */
export const hasOwnCost = (id) => Number(state.buyPrices[id]) > 0;

export function setBuyPrice(id, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) delete state.buyPrices[id];
  else state.buyPrices[id] = Math.round(n);
  commit();
}

export function setPrice(id, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) delete state.prices[id];
  else state.prices[id] = Math.round(n);
  commit();
}

export function setPrices(map) {
  for (const [id, v] of Object.entries(map)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) state.prices[id] = Math.round(n);
  }
  commit();
}

/** Every item id the calculator might want a price for. */
export function pricedItemIds(data = DATA) {
  const ids = new Set();
  for (const p of data.plants) { ids.add(p.seedId); ids.add(p.cropId); }
  for (const a of data.animals) {
    ids.add(a.babyId); ids.add(a.grownId);
    if (a.product) ids.add(a.product.itemId);
  }
  for (const r of data.recipes) {
    ids.add(r.id);
    for (const i of r.inputs) ids.add(i.id);
  }
  return [...ids];
}

/* -------------------------------------------------------------- plan --- */

export function addPlot(itemId, count = 9, mode = 'grow') {
  state.plan.plots.push({ id: uid(), itemId, count, mode, cityId: state.settings.farmCity });
  commit();
}

export function updatePlot(id, patch) {
  const row = state.plan.plots.find((p) => p.id === id);
  if (row) Object.assign(row, patch);
  commit();
}

export function removePlot(id) {
  const i = state.plan.plots.findIndex((p) => p.id === id);
  if (i < 0) return null;
  const [gone] = state.plan.plots.splice(i, 1);
  commit();
  return gone;
}

export function addCraft(recipeId, over = {}) {
  const job = {
    id: uid(), recipeId,
    mode: 'auto',              // craft as much as materials and focus allow
    perCycle: 0,               // used when mode is 'fixed'
    cityId: state.settings.craftCity,
    ...over,
  };
  state.plan.crafts.push(job);
  commit();
  return job;
}

export function updateCraft(id, patch) {
  const row = state.plan.crafts.find((c) => c.id === id);
  if (row) Object.assign(row, patch);
  commit();
}

export function removeCraft(id) {
  const i = state.plan.crafts.findIndex((c) => c.id === id);
  if (i < 0) return null;
  const [gone] = state.plan.crafts.splice(i, 1);
  commit();
  return gone;
}

/* -------------------------------------------------------------- land --- */

/** Total plots you own, or the number you typed if you never said. */
export const plotsOwned = () => (state.farm.length
  ? state.farm.reduce((t, h) => t + h.count, 0)
  : (Number(state.goal.plots) || 0));

/** Farms and pastures, counted separately. */
export function landSummary() {
  const out = { farm: 0, pasture: 0, cities: new Set() };
  for (const h of state.farm) {
    out[h.kind] += h.count;
    out.cities.add(h.cityId);
  }
  return out;
}

export function setHolding(cityId, kind, count) {
  const n = Math.max(0, Math.round(Number(count)) || 0);
  const at = state.farm.find((h) => h.cityId === cityId && h.kind === kind);
  if (at) {
    if (n > 0) at.count = n;
    else state.farm.splice(state.farm.indexOf(at), 1);
  } else if (n > 0) {
    state.farm.push({ id: uid(), cityId, kind, count: n });
  }
  // The typed plot count and the described land are one number, so keep them
  // agreeing rather than leaving two answers to "how much land have I got".
  if (state.farm.length) state.goal.plots = plotsOwned();
  delete state.goal.stamp;
  commit();
}

export function clearLand() {
  state.farm = [];
  delete state.goal.stamp;
  commit();
}

/* -------------------------------------------------------------- goal --- */

export function setGoal(patch) {
  Object.assign(state.goal, patch);
  const whole = (v, max) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(max, n) : 0;
  };
  // Asking a different question invalidates the answer outright, so the
  // fingerprint goes with it rather than being compared against.
  if (patch.recipeId !== undefined || patch.plots !== undefined
    || patch.cycleDays !== undefined) delete state.goal.stamp;
  state.goal.plots = whole(state.goal.plots, 999);
  state.goal.cycleDays = whole(state.goal.cycleDays, 60);
  commit();
}

/**
 * Take the plan the solver worked out. It replaces what was there rather than
 * merging: a recommendation is a whole answer, and half of one is not an
 * answer at all.
 */
export function applySolution(result, stamp = null) {
  if (!result?.ok) return;
  // Kept with the goal rather than with the solution, so the app still knows
  // the plan is stale after you close it and come back tomorrow.
  if (stamp) state.goal.stamp = stamp;
  state.plan = {
    plots: result.plan.plots.map((p) => ({ ...p, id: uid() })),
    crafts: result.plan.crafts.map((c) => ({ ...c, id: uid() })),
  };
  Object.assign(state.settings, result.settingsPatch);
  commit();
}

/** Plant the land the chain did not need with what the solver suggested. */
export function addSpare(spare) {
  if (!spare) return;
  state.plan.plots.push({
    id: uid(), itemId: spare.itemId, mode: spare.mode,
    count: spare.plots, cityId: state.settings.farmCity, filler: true,
  });
  commit();
}

export function setSettings(patch) {
  Object.assign(state.settings, patch);
  commit();
}

/** A flat efficiency override for one recipe, instead of the board. */
export function setSpec(recipeId, level) {
  const n = Number(level);
  if (!Number.isFinite(n) || n <= 0) delete state.spec[recipeId];
  else state.spec[recipeId] = Math.round(n);
  state.settings.spec = state.spec;
  commit();
}

/** Your level on one destiny board node. */
export function setNodeLevel(nodeId, level) {
  const n = Number(level);
  if (!Number.isFinite(n) || n <= 0) delete state.nodeLevels[nodeId];
  else state.nodeLevels[nodeId] = Math.min(100, Math.round(n));
  state.settings.nodeLevels = state.nodeLevels;
  commit();
}

/* ------------------------------------------------------------ backup --- */

export const exportJSON = () => JSON.stringify(state, null, 2);

export function importJSON(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') throw new Error('Not a backup file');
  const next = normalize(parsed);
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, next);
  if (DATA) withConstants(state, DATA);
  commit();
}

export function wipe() {
  const next = defaults();
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, next);
  if (DATA) withConstants(state, DATA);
  commit();
}
