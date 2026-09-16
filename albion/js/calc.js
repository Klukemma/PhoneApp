// The profit engine. Pure: game data + prices + settings in, silver out.
// Nothing here touches storage or the DOM, so every screen agrees.

export const HOUR = 3600;
export const NUTRITION_PER_PLANT = 48;   // every crop and herb is 48 (items.xml)

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

/** Focus cost falls with specialisation — exactly halved at spec 100. */
export const focusCostAt = (base, specLevel, constant = 1.00695555005672) =>
  base / constant ** Math.max(0, specLevel);

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
export function plantCycle(plant, { priceOf, settings, cityId }) {
  const watered = settings.watered;
  const city = farmCityFor(settings, cityId);
  const bonusPct = farmBonus(city, plant.id);
  const yieldPerPlot = avg(plant.yieldMin, plant.yieldMax) *
    (settings.premium ? settings.premiumYieldMultiplier : 1) *
    (1 + bonusPct / 100);

  const seedsBack = plant.seedReturn + (watered ? plant.wateredBonus : 0);
  const netSeeds = 1 - seedsBack;

  const seedPrice = priceOf(plant.seedId);
  const cropPrice = priceOf(plant.cropId);

  const seedCost = netSeeds * seedPrice;
  const revenue = yieldPerPlot * cropPrice * (1 - taxRate(settings));
  const focus = watered ? plant.focusCost : 0;

  const hours = plant.growSeconds / HOUR;
  const profit = revenue - seedCost;

  return {
    kind: 'plant', ref: plant, hours, focus, city, farmBonusPct: bonusPct,
    yieldPerPlot, seedsBack, netSeeds, seedCost, revenue, profit,
    // What a unit actually cost you to grow — used when a craft eats your own crops.
    costPerUnit: yieldPerPlot > 0 ? Math.max(0, seedCost) / yieldPerPlot : 0,
  };
}

/**
 * One pasture slot, from baby to grown animal.
 *
 * Feed is nutrition / 48 plants. A favourite plant is worth (1 + favouriteBonus)
 * nutrition each, so it takes proportionally fewer of them.
 */
export function animalCycle(animal, { priceOf, settings, cityId }) {
  const watered = settings.watered;
  const city = farmCityFor(settings, cityId);
  const useFav = settings.favouriteFood && animal.favouriteFood;

  const plantsNeeded = animal.nutrition / NUTRITION_PER_PLANT /
    (useFav ? 1 + animal.favouriteBonus : 1);
  const feedId = useFav ? animal.favouriteFood : settings.feedItemId;
  const feedCost = plantsNeeded * priceOf(feedId);

  const babiesBack = animal.offspring + (watered ? animal.wateredBonus : 0);
  const netBabies = 1 - babiesBack;
  const babyCost = netBabies * priceOf(animal.babyId);

  const revenue = priceOf(animal.grownId) * (1 - taxRate(settings));
  const hours = animal.growSeconds / HOUR;
  const focus = watered ? animal.focusCost : 0;
  const profit = revenue - feedCost - babyCost;

  return {
    kind: 'animal', ref: animal, hours, focus, city, farmBonusPct: 0,
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

/** Mastery for one recipe: its own level if set, otherwise your default. */
export function specFor(settings, recipeId) {
  const own = settings.spec?.[recipeId];
  return Number.isFinite(own) ? own : (Number(settings.specLevel) || 0);
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

/**
 * Focus day by day across one cycle.
 *
 * Focus regenerates a fixed amount daily and stops dead at the cap, so idling
 * past the cap earns nothing — that wasted regen is the whole reason to know
 * when you cap. Watering plots spends focus on the days you farm.
 */
export function focusLedger({ cycleDays, farmDays, perDay, cap, start = 0, wateringPerDay = 0 }) {
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

    const farming = day <= farmDays;
    // You cannot water with focus you do not have.
    const spent = farming ? Math.min(focus, wateringPerDay) : 0;
    if (farming) shortfall += wateringPerDay - spent;
    focus -= spent;

    days.push({ day, farming, gained, wasted: lost, spent, focus });
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
  const cadence = s.cadenceHours || 24;

  const plantOf = Object.fromEntries(data.plants.map((p) => [p.id, p]));
  const animalOf = Object.fromEntries(data.animals.map((a) => [a.id, a]));
  const recipeOf = (id) => data.recipes.find((r) => r.id === id);

  /* ---- farm ---- */
  const pool = {};
  const farmLines = [];
  let farmCost = 0;
  let wateringPerDay = 0;

  for (const row of plan.plots) {
    const at = { ...ctx, cityId: row.cityId };
    const plant = plantOf[row.itemId];
    const animal = animalOf[row.itemId];
    let cycle = null;
    if (plant) cycle = plantCycle(plant, at);
    else if (animal) {
      cycle = row.mode === 'product' ? productCycle(animal, at) : animalCycle(animal, at);
    }
    if (!cycle) continue;

    const every = Math.max(cycle.hours, cadence);
    const harvests = Math.floor((farmDays * 24) / every);
    const count = row.count || 0;

    let itemId = null;
    let perHarvest = 0;
    if (cycle.kind === 'plant') { itemId = plant.cropId; perHarvest = cycle.yieldPerPlot; }
    else if (cycle.kind === 'product') { itemId = animal.product.itemId; perHarvest = cycle.perCycle; }
    else { itemId = animal.grownId; perHarvest = 1; }

    const produced = perHarvest * count * harvests;
    add(pool, itemId, produced);

    // Every harvest costs its seed, feed or baby again.
    const costPer = cycle.kind === 'plant' ? cycle.seedCost
      : cycle.kind === 'product' ? cycle.feedCost
        : cycle.feedCost + cycle.babyCost;
    const cost = costPer * count * harvests;
    farmCost += cost;
    wateringPerDay += (cycle.focus || 0) * count;

    farmLines.push({ row, cycle, harvests, itemId, produced, cost });
  }

  /* ---- focus ---- */
  const ledger = focusLedger({
    cycleDays, farmDays,
    perDay: s.focusPerDay, cap: s.focusCap,
    start: s.startFocus || 0,
    wateringPerDay,
  });
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
    const perCraft = recipe.inputs.map((i) => ({
      ...i, net: i.count * (1 - batch.rrr),
    }));
    const byMaterial = Math.min(...perCraft.map((i) =>
      (i.net > 0 ? Math.floor((pool[i.id] || 0) / i.net) : Infinity)));
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
    for (const i of perCraft) {
      const need = i.net * crafts;
      const have = pool[i.id] || 0;
      const short = Math.max(0, need - have);
      if (short > 0) buyCost += short * ctx.priceOf(i.id);   // fixed mode tops up
      pool[i.id] = Math.max(0, have - need);
      consumed[i.id] = need;
    }
    const made = recipe.amount * crafts;
    add(pool, recipe.id, made);
    focusLeft -= batch.focus * crafts;
    feeCost += ((recipe.silver || 0) + (s.stationFeePerCraft || 0)) * crafts;

    craftLines.push({
      job, recipe, batch, crafts, limitedBy, byMaterial, byFocus,
      consumed, made, useFocus,
      focusUsed: batch.focus * crafts,
    });
  }

  /* ---- sell whatever is left ---- */
  const tax = 1 - taxRate(s);
  const sales = [];
  let revenue = 0;
  for (const [id, qty] of Object.entries(pool)) {
    if (qty <= 0.0001) continue;
    const value = qty * ctx.priceOf(id) * tax;
    revenue += value;
    sales.push({ id, qty, value });
  }
  sales.sort((a, b) => b.value - a.value);

  const cost = farmCost + buyCost + feeCost;
  const profit = revenue - cost;

  return {
    cycleDays, farmDays, idleDays: cycleDays - farmDays,
    ledger, focusAtCraft: ledger.atCraft, focusLeft, wateringPerDay,
    farmLines, craftLines, sales, pool,
    // Watering you planned but cannot pay for, so those plots are really dry
    // and their yields above are optimistic.
    wateringShortfall: ledger.shortfall,
    farmCost, buyCost, feeCost, cost, revenue, profit,
    perDay: profit / cycleDays,
    perMonth: (profit / cycleDays) * 30,
    focusUsed: ledger.atCraft - focusLeft,
  };
}
