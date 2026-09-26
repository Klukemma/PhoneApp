// Local-only state: your prices, your plan, your settings.
// Game data (gamedata.json) is read-only and never stored here.

import { DAY_MODES, scheduleOf } from './calc.js';
import { uid } from './util.js';

const KEY = 'albionfarm.v1';

export let DATA = null;          // gamedata.json, loaded once at boot
export let GEAR = null;          // equipment.json, only once you ask for it

// Fixed merchant asks for seeds and babies, filled in from the game data.
let NPC_PRICE = {};

export async function loadGameData() {
  const res = await fetch('data/gamedata.json');
  if (!res.ok) throw new Error(`Could not load game data (${res.status})`);
  DATA = await res.json();
  return DATA;
}

/**
 * The weapon and armour half of the game, fetched the first time you ask.
 *
 * It is two megabytes against the farming file's three hundred kilobytes,
 * because there are 6,671 equipment recipes and 403 farming ones. Nobody
 * planning a potion run should pay for that, so it is not loaded at boot and
 * the Craft tab waits on this instead.
 *
 * The rows arrive stripped of everything that can be worked out again \u2014 no
 * name, no tier, no group, and no field that equals its own default \u2014 so
 * they are put back together here, once, rather than at every read site.
 */
let gearLoading = null;
export function loadEquipment() {
  if (GEAR) return Promise.resolve(GEAR);
  if (gearLoading) return gearLoading;
  gearLoading = (async () => {
    const res = await fetch('data/equipment.json');
    if (!res.ok) throw new Error(`Could not load the equipment data (${res.status})`);
    const raw = await res.json();
    const nameOf = (id) => raw.items[id]?.name || id;
    GEAR = {
      ...raw,
      recipes: raw.recipes.map((r) => ({
        enchant: 0, amount: 1, silver: 0, refine: false, ...r,
        name: nameOf(r.id),
        tier: raw.items[r.id]?.tier ?? 0,
        // A transmutation names its own list: it is neither refining nor
        // crafting, and filing it under the planks would bury it.
        group: r.group || raw.groups[r.category] || 'gear',
      })),
    };
    /* The destiny board is one board. Once the weapon and armour half is
     * here, every focus cost in the app is worked out from all 371 nodes
     * rather than from the 54 a farmer sees, so a sword quoted before and
     * after the Craft tab was opened cannot disagree. */
    if (state.settings.focusNodes !== ALL_NODES) {
      ALL_NODES = [...(DATA?.focusNodes || []), ...GEAR.focusNodes];
      state.settings.focusNodes = ALL_NODES;
    }
    ALL_ITEMS = { ...(DATA?.items || {}), ...GEAR.items };
    state.settings.items = ALL_ITEMS;
    return GEAR;
  })();
  return gearLoading;
}

let ALL_NODES = null;
let ALL_ITEMS = null;

/** Look an item up in whichever file happens to know it. */
export const itemMeta = (id) => DATA?.items[id] || GEAR?.items[id] || null;

function defaults() {
  return {
    schema: LAND_SCHEMA,
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
      // The cycle, day by day: 'farm', 'rest' or 'craft'. Empty means "read
      // the three numbers above", which is how every plan used to say it.
      schedule: [],
      startFocus: 0,           // focus in hand when a cycle begins
      hideMounts: false,
      sellSurplus: false,      // true = sell leftover ingredients instead of keeping them
      stockCap: 5000,          // spare units you are willing to sit on before pausing
      // What each city's station owner charges, per 100 nutrition consumed.
      // Your own island charges nothing. Posted on the station in game.
      stationFee: {},
      /* Hauling. Weight is the game's number; what you can carry and what a
       * trip is worth to you are not published anywhere, so they start at
       * zero and the app reports the load without inventing a price for it. */
      carryWeight: 0,
      haulSilverPerWeight: 0,
      // Do every step in one city, or each in the city that is best for it.
      craftWhere: 'one',
      /* Your gathering kit: what you have on, where you swing it, and what
       * you have actually measured. Nothing is switched on to begin with,
       * because a bonus you do not have is not a rounding error - a full set
       * and a pie is most of a second run's worth of resources, and assuming
       * it would quietly double every answer on the screen.
       *
       * `measured` is the one thing here the game files cannot supply: how
       * many a real hour gives you, keyed by what you farmed and where. Until
       * you fill one in, the app reports the swing floor and says the hours
       * are unknown rather than inventing a node density. */
      gather: {
        kind: 'static',          // which sort of node, from gathering.kindLabels
        zone: 'royal',           // cluster quality, which sets the grade odds
        danger: 'black',         // zone colour, which only changes fame
        toolTier: 0,             // 0 = none set, and then nothing is assumed
        toolAvalon: false,
        gear: { head: 0, armor: 0, shoes: 0, backpack: false },
        food: '',
        foodEnchant: 0,
        potion: '',
        potionEnchant: 0,
        // The two things no game file settles, kept where you can change them.
        premiumMode: 'add',
        gearCoversEnchanted: true,
        // "WOOD:5:static:royal" -> { per10min }
        measured: {},
      },
      // What goes in the trough, per food category. The game will not let a
      // direwolf eat wheat, so one field could never cover all three.
      feedItemIds: { plants: 'T3_WHEAT', meat: 'T3_MEAT', mount: 'T8_FARM_OX_GROWN' },
      server: 'americas',      // Albion Americas, Asia or Europe
      priceCity: 'Caerleon',
      // How old a quote has to be before the app says so. Your call: Albion
      // publishes nothing about when a market price goes off, so this is a
      // judgement and the app labels it rather than adjusting any number by it.
      priceMaxAgeHours: 24,
      // These come from gamedata.json constants at first run; kept here so
      // they stay editable when a patch changes them.
      ...{},
    },
    prices: {},                // what a thing sells for
    buyPrices: {},             // what it costs you, when that differs
    // What the Black Market will hand you for a piece of equipment right
    // now. Its own map because it is a different question from the shelf
    // price and answered by a different side of the order book.
    bmPrices: {},
    /* Prices for the four quality levels above plain, on the market and at
     * the Black Market. Plain stays in `prices` and `bmPrices`, where every
     * old save already has it and where everything that is not equipment
     * only ever has one price anyway. */
    qPrices: {},
    qBmPrices: {},
    /* When each price was last a real observation, in whole minutes since the
     * epoch. Two maps, not five: the five price maps are written in two
     * moments, because a market fetch writes `prices` and `qPrices` together
     * and a Black Market fetch writes the other two together. What you pay is
     * your own number and carries the market side's stamp when you type it.
     *
     * Minutes rather than milliseconds because this rides in localStorage
     * beside a few hundred prices and nobody needs a quote timed to the
     * second. */
    priceSeen: {},
    bmSeen: {},
    spec: {},                  // recipe id -> a flat efficiency override
    nodeLevels: {},            // destiny board node id -> level
    // What you are trying to make, and how much land you have to do it with.
    // The solver works from these two and writes the plan below.
    // cycleDays 0 means "you decide" — any other number pins the cycle to the
    // rhythm you actually play to, and the solver works inside it.
    // keepDays: plan around the days you set, rather than choosing them.
    goal: { recipeId: '', plots: 0, cycleDays: 0, keepDays: false },
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
  state.settings.focusNodes = ALL_NODES || data.focusNodes;
  // Cities live outside constants and are always taken fresh from the game
  // data, never from a saved copy.
  state.settings.cities = data.cities;
  // And so does the feed table: which items each category accepts, and the
  // nutrition each carries.
  state.settings.feeds = data.feeds;
  // And the gathering tables: what a node gives, how long a swing takes, and
  // what every bonus in the game is worth. Game data, so always fresh.
  state.settings.gathering = data.gathering;
  // The quality table is game data too, never a saved copy.
  if (data.quality) state.settings.quality = data.quality;
  // And so is what things weigh, which is what decides whether a farm bonus
  // in another city is worth the ride.
  state.settings.items = ALL_ITEMS || data.items;
  /* The NPC sells seeds and babies at a fixed price. That is a ceiling on what
   * one can ever cost you — you can always walk to the merchant — and it is
   * not a saved price of yours, so it lives apart from both price maps.
   *
   * It is emphatically not what a seed is WORTH: the merchant does not buy
   * them back and the dumps publish no bid at all. Using it as the sell price
   * credited every surplus seed at the shop's asking rate, which on T6
   * foxglove was 2,001 silver a tile — 42% of the profit the app reported,
   * invented out of nothing. A surplus is worth zero until you price it. */
  NPC_PRICE = {};
  for (const p of data.plants) NPC_PRICE[p.seedId] = p.seedNpc;
  for (const a of data.animals) NPC_PRICE[a.babyId] = a.babyNpc;
  return state;
}

/**
 * The four buildings the game actually has, and the two vaguer sorts a farm
 * could have been described with before the app knew the difference.
 *
 * A save written then said "farm" meaning crops and herbs together, which was
 * true of the old model and is not true of the game. Rather than silently
 * reinterpreting it as crops only \u2014 which would stop a herb plan dead \u2014 it
 * becomes "plant", a plot that takes either, and the land screen asks you to
 * split it properly.
 */
const LAND_KINDS = new Set(['farm', 'herbgarden', 'pasture', 'kennel', 'plant', 'animal']);

/**
 * Schema 2 is where the four buildings were told apart. Before it, "farm" was
 * a save's way of saying "somewhere plants grow", which covered herbs too, and
 * the word is the same either side \u2014 so the version is the only way to know
 * which was meant. Read it wrong and ten herb gardens quietly become ten crop
 * farms with nowhere to put the foxglove.
 */
const LAND_SCHEMA = 2;
const LEGACY_KIND = { farm: 'plant', pasture: 'animal' };

/**
 * A gathering kit, merged a level down and clamped.
 *
 * Merged because a save written before the gear slots existed must not lose
 * the tool tier it did have. Clamped because this reaches the yield engine
 * directly, and a hand-edited backup with a tier of 99 in it would read as a
 * real bonus rather than as nonsense.
 */
function normalizeKit(rawKit = {}) {
  const base = defaults().settings.gather;
  const kit = {
    ...base,
    ...rawKit,
    gear: { ...base.gear, ...(rawKit.gear || {}) },
    measured: {},
  };
  /* Tier 0 means "nothing set". Tools run T1 to T8; gatherer gear starts at
   * T4, and a T3 cap in a save is a piece the game does not sell - it would
   * sit on the screen looking like a bonus and be worth nothing. */
  const tier = (v, lo) => {
    const n = Math.round(Number(v) || 0);
    return n >= lo && n <= 8 ? n : 0;
  };
  kit.toolTier = tier(kit.toolTier, 1);
  for (const slot of ['head', 'armor', 'shoes']) kit.gear[slot] = tier(kit.gear[slot], 4);
  // And an Avalonian tool is a T4-and-up thing, so the flag goes with it.
  if (kit.toolTier < 4) kit.toolAvalon = false;
  kit.gear.backpack = !!kit.gear.backpack;
  kit.toolAvalon = !!kit.toolAvalon;
  kit.gearCoversEnchanted = !!kit.gearCoversEnchanted;
  kit.premiumMode = kit.premiumMode === 'multiply' ? 'multiply' : 'add';
  const grade = (v) => Math.min(3, Math.max(0, Math.round(Number(v) || 0)));
  kit.foodEnchant = grade(kit.foodEnchant);
  kit.potionEnchant = grade(kit.potionEnchant);
  for (const [k, v] of Object.entries(rawKit.measured || {})) {
    const per10 = Number(v?.per10min);
    if (Number.isFinite(per10) && per10 > 0) kit.measured[k] = { per10min: Math.round(per10) };
  }
  return kit;
}

function normalize(raw) {
  const base = defaults();
  const s = {
    ...base, ...raw,
    settings: {
      ...base.settings,
      ...(raw.settings || {}),
      schedule: (Array.isArray(raw.settings?.schedule) ? raw.settings.schedule : [])
        .filter((d) => ['farm', 'rest', 'craft'].includes(d)).slice(0, 60),
    },
    prices: { ...(raw.prices || {}) },
    buyPrices: { ...(raw.buyPrices || {}) },
    bmPrices: { ...(raw.bmPrices || {}) },
    qPrices: { ...(raw.qPrices || {}) },
    qBmPrices: { ...(raw.qBmPrices || {}) },
    /* A save written before the app recorded these has no dates at all, and
     * that is the honest state: those prices ARE of unknown age, and the
     * screen says so rather than back-dating them to the moment you
     * upgraded. */
    priceSeen: { ...(raw.priceSeen || {}) },
    bmSeen: { ...(raw.bmSeen || {}) },
    spec: { ...(raw.spec || {}) },
    nodeLevels: { ...(raw.nodeLevels || {}) },
    goal: { ...base.goal, ...(raw.goal || {}) },
    // What you hold going into the cycle: { itemId: { qty, cost } }. cost is
    // silver already sunk into it - zero when you typed it in, what it left
    // the last cycle carrying when the app carried it in.
    stock: Object.fromEntries(Object.entries(raw.stock || {})
      .map(([id, v]) => [id, typeof v === 'number'
        ? { qty: v, cost: 0 }
        : { qty: Number(v?.qty) || 0, cost: Math.max(0, Number(v?.cost) || 0) }])
      .filter(([, v]) => v.qty > 0)),
    farm: (Array.isArray(raw.farm) ? raw.farm : [])
      .map((h) => ({
        id: h.id || uid(),
        // "island" was a crafting location that leaked into the farm list.
        // Farming always happens in some city's territory, so land recorded
        // there belongs to whichever city you farm in.
        cityId: (!h.cityId || h.cityId === 'island')
          ? (raw.settings?.farmCity || 'martlock') : h.cityId,
        kind: (Number(raw.schema) || 1) < LAND_SCHEMA
          ? (LEGACY_KIND[h.kind] || h.kind)
          : (LAND_KINDS.has(h.kind) ? h.kind : 'farm'),
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
  for (const map of [s.qPrices, s.qBmPrices]) {
    for (const [id, at] of Object.entries(map)) {
      for (const [q, v] of Object.entries(at)) {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) delete at[q];
      }
      if (!Object.keys(at).length) delete map[id];
    }
  }
  for (const map of [s.priceSeen, s.bmSeen]) {
    for (const [k, v] of Object.entries(map)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) delete map[k];
    }
  }
  for (const map of [s.prices, s.buyPrices, s.bmPrices]) {
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
  s.settings.gather = normalizeKit(raw.settings?.gather);
  // The gathering tables are regenerated from the game files every boot, so a
  // stale copy out of a backup must never be the one the engine reads.
  delete s.settings.gathering;

  // One trough setting became three, one per food category. Whatever was in
  // the old single field was a plant, so that is where it goes.
  s.settings.feedItemIds = {
    ...base.settings.feedItemIds,
    ...(raw.settings?.feedItemIds || {}),
    ...(raw.settings?.feedItemId && !raw.settings?.feedItemIds
      ? { plants: raw.settings.feedItemId } : {}),
  };
  delete s.settings.feedItemId;
  s.schema = LAND_SCHEMA;
  // "island" was offered as a place to farm, which it never was: every island
  // is bound to a city and farms with that city's bonus. Anyone who picked it
  // is moved to the default rather than being silently dropped somewhere else.
  if (s.settings.farmCity === 'island') s.settings.farmCity = base.settings.farmCity;
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
/** What the merchant charges, where there is a merchant. Never a sale price. */
export const npcPriceOf = (id) => Number(NPC_PRICE[id]) || 0;

export function costOf(id) {
  const own = Number(state.buyPrices[id]) || 0;
  const market = own || priceOf(id);
  const npc = npcPriceOf(id);
  // Never pay more than the merchant asks, and where there is no market price
  // at all the merchant's ask is the only number there is.
  if (!market) return npc;
  return npc ? Math.min(market, npc) : market;
}

/** True when this item is being costed differently from how it is sold. */
export const hasOwnCost = (id) => Number(state.buyPrices[id]) > 0;

/** What the Black Market is offering for one, right now. */
export const bmPriceOf = (id) => Number(state.bmPrices[id]) || 0;

const nowMinutes = () => Math.round(Date.now() / 60000);

/**
 * Stamp when a price was last a real observation.
 *
 * Only when the number actually MOVED, or when a fetch brings a date newer
 * than the one on file. The price sheet's save runs on every open, on Enter in
 * three boxes and before every fetch, so stamping unconditionally would mark
 * every price you merely glanced at as fresh - the exact failure this exists
 * to prevent, wearing the costume of a fix for it.
 *
 * `seen` is the market's own observation date where a fetch supplies one. A
 * quote the data project saw three weeks ago is three weeks old however long
 * ago you pressed the button.
 */
function stamp(map, id, changed, seen) {
  const at = Number.isFinite(seen) ? Math.round(seen / 60000) : nowMinutes();
  if (changed || !(map[id] > 0) || at > map[id]) map[id] = at;
}

/** When this price was last a real observation, in ms, or 0 if never recorded. */
export const priceSeenAt = (id, black = false) => {
  const at = (black ? state.bmSeen : state.priceSeen)[id];
  return at > 0 ? at * 60000 : 0;
};

export function setBmPrice(id, value, seen) {
  const n = Number(value);
  const was = state.bmPrices[id];
  if (!Number.isFinite(n) || n <= 0) {
    delete state.bmPrices[id];
    delete state.bmSeen[id];
  } else {
    state.bmPrices[id] = Math.round(n);
    stamp(state.bmSeen, id, was !== state.bmPrices[id], seen);
  }
  commit();
}

export function setBmPrices(map, seenAt = {}) {
  for (const [id, v] of Object.entries(map)) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    const was = state.bmPrices[id];
    state.bmPrices[id] = Math.round(n);
    stamp(state.bmSeen, id, was !== state.bmPrices[id], seenAt[id]);
  }
  commit();
}

/* --------------------------------------------------- prices by quality -- */

/**
 * What one fetches at a given quality, on the market or at the Black Market.
 *
 * Plain is the price you already had; the four above it live in their own map
 * so that every save written before quality existed still reads correctly.
 * A level nobody has a price for returns 0, which callers must treat as
 * unknown rather than as free.
 */
export const qPriceOf = (id, quality = 1) => (quality <= 1
  ? priceOf(id)
  : Number(state.qPrices[id]?.[quality]) || 0);

export const qBmPriceOf = (id, quality = 1) => (quality <= 1
  ? bmPriceOf(id)
  : Number(state.qBmPrices[id]?.[quality]) || 0);

/** True when anything above plain has a price, so the screen can say so. */
export const hasQualityPrices = (id) =>
  [2, 3, 4, 5].some((q) => qPriceOf(id, q) > 0 || qBmPriceOf(id, q) > 0);

export function setQualityPrice(id, quality, value, black = false) {
  const map = black ? state.qBmPrices : state.qPrices;
  const n = Number(value);
  if (quality <= 1) {
    (black ? setBmPrice : setPrice)(id, value);
    return;
  }
  if (!Number.isFinite(n) || n <= 0) {
    if (map[id]) delete map[id][quality];
    if (map[id] && !Object.keys(map[id]).length) delete map[id];
  } else {
    (map[id] ||= {})[quality] = Math.round(n);
  }
  commit();
}

/** Take a whole id -> {quality: price} table from a fetch. */
export function setQualityPrices(table, black = false, seenAt = {}) {
  const flat = black ? state.bmPrices : state.prices;
  const map = black ? state.qBmPrices : state.qPrices;
  const seenMap = black ? state.bmSeen : state.priceSeen;
  for (const [id, at] of Object.entries(table)) {
    let changed = false;
    for (const [q, v] of Object.entries(at)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (Number(q) <= 1) {
        changed = changed || flat[id] !== Math.round(n);
        flat[id] = Math.round(n);
      } else {
        const was = map[id]?.[Number(q)];
        (map[id] ||= {})[Number(q)] = Math.round(n);
        changed = changed || was !== Math.round(n);
      }
    }
    /* One stamp per item, not one per quality level: all five come back from
     * the same request, so they are one observation of one item. */
    stamp(seenMap, id, changed, seenAt[id]);
  }
  commit();
}

export function setBuyPrice(id, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) delete state.buyPrices[id];
  else state.buyPrices[id] = Math.round(n);
  commit();
}

export function setPrice(id, value, seen) {
  const n = Number(value);
  const was = state.prices[id];
  if (!Number.isFinite(n) || n <= 0) {
    delete state.prices[id];
    delete state.priceSeen[id];
  } else {
    state.prices[id] = Math.round(n);
    stamp(state.priceSeen, id, was !== state.prices[id], seen);
  }
  commit();
}

export function setPrices(map, seenAt = {}) {
  for (const [id, v] of Object.entries(map)) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    const was = state.prices[id];
    state.prices[id] = Math.round(n);
    stamp(state.priceSeen, id, was !== state.prices[id], seenAt[id]);
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
  /* Logs, ore, fibre, hide and rock, and the planks, bars, cloth, leather
   * and blocks they refine into. Every tier and every enchant, which is 245
   * ids on top of the farm's 549 - a couple more batches on a fetch. The six
   * thousand weapons stay out of it: the Best tab fetches the slice it is
   * looking at, because nobody prices all of them at once. */
  for (const id of data.resources || []) ids.add(id);
  /* The books a gathering run fills. Seventy ids, empty and full, and both
   * sides are needed: the empty because a market can undercut the station's
   * price, the full because that is the sale. Without these the Market screen
   * could never quote the one number the journal line needs, and the run
   * would only ever be able to subtract the cost of the empties. */
  for (const id of data.journalIds || []) ids.add(id);
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

/** Each sort of building, counted separately. */
export function landSummary() {
  const out = {
    farm: 0, herbgarden: 0, pasture: 0, kennel: 0,
    plant: 0, animal: 0, cities: new Set(), vague: 0,
  };
  for (const h of state.farm) {
    out[h.kind] = (out[h.kind] || 0) + h.count;
    out.cities.add(h.cityId);
    // Land carried over from before the buildings were told apart. Counted,
    // but worth asking you to be precise about.
    if (h.kind === 'plant' || h.kind === 'animal') out.vague += h.count;
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
    || patch.cycleDays !== undefined || patch.keepDays !== undefined) delete state.goal.stamp;
  state.goal.keepDays = !!state.goal.keepDays;
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
export function addSpare(spare, { count, cityId } = {}) {
  if (!spare) return;
  const n = Math.max(1, Math.round(Number(count) || spare.plots || 0));
  state.plan.plots.push({
    id: uid(), itemId: spare.itemId, mode: spare.mode,
    count: n, cityId: cityId || state.settings.farmCity, filler: true,
  });
  commit();
}

/** Stamp the goal with what the plan on screen was worked out against. */
export function setGoalStamp(stamp) {
  state.goal.stamp = stamp;
  commit();
}

/**
 * Move where the crafting happens, and mean it.
 *
 * Setting craftCity alone was not enough: a job carries its own cityId and
 * simulateCycle prefers that to the setting, so a plan the solver built stayed
 * welded to the city it was solved in. Moving the crafting moves the jobs with
 * it. Pin one somewhere else afterwards from the job itself if you want to.
 */
/* ------------------------------------------------------------- stock --- */

/** Set what you hold of one thing. A cost left undefined keeps the old one. */
export function setStock(id, qty, cost) {
  const n = Math.round((Number(qty) || 0) * 100) / 100;
  if (n <= 0) { delete state.stock[id]; commit(); return; }
  const prev = state.stock[id] || { qty: 0, cost: 0 };
  state.stock[id] = {
    qty: n,
    cost: cost === undefined ? prev.cost : Math.max(0, Number(cost) || 0),
  };
  commit();
}

export function clearStock() {
  state.stock = {};
  commit();
}

/**
 * Start the next cycle from where this one ends: what is left on the pile,
 * carrying what it cost, and the focus that carried over. Replaces what was
 * held, rather than adding to it, so pressing it twice is the same as once.
 */
export function carryStockIn(rows, focus) {
  state.stock = {};
  for (const r of rows || []) {
    // The cycle deals in averages; the bag holds whole things. Rounding down
    // is the only honest way to turn 38.6 eggs into eggs you can count on,
    // and the fraction that goes carries its share of the cost with it.
    const qty = Math.floor(r.qty);
    if (!(qty >= 1)) continue;
    const cost = Math.max(0, (r.cost || 0) * (qty / r.qty));
    state.stock[r.id] = { qty, cost };
  }
  if (Number.isFinite(focus)) state.settings.startFocus = Math.max(0, Math.round(focus));
  commit();
}

export function setCraftCity(cityId) {
  // A guild territory is somewhere to farm, not somewhere to craft: it has no
  // station and the file posts no crafting bonus for it.
  if (!(state.settings.cities || []).some((c) => c.id === cityId && !c.farmOnly)) return;
  state.settings.craftCity = cityId;
  state.settings.craftCityPicked = true;
  for (const job of state.plan.crafts) delete job.cityId;
  commit();
}

export function setSettings(patch) {
  Object.assign(state.settings, patch);
  // The three numbers and the day list describe the same thing. Whoever
  // sets the numbers without the list means the shape the numbers make.
  if (!('schedule' in patch) && ('cycleDays' in patch || 'farmDays' in patch
    || 'farmEvery' in patch)) {
    state.settings.schedule = [];
  }
  commit();
}

/* ---------------------------------------------------------- the days --- */

/** The cycle as a list of days, whichever way it is written down. */
export const scheduleDays = () => scheduleOf(state.settings);

/** Replace the whole day list. The numbers follow it, for anything still reading them. */
export function setSchedule(days) {
  const list = (days || []).filter((d) => DAY_MODES.includes(d)).slice(0, 60);
  state.settings.schedule = list;
  if (list.length) {
    state.settings.cycleDays = list.length;
    state.settings.farmDays = list.lastIndexOf('farm') + 1;
    state.settings.farmEvery = 1;
  }
  commit();
}

/** One day, tapped: farm becomes rest, rest becomes craft, craft becomes farm. */
export function setDayMode(index, mode) {
  const days = scheduleDays();
  if (index < 0 || index >= days.length) return;
  days[index] = mode || DAY_MODES[(DAY_MODES.indexOf(days[index]) + 1) % DAY_MODES.length];
  setSchedule(days);
}

/** Make the cycle this long, keeping what is there and farming any new days. */
export function setScheduleLength(n) {
  const len = Math.max(1, Math.min(60, Math.round(Number(n)) || 1));
  const days = scheduleDays().slice(0, len);
  while (days.length < len) days.push('farm');
  setSchedule(days);
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
/* ------------------------------------------------------- gathering kit -- */

/** Change part of the kit. Every road in goes through the same clamp. */
export function setGather(patch) {
  state.settings.gather = normalizeKit({ ...state.settings.gather, ...patch });
  commit();
}

/** One slot of the gatherer set, by the tier of the piece you have on. */
export const setGatherGear = (slot, tierOrOn) =>
  setGather({ gear: { ...state.settings.gather.gear, [slot]: tierOrOn } });

/**
 * What you actually got in ten minutes, filed against what you were farming.
 *
 * The one number in the whole gathering model that no game file can supply,
 * because node density, travel, competition and respawn are not in any dump.
 * Zero clears it, and then the app goes back to saying the hours are unknown.
 */
export function setMeasured(key, per10min) {
  const n = Number(per10min);
  const measured = { ...state.settings.gather.measured };
  if (!Number.isFinite(n) || n <= 0) delete measured[key];
  else measured[key] = { per10min: Math.round(n) };
  setGather({ measured });
}

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
