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

/** What the market keeps when you sell. */
export const taxRate = (s) =>
  (s.premium ? s.marketTaxPremium : s.marketTaxNormal) / 100;

const avg = (lo, hi) => (lo + hi) / 2;

/* ------------------------------------------------------------ farming --- */

/**
 * One plot, one growth cycle.
 *
 * Seeds come back at `seedReturn`, and watering with focus adds `wateredBonus`.
 * Above 1.0 the plot pays for its own seed and leaves a surplus, so netSeeds
 * goes negative and counts as income rather than cost.
 */
export function plantCycle(plant, { priceOf, settings }) {
  const watered = settings.watered;
  const yieldPerPlot = avg(plant.yieldMin, plant.yieldMax) *
    (settings.premium ? settings.premiumYieldMultiplier : 1);

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
    kind: 'plant', ref: plant, hours, focus,
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
export function animalCycle(animal, { priceOf, settings }) {
  const watered = settings.watered;
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
    kind: 'animal', ref: animal, hours, focus,
    plantsNeeded, feedId, feedCost, babiesBack, netBabies, babyCost,
    revenue, profit,
  };
}

/**
 * A grown animal kept for eggs or milk instead of sold. It keeps eating,
 * so feed is charged per production cycle.
 */
export function productCycle(animal, { priceOf, settings }) {
  if (!animal.product) return null;
  const p = animal.product;
  const hours = p.seconds / HOUR;

  const perCycle = avg(p.min, p.max) *
    (settings.premium ? settings.premiumYieldMultiplier : 1);
  const revenue = perCycle * priceOf(p.itemId) * (1 - taxRate(settings));

  // Upkeep: the grown animal eats its full nutrition over each cycle.
  const useFav = settings.favouriteFood && animal.favouriteFood;
  const plantsNeeded = animal.nutrition / NUTRITION_PER_PLANT /
    (useFav ? 1 + animal.favouriteBonus : 1);
  const feedId = useFav ? animal.favouriteFood : settings.feedItemId;
  const feedCost = plantsNeeded * priceOf(feedId);

  return {
    kind: 'product', ref: animal, hours, focus: 0,
    perCycle, feedId, plantsNeeded, feedCost,
    revenue, profit: revenue - feedCost,
  };
}

/* ----------------------------------------------------------- crafting --- */

/**
 * One craft action (which makes `recipe.amount` items).
 *
 * The return rate refunds part of the materials, so materials are charged at
 * (1 - RRR). With focus the real constraint is focus, not silver, which is why
 * silverPerFocus is the number to rank recipes by.
 */
export function craftBatch(recipe, { priceOf, settings, inputCostOf }) {
  const useFocus = settings.useFocus;
  const bonusTotal = settings.cityBaseBonus +
    (settings.citySpecialty ? settings.craftSpecialtyBonus : 0) +
    (useFocus ? settings.focusCraftBonus : 0);
  const rrr = returnRate(bonusTotal);

  const inputs = recipe.inputs.map((i) => {
    const unit = inputCostOf ? inputCostOf(i.id) : priceOf(i.id);
    return { ...i, unit, total: unit * i.count };
  });
  const materials = inputs.reduce((t, i) => t + i.total, 0);
  const materialsAfterReturn = materials * (1 - rrr);

  const focus = useFocus
    ? focusCostAt(recipe.focus, settings.specLevel, settings.focusCostConstant)
    : 0;

  const revenue = recipe.amount * priceOf(recipe.id) * (1 - taxRate(settings));
  const fees = (recipe.silver || 0) + (settings.stationFeePerCraft || 0);
  const profit = revenue - materialsAfterReturn - fees;

  return {
    kind: 'craft', ref: recipe, rrr, bonusTotal, focus,
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
  for (const plant of data.plants) {
    const cycle = plantCycle(plant, ctx);
    rows.push({ cycle, rate: perPeriod(cycle, { cadenceHours: ctx.settings.cadenceHours }) });
  }
  for (const animal of data.animals) {
    if (ctx.settings.hideMounts && animal.kind === 'mount') continue;
    const cycle = animalCycle(animal, ctx);
    rows.push({ cycle, rate: perPeriod(cycle, { cadenceHours: ctx.settings.cadenceHours }) });
    const prod = productCycle(animal, ctx);
    if (prod) {
      rows.push({ cycle: prod, rate: perPeriod(prod, { cadenceHours: ctx.settings.cadenceHours }) });
    }
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
    let cycle = null;
    if (plant) cycle = plantCycle(plant, ctx);
    else if (animal) {
      cycle = row.mode === 'product'
        ? productCycle(animal, ctx) : animalCycle(animal, ctx);
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
    const batch = craftBatch(recipe, ctx);
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
