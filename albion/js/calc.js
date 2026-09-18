// The profit engine. Pure: game data + prices + settings in, silver out.
// Nothing here touches storage or the DOM, so every screen agrees.

export const HOUR = 3600;
export const NUTRITION_PER_PLANT = 48;   // every crop and herb is 48 (items.xml)
/** An island farm plot and a pasture are both 3x3, so nine things per plot. */
export const TILES_PER_PLOT = 9;

export const round = (n, dp = 2) => {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
};

/**
 * Albion's resource return rate. Bonuses are percentage points that add up
 * first, then convert:  RRR = 1 - 100 / (100 + total)
 * So +18 (city) alone gives 15.25%, and +18+59 (focus) gives 43.5%.
 */
export const returnRate = (bonusTotal) => 1 - 100 / (100 + Math.max(0, bonusTotal));

/**
 * Focus cost falls as focus cost efficiency rises. The constant is the 100th
 * root of 2, so every 100 points of efficiency halves the cost.
 */
export const focusCostAt = (base, efficiency, constant = 1.00695555005672) =>
  base / constant ** Math.max(0, efficiency);

/* ------------------------------------------- destiny board efficiency -- */

/** `T?_POTION*` -> a regex. `?` is the tier digit, `*` matches the rest. */
function patternToRegex(pattern) {
  const body = pattern
    .split('')
    .map((ch) => (ch === '?' ? '\\d' : ch === '*' ? '.*' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`);
}

const regexCache = new Map();
const regexFor = (pattern) => {
  if (!regexCache.has(pattern)) regexCache.set(pattern, patternToRegex(pattern));
  return regexCache.get(pattern);
};

const tierOfId = (id) => {
  const m = /^T(\d)_/.exec(id || '');
  return m ? Number(m[1]) : 0;
};

/** Does one rule on a destiny board node cover this item? */
export function ruleCovers(rule, itemId) {
  const tier = tierOfId(itemId);
  if (tier && (tier < rule.minTier || tier > rule.maxTier)) return false;
  return rule.patterns.some((p) => regexFor(p).test(itemId));
}

/**
 * Total focus cost efficiency for one item.
 *
 * Every destiny board node you have levelled contributes, not just the item's
 * own specialisation: the branch mastery covers everything under it, and each
 * specialisation also gives a smaller bonus to its siblings. So levelling
 * Potato Schnapps genuinely makes Major Healing Potions cheaper to brew.
 *
 * Returns the total and the parts, so a figure can be explained rather than
 * just asserted.
 */
export function focusEfficiency(itemId, settings) {
  const levels = settings.nodeLevels || {};
  const nodes = settings.focusNodes || [];
  const parts = [];
  let total = 0;

  for (const node of nodes) {
    const level = Number(levels[node.id]) || 0;
    if (level <= 0) continue;
    for (const rule of node.rules) {
      if (!ruleCovers(rule, itemId)) continue;
      const points = level * rule.bonus;
      total += points;
      parts.push({ node, level, bonus: rule.bonus, points, own: rule.patterns.length <= 2 });
    }
  }
  parts.sort((a, b) => b.points - a.points);
  return { total, parts };
}

/**
 * What the market keeps when you sell: a setup fee plus a transaction tax,
 * both from gamedata.xml. Premium halves the transaction tax (2.5 + 4 = 6.5%
 * against 2.5 + 8 = 10.5%).
 */
export const taxRate = (s) => {
  const setup = s.marketSetupFee ?? 2.5;
  const txn = (s.marketTransactionTax ?? 8) / (s.premium ? 2 : 1);
  return (setup + txn) / 100;
};

const avg = (lo, hi) => (lo + hi) / 2;

/* ------------------------------------------------------------ farming --- */

/**
 * One plot, one growth cycle.
 *
 * Seeds come back at `seedReturn`, and watering with focus adds `wateredBonus`.
 * Above 1.0 the plot pays for its own seed and leaves a surplus, so netSeeds
 * goes negative and counts as income rather than cost.
 */
export function plantCycle(plant, { priceOf, settings, cityId, wateredFraction }) {
  // You only get the watering bonus on the plots you could actually pay to
  // water. The cycle works out what share that is and passes it in.
  const share = settings.watered
    ? Math.max(0, Math.min(1, wateredFraction ?? 1)) : 0;
  const watered = share > 0;
  const city = farmCityFor(settings, cityId);
  const bonusPct = farmBonus(city, plant.id);
  // Per planted tile. A 3x3 plot grows nine of these.
  const yieldPerTile = avg(plant.yieldMin, plant.yieldMax) *
    (settings.premium ? settings.premiumYieldMultiplier : 1) *
    (1 + bonusPct / 100);

  const seedsBack = plant.seedReturn + plant.wateredBonus * share;
  const netSeeds = 1 - seedsBack;

  const seedPrice = priceOf(plant.seedId);
  const cropPrice = priceOf(plant.cropId);

  // Above 100% return the plot feeds itself and leaves seeds over. Those are
  // stock you can sell, so they count as produce rather than as a negative cost.
  const seedsBought = Math.max(0, netSeeds);
  const seedSurplus = Math.max(0, -netSeeds);
  const seedCost = netSeeds * seedPrice;
  const revenue = yieldPerTile * cropPrice * (1 - taxRate(settings));
  // The full ask, not the discounted one: the ledger decides what gets paid.
  // Farming nodes on the destiny board make watering cheaper, same as crafting
  // nodes make brewing cheaper.
  const focusEff = focusEfficiency(plant.id, settings).total;
  const focus = settings.watered
    ? focusCostAt(plant.focusCost, focusEff, settings.focusCostConstant) : 0;

  const hours = plant.growSeconds / HOUR;
  const profit = revenue - seedCost;

  return {
    kind: 'plant', ref: plant, hours, focus, city, farmBonusPct: bonusPct,
    wateredShare: share, focusEfficiency: focusEff,
    yieldPerTile, seedsBack, netSeeds, seedsBought, seedSurplus, seedCost,
    revenue, profit,
    // What a unit actually cost you to grow — used when a craft eats your own crops.
    costPerUnit: yieldPerTile > 0 ? Math.max(0, seedCost) / yieldPerTile : 0,
  };
}

/**
 * One pasture slot, from baby to grown animal.
 *
 * Feed is nutrition / 48 plants. A favourite plant is worth (1 + favouriteBonus)
 * nutrition each, so it takes proportionally fewer of them.
 */
export function animalCycle(animal, { priceOf, settings, cityId, wateredFraction }) {
  const share = settings.watered
    ? Math.max(0, Math.min(1, wateredFraction ?? 1)) : 0;
  const watered = share > 0;
  const city = farmCityFor(settings, cityId);
  const useFav = settings.favouriteFood && animal.favouriteFood;

  const plantsNeeded = animal.nutrition / NUTRITION_PER_PLANT /
    (useFav ? 1 + animal.favouriteBonus : 1);
  const feedId = useFav ? animal.favouriteFood : settings.feedItemId;
  const feedCost = plantsNeeded * priceOf(feedId);

  const babiesBack = animal.offspring + animal.wateredBonus * share;
  const netBabies = 1 - babiesBack;
  const babyCost = netBabies * priceOf(animal.babyId);

  const revenue = priceOf(animal.grownId) * (1 - taxRate(settings));
  const hours = animal.growSeconds / HOUR;
  const focusEff = focusEfficiency(animal.babyId, settings).total;
  const focus = settings.watered
    ? focusCostAt(animal.focusCost, focusEff, settings.focusCostConstant) : 0;
  const profit = revenue - feedCost - babyCost;

  return {
    kind: 'animal', ref: animal, hours, focus, city, farmBonusPct: 0,
    wateredShare: share, focusEfficiency: focusEff,
    plantsNeeded, feedId, feedCost, babiesBack, netBabies, babyCost,
    revenue, profit,
  };
}

/**
 * A grown animal kept for eggs or milk instead of sold. It keeps eating,
 * so feed is charged per production cycle.
 */
export function productCycle(animal, { priceOf, settings, cityId }) {
  if (!animal.product) return null;
  const p = animal.product;
  const hours = p.seconds / HOUR;

  const city = farmCityFor(settings, cityId);
  const bonusPct = farmBonus(city, animal.grownId);
  const perCycle = avg(p.min, p.max) *
    (settings.premium ? settings.premiumYieldMultiplier : 1) *
    (1 + bonusPct / 100);
  const revenue = perCycle * priceOf(p.itemId) * (1 - taxRate(settings));

  // Upkeep: the grown animal eats its full nutrition over each cycle.
  const useFav = settings.favouriteFood && animal.favouriteFood;
  const plantsNeeded = animal.nutrition / NUTRITION_PER_PLANT /
    (useFav ? 1 + animal.favouriteBonus : 1);
  const feedId = useFav ? animal.favouriteFood : settings.feedItemId;
  const feedCost = plantsNeeded * priceOf(feedId);

  return {
    kind: 'product', ref: animal, hours, focus: 0, city, farmBonusPct: bonusPct,
    perCycle, feedId, plantsNeeded, feedCost,
    revenue, profit: revenue - feedCost,
  };
}

/* ----------------------------------------------------------- crafting --- */

/** Look a city up by id, falling back to the given default. */
export function cityById(settings, cityId, fallbackKey = 'craftCity') {
  const list = settings.cities || [];
  return list.find((c) => c.id === (cityId || settings[fallbackKey])) || list[0] || null;
}

/** Where you craft. */
export const cityFor = (settings, cityId) => cityById(settings, cityId, 'craftCity');

/** Where your farm is. An island carries the bonus of the city it is bound to. */
export const farmCityFor = (settings, cityId) => cityById(settings, cityId, 'farmCity');

/**
 * The +10% yield some cities give a specific crop, herb or animal product.
 * Keyed by seed id for plants and by grown-animal id for eggs and milk, which
 * is how farmingmodifiers.xml keys them. Raising an animal gets nothing.
 */
export function farmBonus(city, farmableId) {
  return Number(city?.farmBonus?.[farmableId]) || 0;
}

/**
 * The production bonus a city gives for one kind of item.
 *
 * Every city gives the same base. On top of that a city adds its specialty
 * bonus only for the categories it actually specialises in — potions in
 * Brecilien, cooked food in Caerleon. Crafting a potion in Martlock gets the
 * base and nothing more.
 */
export function cityBonus(city, category, settings) {
  const base = Number(city?.craftBase ?? settings.cityBaseBonus ?? 0);
  const specialty = Number(city?.craftSpecialties?.[category]) || 0;
  return { base, specialty, specialises: specialty > 0, total: base + specialty };
}

/**
 * Focus efficiency for a recipe. The destiny board is the real source; a flat
 * per-recipe override stays available for anyone who would rather just type
 * the number their game screen shows.
 */
export function specFor(settings, recipeId) {
  const own = settings.spec?.[recipeId];
  if (Number.isFinite(own)) return own;
  const board = focusEfficiency(recipeId, settings).total;
  if (board > 0) return board;
  return Number(settings.specLevel) || 0;
}

/**
 * One craft action (which makes `recipe.amount` items).
 *
 * The return rate refunds part of the materials, so materials are charged at
 * (1 - RRR). With focus the real constraint is focus, not silver, which is why
 * silverPerFocus is the number to rank recipes by.
 *
 * `cityId` and `specLevel` override your defaults, so a single job can be
 * costed in the city you actually brew in, at the mastery you actually have.
 */
export function craftBatch(recipe, { priceOf, settings, inputCostOf, cityId, specLevel }) {
  const useFocus = settings.useFocus;
  const city = cityFor(settings, cityId);
  const bonus = cityBonus(city, recipe.category, settings);
  const spec = Number.isFinite(specLevel) ? specLevel : specFor(settings, recipe.id);
  const bonusTotal = bonus.total + (useFocus ? settings.focusCraftBonus : 0);
  const rrr = returnRate(bonusTotal);

  const inputs = recipe.inputs.map((i) => {
    const unit = inputCostOf ? inputCostOf(i.id) : priceOf(i.id);
    return { ...i, unit, total: unit * i.count };
  });
  const materials = inputs.reduce((t, i) => t + i.total, 0);
  const materialsAfterReturn = materials * (1 - rrr);

  const focus = useFocus
    ? focusCostAt(recipe.focus, spec, settings.focusCostConstant)
    : 0;

  const revenue = recipe.amount * priceOf(recipe.id) * (1 - taxRate(settings));
  const fees = (recipe.silver || 0) + (settings.stationFeePerCraft || 0);
  const profit = revenue - materialsAfterReturn - fees;

  return {
    kind: 'craft', ref: recipe, rrr, bonusTotal, focus,
    city, bonus, spec,
    inputs, materials, materialsAfterReturn, fees, revenue, profit,
    margin: revenue > 0 ? profit / revenue : 0,
    silverPerFocus: focus > 0 ? profit / focus : null,
  };
}

/* ------------------------------------------------------------- rates ---- */

/**
 * Scale a single cycle up to a day and a month.
 *
 * `cadenceHours` is how often you actually harvest. Crops finish in 22h, but
 * most people log in once a day, so the default is 24 and the extra 2h is
 * honestly lost rather than quietly counted as profit.
 */
export function perPeriod(cycle, { count = 1, cadenceHours, daysPerMonth = 30 }) {
  const every = Math.max(cycle.hours, cadenceHours || cycle.hours);
  const cyclesPerDay = 24 / every;
  return {
    every,
    cyclesPerDay,
    perCycle: cycle.profit * count,
    perDay: cycle.profit * count * cyclesPerDay,
    perMonth: cycle.profit * count * cyclesPerDay * daysPerMonth,
    focusPerDay: cycle.focus * count * cyclesPerDay,
    focusPerMonth: cycle.focus * count * cyclesPerDay * daysPerMonth,
  };
}

/** Rank every plant and animal by what one plot earns per day. */
export function rankFarmables(data, ctx) {
  const rows = [];
  const cadenceHours = ctx.settings.cadenceHours;
  for (const plant of data.plants) {
    const cycle = plantCycle(plant, ctx);
    rows.push({ cycle, rate: perPeriod(cycle, { cadenceHours }) });
  }
  for (const animal of data.animals) {
    if (ctx.settings.hideMounts && animal.kind === 'mount') continue;
    const cycle = animalCycle(animal, ctx);
    rows.push({ cycle, rate: perPeriod(cycle, { cadenceHours }) });
    const prod = productCycle(animal, ctx);
    if (prod) rows.push({ cycle: prod, rate: perPeriod(prod, { cadenceHours }) });
  }
  return rows.sort((a, b) => b.rate.perDay - a.rate.perDay);
}

/** Rank recipes. With focus on, by silver per focus; otherwise by profit. */
export function rankRecipes(data, ctx) {
  const rows = data.recipes
    .map((r) => craftBatch(r, ctx))
    .filter((b) => Number.isFinite(b.profit));
  const key = ctx.settings.useFocus
    ? (b) => (b.silverPerFocus ?? -Infinity)
    : (b) => b.profit;
  return rows.sort((a, b) => key(b) - key(a));
}

/* -------------------------------------------------------------- plan ---- */

/** Roll a whole farm plan up into one set of totals. */
export function planTotals(plan, data, ctx) {
  const byId = {
    plant: Object.fromEntries(data.plants.map((p) => [p.id, p])),
    animal: Object.fromEntries(data.animals.map((a) => [a.id, a])),
    recipe: Object.fromEntries(data.recipes.map((r) => [r.id, r])),
  };
  const lines = [];

  for (const row of plan.plots) {
    const plant = byId.plant[row.itemId];
    const animal = byId.animal[row.itemId];
    const at = { ...ctx, cityId: row.cityId };
    let cycle = null;
    if (plant) cycle = plantCycle(plant, at);
    else if (animal) {
      cycle = row.mode === 'product'
        ? productCycle(animal, at) : animalCycle(animal, at);
    }
    if (!cycle) continue;
    lines.push({
      row, cycle,
      rate: perPeriod(cycle, { count: row.count, cadenceHours: ctx.settings.cadenceHours }),
    });
  }

  for (const job of plan.crafts) {
    const recipe = byId.recipe[job.recipeId];
    if (!recipe) continue;
    const batch = craftBatch(recipe, {
      ...ctx, cityId: job.cityId, specLevel: job.specLevel,
    });
    const perDay = job.craftsPerDay || 0;
    lines.push({
      row: job, cycle: batch,
      rate: {
        every: 0, cyclesPerDay: perDay,
        perCycle: batch.profit,
        perDay: batch.profit * perDay,
        perMonth: batch.profit * perDay * 30,
        focusPerDay: batch.focus * perDay,
        focusPerMonth: batch.focus * perDay * 30,
      },
    });
  }

  const sum = (get) => lines.reduce((t, l) => t + get(l), 0);
  const focusPerDay = sum((l) => l.rate.focusPerDay);

  return {
    lines,
    perDay: sum((l) => l.rate.perDay),
    perMonth: sum((l) => l.rate.perMonth),
    focusPerDay,
    focusPerMonth: focusPerDay * 30,
    focusBudget: ctx.settings.focusPerDay,
    focusOver: focusPerDay > ctx.settings.focusPerDay,
  };
}

/* ======================================================= the cycle ====== */

/** Is `day` one of the days you actually go out and farm? */
export function isFarmDay(day, farmDays, farmEvery = 1) {
  const every = Math.max(1, Math.round(farmEvery) || 1);
  return day <= farmDays && (day - 1) % every === 0;
}

/** How many harvests a farming phase of this shape gives. */
export function farmDayCount(farmDays, farmEvery = 1) {
  const every = Math.max(1, Math.round(farmEvery) || 1);
  return farmDays <= 0 ? 0 : Math.floor((farmDays - 1) / every) + 1;
}

/**
 * Rest days exist to bank focus, so a row that spends none has no reason to
 * pause: collecting eggs costs nothing, and you collect them every day even on
 * a day you skip watering the herbs.
 */
export const restsWith = (cycle) => (cycle?.focus || 0) > 0;

/**
 * How many harvests one row gets out of a farming phase of this shape.
 *
 * A row that outgrows your login rhythm is capped by the rhythm; a row that
 * takes longer than the rhythm is capped by its own growth time.
 */
export function harvestsFor(cycle, { farmDays, farmEvery = 1, cadenceHours = 24 }) {
  if (!cycle || farmDays <= 0) return 0;
  const every = restsWith(cycle) ? Math.max(1, Math.round(farmEvery) || 1) : 1;
  const rhythmHours = Math.max(cadenceHours || 24, every * 24);
  return rhythmHours >= cycle.hours
    ? farmDayCount(farmDays, every)
    : Math.floor((farmDays * 24) / cycle.hours);
}

/** The cycle for one farm row, whatever it happens to be growing. */
export function rowCycle(row, data, ctx, wateredFraction) {
  const at = { ...ctx, cityId: row.cityId, wateredFraction };
  const plant = data.plants.find((p) => p.id === row.itemId);
  if (plant) return plantCycle(plant, at);
  const animal = data.animals.find((a) => a.id === row.itemId);
  if (!animal) return null;
  return row.mode === 'product' ? productCycle(animal, at) : animalCycle(animal, at);
}

/** What one tile of a row yields, and what it yields it as. */
export function rowOutput(row, cycle, data) {
  if (!cycle) return null;
  if (cycle.kind === 'plant') {
    const plant = data.plants.find((p) => p.id === row.itemId);
    return { itemId: plant.cropId, perTile: cycle.yieldPerTile };
  }
  const animal = data.animals.find((a) => a.id === row.itemId);
  if (!animal) return null;
  return cycle.kind === 'product'
    ? { itemId: animal.product.itemId, perTile: cycle.perCycle }
    : { itemId: animal.grownId, perTile: 1 };
}

/**
 * Focus day by day across one cycle.
 *
 * Focus regenerates a fixed amount daily and stops dead at the cap, so idling
 * past the cap earns nothing \u2014 that wasted regen is the whole reason to know
 * when you cap. Watering spends focus, but only on the days you actually farm:
 * skipping a day banks another day of regeneration for the next watering, at
 * the cost of that day's harvest.
 */
export function focusLedger({
  cycleDays, farmDays, perDay, cap, start = 0, wateringPerDay = 0, farmEvery = 1,
}) {
  let focus = Math.min(cap, Math.max(0, start));
  let wasted = 0;
  let shortfall = 0;        // watering you planned but could not pay for
  let cappedOn = null;
  const days = [];

  for (let day = 1; day <= cycleDays; day++) {
    const before = focus;
    focus = Math.min(cap, focus + perDay);
    const gained = focus - before;
    const lost = perDay - gained;
    wasted += lost;
    if (focus >= cap && cappedOn === null) cappedOn = day;

    const farming = isFarmDay(day, farmDays, farmEvery);
    // You cannot water with focus you do not have.
    const spent = farming ? Math.min(focus, wateringPerDay) : 0;
    if (farming) shortfall += wateringPerDay - spent;
    focus -= spent;

    days.push({
      day, farming, gained, wasted: lost, spent, focus,
      resting: day <= farmDays && !farming,
    });
  }
  return { days, atCraft: focus, wasted, shortfall, cappedOn, cap };
}

/** Run craft jobs so that anything feeding another job runs first. */
function orderByDependency(jobs, recipeOf) {
  const out = [];
  const left = [...jobs];
  const produces = new Map();
  for (const j of left) {
    const r = recipeOf(j.recipeId);
    if (r) produces.set(r.id, j);
  }
  const visit = (job, seen) => {
    if (out.includes(job)) return;
    if (seen.has(job)) return;               // a cycle in the chain: give up, keep order
    seen.add(job);
    const r = recipeOf(job.recipeId);
    for (const input of r?.inputs || []) {
      const feeder = produces.get(input.id);
      if (feeder && feeder !== job) visit(feeder, seen);
    }
    if (!out.includes(job)) out.push(job);
  };
  for (const job of left) visit(job, new Set());
  return out;
}

const add = (pool, id, qty) => { pool[id] = (pool[id] || 0) + qty; };

/**
 * What the things in your pool actually cost you.
 *
 * A craft priced at market rates reads as a disaster when the herbs going into
 * it came off your own plots: you never paid the market for them, you paid for
 * seeds. Carrying a cost basis through the pool is the only way a line on the
 * screen can agree with the total at the top.
 */
function makeLedgerOfCost() {
  const basis = {};
  return {
    put(id, cost) { basis[id] = (basis[id] || 0) + cost; },
    /** Take the share of an item's basis that goes with `qty` of `have`. */
    take(id, qty, have) {
      if (!(have > 0) || !(qty > 0)) return 0;
      const share = Math.min(1, qty / have);
      const out = (basis[id] || 0) * share;
      basis[id] = (basis[id] || 0) - out;
      return out;
    },
    of(id) { return basis[id] || 0; },
  };
}

/**
 * One whole cycle: farm for a while, let focus build, then craft in a batch.
 *
 * This is a single profit and loss for the cycle rather than a sum of daily
 * rates, so nothing is double counted: what you grow feeds what you craft, and
 * only what is actually left over gets sold.
 */
export function simulateCycle(plan, data, ctx) {
  const s = ctx.settings;
  const cycleDays = Math.max(1, s.cycleDays || 14);
  const farmDays = Math.max(0, Math.min(cycleDays, s.farmDays ?? cycleDays));
  // Farm every day, every other day, and so on. Skipping banks focus.
  const farmEvery = Math.max(1, Math.round(s.farmEvery) || 1);
  const cadence = s.cadenceHours || 24;

  const recipeOf = (id) => data.recipes.find((r) => r.id === id);

  /* ---- farm ----
   *
   * Two passes. The first works out what watering the plan is asking for; the
   * ledger then says how much of that focus actually exists. Watering you
   * cannot pay for must not hand you its seed bonus, so the second pass redoes
   * the farm with the share that really got watered.
   */
  const cycleFor = (row, wateredFraction) => rowCycle(row, data, ctx, wateredFraction);

  const tilesOf = (row) => (row.count || 0) * (s.tilesPerPlot || TILES_PER_PLOT);

  const harvestsOf = (cycle) =>
    harvestsFor(cycle, { farmDays, farmEvery, cadenceHours: cadence });

  // Pass one: the watering bill, if every plot got watered.
  let wateringPerDay = 0;
  for (const row of plan.plots) {
    const cycle = cycleFor(row, 1);
    if (cycle) wateringPerDay += (cycle.focus || 0) * tilesOf(row);
  }

  const ledger = focusLedger({
    cycleDays, farmDays, farmEvery,
    perDay: s.focusPerDay, cap: s.focusCap,
    start: s.startFocus || 0,
    wateringPerDay,
  });

  const wateringPaid = ledger.days.reduce((t, d) => t + d.spent, 0);
  const wateringAsked = wateringPerDay * farmDayCount(farmDays, farmEvery);
  const wateredFraction = wateringAsked > 0 ? wateringPaid / wateringAsked : 1;

  // Pass two: the farm as it really runs.
  const pool = {};
  const cost0 = makeLedgerOfCost();
  const farmLines = [];
  let farmCost = 0;

  for (const row of plan.plots) {
    const cycle = cycleFor(row, wateredFraction);
    if (!cycle) continue;
    const plant = cycle.kind === 'plant' ? cycle.ref : null;

    const harvests = harvestsOf(cycle);
    const plots = row.count || 0;
    const tiles = tilesOf(row);

    const { itemId, perTile: perHarvest } = rowOutput(row, cycle, data);
    const produced = perHarvest * tiles * harvests;
    add(pool, itemId, produced);

    // Seeds that came back beyond what was replanted are stock, not a discount.
    if (plant && cycle.seedSurplus > 0) {
      add(pool, plant.seedId, cycle.seedSurplus * tiles * harvests);
    }

    const costPer = plant
      ? cycle.seedsBought * ctx.priceOf(plant.seedId)   // surplus is produce, above
      : cycle.kind === 'product' ? cycle.feedCost
        : cycle.feedCost + cycle.babyCost;
    const cost = costPer * tiles * harvests;
    farmCost += cost;
    // The whole bill lands on the crop; surplus seeds are a by-product and
    // carry nothing, which is why they read as pure profit when sold.
    cost0.put(itemId, cost);

    farmLines.push({
      row, cycle, harvests, itemId, produced, cost, plots, tiles,
      rests: restsWith(cycle),
    });
  }

  let focusLeft = ledger.atCraft;

  /* ---- craft ---- */
  const craftLines = [];
  let buyCost = 0;
  let feeCost = 0;

  for (const job of orderByDependency(plan.crafts, recipeOf)) {
    const recipe = recipeOf(job.recipeId);
    if (!recipe) continue;
    const useFocus = job.useFocus ?? s.useFocus;
    const batch = craftBatch(recipe, {
      ...ctx, cityId: job.cityId, specLevel: job.specLevel,
      settings: { ...s, useFocus },
    });

    // The return rate hands materials straight back, so the same pile makes
    // more crafts — and each of those still costs focus.
    const perCraft = recipe.inputs.map((i) => {
      const net = i.count * (1 - batch.rrr);
      const have = pool[i.id] || 0;
      return { ...i, net, have, allows: net > 0 ? Math.floor(have / net) : Infinity };
    });
    const byMaterial = Math.min(...perCraft.map((i) => i.allows));
    // Which input is the wall, so it can be named rather than left to guess.
    const bottleneck = perCraft.find((i) => i.allows === byMaterial) || null;
    const byFocus = batch.focus > 0 ? Math.floor(focusLeft / batch.focus) : Infinity;

    let crafts;
    let limitedBy;
    if (job.mode === 'fixed') {
      crafts = Math.max(0, Math.min(job.perCycle || 0, byFocus));
      limitedBy = crafts < (job.perCycle || 0) ? 'focus' : 'you';
    } else {
      crafts = Math.max(0, Math.min(byMaterial, byFocus));
      limitedBy = byFocus <= byMaterial ? 'focus' : 'materials';
    }
    if (!Number.isFinite(crafts)) crafts = 0;

    const consumed = {};
    let basisIn = 0;
    for (const i of perCraft) {
      const need = i.net * crafts;
      const have = pool[i.id] || 0;
      const short = Math.max(0, need - have);
      if (short > 0) {
        const bill = short * ctx.priceOf(i.id);
        buyCost += bill;                                     // fixed mode tops up
        basisIn += bill;
      }
      basisIn += cost0.take(i.id, Math.min(need, have), have);
      pool[i.id] = Math.max(0, have - need);
      consumed[i.id] = need;
    }
    const made = recipe.amount * crafts;
    add(pool, recipe.id, made);
    focusLeft -= batch.focus * crafts;
    const fees = ((recipe.silver || 0) + (s.stationFeePerCraft || 0)) * crafts;
    feeCost += fees;
    basisIn += fees;
    cost0.put(recipe.id, basisIn);

    craftLines.push({
      job, recipe, batch, crafts, limitedBy, byMaterial, byFocus,
      consumed, made, useFocus, inputs: perCraft, bottleneck,
      // What this step really cost, counting your own produce at what you paid
      // to grow it rather than at what it would fetch.
      basisIn,
      // An input you have none of, which some other recipe could make for you.
      missing: perCraft.filter((i) => i.have <= 0).map((i) => i.id),
      focusUsed: batch.focus * crafts,
    });
  }

  /* ---- what is actually sold, and what just piles up ----
   *
   * Ingredients your own crafting eats are not sold: you hold them and work
   * through them over following cycles. Booking them as revenue would invent
   * money you never take, and would hide the thing that actually matters -
   * whether the farm is outrunning what your focus can process.
   */
  const eatenByPlan = new Set();
  for (const job of plan.crafts) {
    const r = recipeOf(job.recipeId);
    for (const i of r?.inputs || []) eatenByPlan.add(i.id);
  }
  const keepStock = s.sellSurplus !== true;

  const tax = 1 - taxRate(s);
  const sales = [];
  const stock = [];
  let revenue = 0;
  let stockValue = 0;

  for (const [id, qty] of Object.entries(pool)) {
    if (qty <= 0.0001) continue;
    const unit = ctx.priceOf(id);
    if (keepStock && eatenByPlan.has(id)) {
      // Held for the next batch rather than sold. Valued at what it would
      // fetch, but kept out of profit until it actually is sold.
      stock.push({ id, qty, value: qty * unit * tax });
      stockValue += qty * unit * tax;
    } else {
      const value = qty * unit * tax;
      revenue += value;
      sales.push({ id, qty, value });
    }
  }
  sales.sort((a, b) => b.value - a.value);
  stock.sort((a, b) => b.value - a.value);

  /* A step that feeds another step has no profit of its own: its cost simply
   * moves along the chain. Only the steps whose output you actually sell get a
   * figure, and those figures are what the cycle's profit is made of. */
  const soldValue = Object.fromEntries(sales.map((x) => [x.id, x.value]));
  for (const line of craftLines) {
    const feeds = craftLines.find(
      (o) => o !== line && o.recipe.inputs.some((i) => i.id === line.recipe.id));
    line.feeds = feeds ? feeds.recipe : null;
    line.terminal = !line.feeds;
    line.revenue = soldValue[line.recipe.id] || 0;
    line.gain = line.terminal ? line.revenue - line.basisIn : null;
  }

  /* ---- is the farm outrunning the crafting? ---- */
  const consumed = {};
  for (const line of craftLines) {
    for (const [id, qty] of Object.entries(line.consumed)) {
      consumed[id] = (consumed[id] || 0) + qty;
    }
  }
  const stockCap = Number(s.stockCap) > 0 ? Number(s.stockCap) : Infinity;
  const balance = farmLines.map((l) => {
    const used = consumed[l.itemId] || 0;
    const made = l.produced;
    // How many plots would match what the crafting can actually get through.
    const perPlot = l.plots > 0 ? made / l.plots : 0;
    const leftover = Math.max(0, made - used);
    return {
      itemId: l.itemId, plots: l.plots, made, used, leftover,
      ratio: used > 0 ? made / used : (made > 0 ? Infinity : 1),
      balancedPlots: perPlot > 0 ? used / perPlot : 0,
      // Cycles before the pile passes what you are willing to sit on, starting
      // from empty. One means it happens within a single cycle.
      cyclesToCap: leftover > 0 && Number.isFinite(stockCap)
        ? Math.max(1, Math.ceil(stockCap / leftover)) : null,
      overCapNow: leftover >= stockCap,
    };
  }).filter((b) => b.made > 0);

  const cost = farmCost + buyCost + feeCost;
  const profit = revenue - cost;

  return {
    cycleDays, farmDays, farmEvery, idleDays: cycleDays - farmDays,
    farmingDays: farmDayCount(farmDays, farmEvery),
    restDays: farmDays - farmDayCount(farmDays, farmEvery),
    ledger, focusAtCraft: ledger.atCraft, focusLeft,
    farmLines, craftLines, sales, stock, stockValue, balance, pool, stockCap,
    // Watering asked for, paid for, and the share that decides how much of the
    // seed bonus the farm above actually earned.
    wateringPerDay, wateringAsked, wateringPaid, wateredFraction,
    wateringShortfall: ledger.shortfall,
    farmCost, buyCost, feeCost, cost, revenue, profit,
    perDay: profit / cycleDays,
    perMonth: (profit / cycleDays) * 30,
    focusUsed: ledger.atCraft - focusLeft,
  };
}
