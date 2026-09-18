// The profit engine. Pure: game data + prices + settings in, silver out.
// Nothing here touches storage or the DOM, so every screen agrees.

export const HOUR = 3600;
export const NUTRITION_PER_PLANT = 48;   // every crop and herb is 48 (items.xml)

/**
 * What goes in the trough when you have not said. Wheat is the cheap plant,
 * raw chicken the cheap meat, and a T8 ox the cheap mount feed per nutrition.
 */
export const FEED_DEFAULTS = {
  plants: 'T3_WHEAT', meat: 'T3_MEAT', mount: 'T8_FARM_OX_GROWN',
};

/**
 * What this animal eats, and how much of it one nutrition point costs.
 *
 * The game refuses food from the wrong category outright \u2014 "{0} does not eat
 * {1}" \u2014 so a direwolf is fed meat whatever wheat costs, and the drake eats
 * grown mounts. Plants are a flat 48 nutrition and meat a flat 52, but mount
 * food runs from 8 to 59,049, so one number for "a plant" was only ever right
 * for two of the three categories.
 */
export function feedFor(animal, settings) {
  const category = animal.foodCategory || 'plants';
  const table = settings.feeds?.[category] || {};
  // The favourite is read off the same element as the category, so it is
  // always something this animal will eat.
  const useFav = !!(settings.favouriteFood && animal.favouriteFood);
  const id = useFav ? animal.favouriteFood
    : (settings.feedItemIds?.[category] || FEED_DEFAULTS[category]);
  return {
    id, category,
    nutrition: table[id] || (category === 'meat' ? 52 : NUTRITION_PER_PLANT),
    bonus: useFav ? animal.favouriteBonus : 0,
  };
}
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
  /* Match the base item, not the enchanted id.
   *
   * Nothing in achievements.xml carries an enchantment suffix: all 709 item
   * patterns are written against the plain item, and several specialisations
   * name it exactly with no wildcard \u2014 "T?_POTION_HEAL". The game strips the
   * suffix before matching, which is why levelling Major Healing Potion also
   * cheapens its .1, .2 and .3. Testing the raw "T6_POTION_HEAL@1" against
   * ^T\\d_POTION_HEAL$ silently threw away 2.5 efficiency points per level on
   * every enchanted potion, which at mastery 100 is a factor of 5.66 on focus.
   */
  const base = (itemId || '').split('@')[0];
  const tier = tierOfId(base);
  if (tier && (tier < rule.minTier || tier > rule.maxTier)) return false;
  return rule.patterns.some((p) => regexFor(p).test(base));
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

/**
 * Focus regenerated per day.
 *
 * The only figure the dumps publish is attributed to Premium outright:
 * "+10000 Focus per day", listed among its additional benefits. What a
 * character without Premium regenerates is published nowhere, so it is the
 * player's own number — the one their game screen shows them.
 */
export const focusPerDayOf = (s) => (s.premium
  ? (s.focusPerDay ?? 0)
  : (s.focusPerDayNoPremium ?? 0));

const avg = (lo, hi) => (lo + hi) / 2;

/* ------------------------------------------------------------ farming --- */

/**
 * One plot, one growth cycle.
 *
 * Seeds come back at `seedReturn`, and watering with focus adds `wateredBonus`.
 * Above 1.0 the plot pays for its own seed and leaves a surplus, so netSeeds
 * goes negative and counts as income rather than cost.
 */
export function plantCycle(plant, {
  priceOf, costOf = priceOf, settings, cityId, wateredFraction,
}) {
  /* You only get the bonus on the plots you could actually pay for, and only
   * if you have Premium at all: the client's own refusal is published, and
   * only in island form — "You need to have at least {0} more Premium days to
   * be able to water plants." Both the bonus and its focus charge come off the
   * same flag, or a non-Premium plan pays 1000 focus a tile for nothing. */
  const canWater = !!(settings.watered && settings.premium);
  const share = canWater
    ? Math.max(0, Math.min(1, wateredFraction ?? 1)) : 0;
  const city = farmCityFor(settings, cityId);
  const bonusPct = farmBonus(city, plant.id);
  // Per planted tile. A 3x3 plot grows nine of these.
  const yieldPerTile = avg(plant.yieldMin, plant.yieldMax) *
    (settings.premium ? settings.premiumYieldMultiplier : 1) *
    (1 + bonusPct / 100);

  // activefarmbonus is per nurture and activefarmmaxcycles caps how many one
  // growth allows. Every plant allows exactly one, so this is a no-op here and
  // the whole story for mounts.
  const nurtures = Math.max(1, plant.maxCycles || 1);
  const seedsBack = plant.seedReturn + plant.wateredBonus * share * nurtures;
  const netSeeds = 1 - seedsBack;

  const cropPrice = priceOf(plant.cropId);

  // Above 100% return the plot feeds itself and leaves seeds over. Those are
  // stock you can sell, so they count as produce rather than as a negative cost.
  // Seeds you buy and seeds you sell are two different prices, so each side is
  // valued on its own.
  const seedsBought = Math.max(0, netSeeds);
  const seedSurplus = Math.max(0, -netSeeds);
  const seedCost = seedsBought * costOf(plant.seedId) - seedSurplus * priceOf(plant.seedId);
  const revenue = yieldPerTile * cropPrice * (1 - taxRate(settings));
  // The full ask, not the discounted one: the ledger decides what gets paid.
  // Farming nodes on the destiny board make watering cheaper, same as crafting
  // nodes make brewing cheaper.
  const focusEff = focusEfficiency(plant.id, settings).total;
  // Focus for a whole growth, not for a day: one charge per nurture allowed.
  const focus = canWater
    ? nurtures * focusCostAt(plant.focusCost, focusEff, settings.focusCostConstant) : 0;

  const hours = plant.growSeconds / HOUR;
  const profit = revenue - seedCost;

  return {
    kind: 'plant', ref: plant, hours, focus, city, farmBonusPct: bonusPct,
    wateredShare: share, focusEfficiency: focusEff, nurtures,
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
export function animalCycle(animal, {
  priceOf, costOf = priceOf, settings, cityId, wateredFraction,
}) {
  // Nurturing is gated on Premium the same way watering is, and published the
  // same way: "...to be able to nurture animals."
  const canWater = !!(settings.watered && settings.premium);
  const share = canWater
    ? Math.max(0, Math.min(1, wateredFraction ?? 1)) : 0;
  /* Premium doubles farm animal growth rate — its own listed benefit, separate
   * from the double crop yield plants get. Feed drains in real time, so a
   * growth that finishes twice as fast eats half as much. */
  const growthMult = settings.premium ? (settings.premiumGrowthMultiplier ?? 2) : 1;
  const city = farmCityFor(settings, cityId);

  /* What it eats over the whole growth, not one bar of it. The bar refills
   * once per nurture, so a T8 ox gets through nearly six of them; livestock
   * eat exactly one, which is why a single bar looked right for so long. */
  const eaten = (animal.nutritionTotal || animal.nutrition) / growthMult;
  const feed = feedFor(animal, settings);
  const plantsNeeded = eaten / feed.nutrition / (1 + feed.bonus);
  const feedId = feed.id;
  const feedCost = plantsNeeded * costOf(feedId);

  /* A nurture's bonus is per nurture, and a growth allows activefarmmaxcycles
   * of them. A T8 ox takes six: 0.8736 + 6 x 0.0263 = 1.0314, so it pays for
   * its own replacement and leaves a surplus. Counting one nurture gives
   * 0.8999 and turns the best animal in the game into a loss. */
  const nurtures = Math.max(1, animal.maxCycles || 1);
  const babiesBack = animal.offspring + animal.wateredBonus * share * nurtures;
  const netBabies = 1 - babiesBack;
  const babiesBought = Math.max(0, netBabies);
  const babySurplus = Math.max(0, -netBabies);
  const babyCost = babiesBought * costOf(animal.babyId) - babySurplus * priceOf(animal.babyId);

  const revenue = priceOf(animal.grownId) * (1 - taxRate(settings));
  const hours = animal.growSeconds / growthMult / HOUR;
  const focusEff = focusEfficiency(animal.babyId, settings).total;
  const focus = canWater
    ? nurtures * focusCostAt(animal.focusCost, focusEff, settings.focusCostConstant) : 0;
  const profit = revenue - feedCost - babyCost;

  return {
    kind: 'animal', ref: animal, hours, focus, city, farmBonusPct: 0,
    wateredShare: share, focusEfficiency: focusEff, nurtures,
    plantsNeeded, eaten, feedId, feedCategory: feed.category, feedCost, babiesBack, netBabies,
    babiesBought, babySurplus, babyCost,
    revenue, profit,
  };
}

/**
 * A grown animal kept for eggs or milk instead of sold. It keeps eating,
 * so feed is charged per production cycle.
 */
export function productCycle(animal, { priceOf, costOf = priceOf, settings, cityId }) {
  if (!animal.product) return null;
  const p = animal.product;
  const hours = p.seconds / HOUR;

  const city = farmCityFor(settings, cityId);
  const bonusPct = farmBonus(city, animal.grownId);
  const perCycle = avg(p.min, p.max) *
    (settings.premium ? settings.premiumYieldMultiplier : 1) *
    (1 + bonusPct / 100);
  const revenue = perCycle * priceOf(p.itemId) * (1 - taxRate(settings));

  /* Upkeep: what it eats during one production cycle, which is not a whole
   * food bar. A goose lays every 22 hours and eats 432 nutrition doing it, so
   * charging the full 864 doubled the feed bill on every egg. */
  const eaten = p.nutrition || animal.nutrition;
  const feed = feedFor(animal, settings);
  const plantsNeeded = eaten / feed.nutrition / (1 + feed.bonus);
  const feedId = feed.id;
  const feedCost = plantsNeeded * costOf(feedId);

  return {
    kind: 'product', ref: animal, hours, focus: 0, city, farmBonusPct: bonusPct,
    perCycle, feedId, feedCategory: feed.category, plantsNeeded, feedCost, eaten,
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

/**
 * Where your farm is.
 *
 * Every island is bound to a city and farms with that city's full bonus:
 * farmingmodifiers.xml gives the same islandvalue as value for all thirty
 * royal-city rows. There is no such thing as a farm with no city behind it, so
 * a location that only exists for crafting is never a valid answer here.
 */
export function farmCityFor(settings, cityId) {
  const found = cityById(settings, cityId, 'farmCity');
  if (found && !found.craftOnly) return found;
  const fallback = (settings.cities || []).find((c) => c.id === settings.farmCity);
  return (fallback && !fallback.craftOnly ? fallback : null)
    || (settings.cities || []).find((c) => !c.craftOnly)
    || found || null;
}

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
 * The nutrition one craft action burns at a station.
 *
 * This is what the usage fee is charged on: the game turns the item's value
 * into nutrition with a published factor, and the owner posts a rate per 100
 * of it. Tier 1 and 2 crafts are free, which gamedata.xml states outright.
 *
 * A potion is 108 times the nutrition of the schnapps that goes into it, so a
 * single flat fee per craft cannot be right for both — it was either nothing
 * or, once typed in, fourteen times too much on the cheap high-volume step.
 */
export function craftNutrition(recipe, settings) {
  if (!recipe) return 0;
  const free = settings.freeCraftingMaxTier ?? 2;
  if (recipe.tier <= free) return 0;
  const factor = settings.itemValueToNutrition ?? 0.1125;
  return (recipe.itemValue || 0) * (recipe.amount || 1) * factor;
}

/**
 * What the station owner charges you per craft action, in silver.
 *
 * The rate is per city, because it is the owner's rate and you stand in their
 * building. Your own island station charges you nothing, which is the whole
 * reason to have one.
 */
export function usageFeeFor(recipe, settings, cityId) {
  const city = cityFor(settings, cityId);
  if (!city || city.craftOnly) return 0;          // your own island
  const posted = Number(settings.stationFee?.[city.id]) || 0;
  const rate = Math.min(posted, settings.maxUsageFee ?? 1000);
  return craftNutrition(recipe, settings) * rate / 100;
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
export function craftBatch(recipe, {
  priceOf, costOf = priceOf, settings, inputCostOf, cityId, specLevel,
}) {
  const useFocus = settings.useFocus;
  const city = cityFor(settings, cityId);
  const bonus = cityBonus(city, recipe.category, settings);
  const spec = Number.isFinite(specLevel) ? specLevel : specFor(settings, recipe.id);
  const bonusTotal = bonus.total + (useFocus ? settings.focusCraftBonus : 0);
  const rrr = returnRate(bonusTotal);

  /* The return rate is not a discount on the basket: the game refuses to give
   * some inputs back at all, and those are usually the expensive ones. An
   * artefact or a lump of Avalonian energy is consumed outright however much
   * focus you spend, so it is charged in full while the rest comes back. */
  const inputs = recipe.inputs.map((i) => {
    const unit = inputCostOf ? inputCostOf(i.id) : costOf(i.id);
    const back = i.noReturn ? 0 : rrr;
    return { ...i, unit, back, total: unit * i.count, net: i.count * (1 - back) };
  });
  const materials = inputs.reduce((t, i) => t + i.total, 0);
  const materialsAfterReturn = inputs.reduce((t, i) => t + i.unit * i.net, 0);

  const focus = useFocus
    ? focusCostAt(recipe.focus, spec, settings.focusCostConstant)
    : 0;

  /* Butchering is the game's one "product yield" recipe. A cow cannot come
   * back half-refunded, so what the return rate would have handed back in
   * resources is handed over as extra meat instead \u2014 which is why the station
   * swaps its "Resource Return Rate" label for "Product Yield" on exactly
   * these six. The dumps carry the flag and not the number, so this reads it
   * as the same rate paid in product. */
  const made = recipe.amount * (recipe.returnProduct ? 1 + rrr : 1);
  const revenue = made * priceOf(recipe.id) * (1 - taxRate(settings));
  const stationNutrition = craftNutrition(recipe, settings);
  const usageFee = usageFeeFor(recipe, settings, cityId);
  const fees = (recipe.silver || 0) + usageFee;
  const profit = revenue - materialsAfterReturn - fees;

  return {
    kind: 'craft', ref: recipe, rrr, bonusTotal, focus,
    city, bonus, spec, made,
    inputs, materials, materialsAfterReturn, fees, stationNutrition, usageFee,
    revenue, profit,
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
  // `count` is tiles, because that is what a cycle is priced in. Callers that
  // think in plots must multiply by TILES_PER_PLOT before they get here.
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

/**
 * Rank every plant and animal by what one plot earns per day.
 *
 * A cycle is priced per tile and a plot is a 3x3 grid, so a ranking that
 * forgot to multiply was quoting a ninth of the real figure under a per-plot
 * heading — and quoting a ninth of the focus with it.
 */
export function rankFarmables(data, ctx) {
  const rows = [];
  const cadenceHours = ctx.settings.cadenceHours;
  const count = ctx.settings.tilesPerPlot || TILES_PER_PLOT;
  for (const plant of data.plants) {
    const cycle = plantCycle(plant, ctx);
    rows.push({ cycle, rate: perPeriod(cycle, { count, cadenceHours }) });
  }
  for (const animal of data.animals) {
    if (ctx.settings.hideMounts && animal.kind === 'mount') continue;
    const cycle = animalCycle(animal, ctx);
    rows.push({ cycle, rate: perPeriod(cycle, { count, cadenceHours }) });
    const prod = productCycle(animal, ctx);
    if (prod) rows.push({ cycle: prod, rate: perPeriod(prod, { count, cadenceHours }) });
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
      rate: perPeriod(cycle, {
        count: (row.count || 0) * (ctx.settings.tilesPerPlot || TILES_PER_PLOT),
        cadenceHours: ctx.settings.cadenceHours,
      }),
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
    focusBudget: focusPerDayOf(ctx.settings),
    focusOver: focusPerDay > focusPerDayOf(ctx.settings),
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
 * Does this row cost focus while you are standing there? Watering and
 * nurturing do; collecting eggs and milk do not. That answers what you pay
 * on a farm day \u2014 never whether you were there, which is what `farmEvery`
 * is for. A goose does not lay into your bag on a day you did not log in.
 */
export const restsWith = (cycle) => (cycle?.focus || 0) > 0;

/**
 * How many harvests one row gets out of a farming phase of this shape.
 *
 * A row that outgrows your login rhythm is capped by the rhythm; a row that
 * takes longer than the rhythm is capped by its own growth time.
 */
export function harvestsFor(cycle, {
  cycleDays, farmDays, farmEvery = 1, cadenceHours = 24,
}) {
  if (!cycle || farmDays <= 0) return 0;
  // A growth takes wall-clock days, and the clock does not stop on the days
  // you are not there. Counting only farm days let a slow row finish more
  // growths than the calendar has room for.
  const span = Math.max(farmDays, cycleDays || farmDays);
  const every = Math.max(1, Math.round(farmEvery) || 1);
  /* You harvest no faster than the thing grows, no faster than you log in, and
   * no faster than the rhythm you chose to farm on. Whichever of those three is
   * slowest sets the gap between harvests: a 44-hour cow does not give you a
   * calf a day just because you visited, and a two-day login rhythm does not
   * harvest twice. */
  const gap = Math.max(
    every,
    Math.ceil((cadenceHours || 24) / 24),
    Math.ceil(cycle.hours / 24),
  );
  /* Two ceilings, and the lower one wins: the harvest days the phase actually
   * contains, spaced a growth apart, and the number of growths the cycle has
   * wall-clock room for. Something slower than the whole cycle reports the
   * fraction of a growth it really finishes rather than a whole one. */
  return Math.min(farmDayCount(farmDays, gap), span / gap);
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

/**
 * Which building a row has to go in.
 *
 * The game has four and keeps them strictly apart: a Farm takes crops, a Herb
 * Garden takes herbs, a Pasture takes livestock and a Kennel takes the exotic
 * mounts. Carrots will not grow in a herb garden and a goose will not live in
 * either, so the plan does not get to pretend otherwise. Which is which comes
 * straight out of the game files rather than being inferred from whether a
 * thing looks like a plant.
 */
export const PLOTS = ['farm', 'herbgarden', 'pasture', 'kennel'];

export const plotKindOf = (cycle) => cycle?.ref?.plot
  || (cycle?.kind === 'plant' ? 'farm' : 'pasture');

/** Labels for the four, as the game names the buildings. */
export const PLOT_LABEL = {
  farm: 'Farm', herbgarden: 'Herb Garden',
  pasture: 'Pasture', kennel: 'Kennel',
  // Kept so a farm described before the four were told apart still works.
  plant: 'Farm or Herb Garden', animal: 'Pasture or Kennel', any: 'Any plot',
};

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
 * Focus regenerates a fixed amount daily and stops dead at the cap. What
 * matters is that you do not have to sit on it until some grand crafting day:
 * a craft hands most of its materials straight back, so the same pile of herbs
 * keeps making more potions, and you spend each day's focus the day it
 * arrives. A cycle is worth the focus it regenerates over its whole length,
 * not the thirty thousand it can hold at one moment \u2014 which is why a longer
 * cycle is not the waste it looks like as long as you are crafting through it.
 *
 * Focus only goes to waste when there is genuinely nothing to spend it on: the
 * crafting has run out of materials and the bar is already full.
 *
 * Watering comes first on any day you farm, because a plot has to be watered
 * when you are standing there; crafting takes whatever is left, which is the
 * real reason watering a big farm and crafting hard compete.
 */
export function focusLedger({
  cycleDays, farmDays, perDay, cap, start = 0, wateringPerDay = 0, farmEvery = 1,
  craftingPerDay = 0,
}) {
  let focus = Math.min(cap, Math.max(0, start));
  let wasted = 0;
  let shortfall = 0;        // watering you planned but could not pay for
  let spentWatering = 0;
  let spentCrafting = 0;
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
    spentWatering += spent;

    const craft = Math.max(0, Math.min(focus, craftingPerDay));
    focus -= craft;
    spentCrafting += craft;

    days.push({
      day, farming, gained, wasted: lost, spent, craft, focus,
      resting: day <= farmDays && !farming,
    });
  }
  return {
    days, atCraft: focus, left: focus,
    spentWatering, spentCrafting, wasted, shortfall, cappedOn, cap,
  };
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
  // What you pay for a thing and what you get for it are two different numbers.
  // Where no separate buy price is kept, they collapse back into one.
  const costOf = ctx.costOf || ctx.priceOf;
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
    harvestsFor(cycle, { cycleDays, farmDays, farmEvery, cadenceHours: cadence });

  /* Pass one: the care bill, if every tile got its focus.
   *
   * A cycle's focus is the cost of one whole growth, not of one day. A cow
   * takes 44 hours to raise and one 1000-focus nurture to do it, so billing it
   * every calendar day charges twice what the game does; a T8 ox takes six
   * nurtures over twelve days and billing one a day charges less than half.
   * Count the nurtures each row actually completes in the phase, then spread
   * that over the days you are out there. */
  let careTotal = 0;
  for (const row of plan.plots) {
    const cycle = cycleFor(row, 1);
    if (cycle) careTotal += (cycle.focus || 0) * tilesOf(row) * harvestsOf(cycle);
  }
  const careDays = Math.max(1, farmDayCount(farmDays, farmEvery));
  const wateringPerDay = careTotal / careDays;

  const ledgerAt = (craftingPerDay) => focusLedger({
    cycleDays, farmDays, farmEvery,
    perDay: focusPerDayOf(s), cap: s.focusCap,
    start: s.startFocus || 0,
    wateringPerDay, craftingPerDay,
  });

  /* Watering first: it has to be paid on the day you are standing in the
   * field, out of whatever has built up, which is exactly why skipping a day
   * lets you water more of a big farm. */
  const banked = ledgerAt(0);
  const wateringPaid = banked.spentWatering;
  const wateringAsked = careTotal;
  const wateredFraction = wateringAsked > 0 ? wateringPaid / wateringAsked : 1;

  /* Then crafting, out of everything the cycle regenerates that the watering
   * did not take.
   *
   * This is the part that matters: you do not sit on focus waiting for a
   * crafting day. A craft hands most of its materials straight back, so the
   * same pile of herbs keeps making more potions and you spend each day's
   * focus the day it arrives. A cycle is therefore worth the focus it
   * regenerates over its whole length, not the thirty thousand it can hold at
   * any one moment. Focus only goes to waste at the end, when the crafting has
   * run out of materials and the bar is already full. */
  const grossRegen = (s.startFocus || 0) + cycleDays * focusPerDayOf(s);
  const focusBudget = Math.max(0, grossRegen - wateringPaid);

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
      ? cycle.seedsBought * costOf(plant.seedId)        // surplus is produce, above
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

  let focusLeft = focusBudget;

  /* ---- craft ---- */
  const craftLines = [];
  // What the farm could not supply and the plan had to buy. A lump sum in the
  // costs line is no use: you cannot go to market with it.
  const bought = {};
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
      // Inputs the game never hands back are consumed whole.
      const net = i.count * (i.noReturn ? 1 : 1 - batch.rrr);
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
    const lineBought = [];
    let basisIn = 0;
    for (const i of perCraft) {
      const need = i.net * crafts;
      const have = pool[i.id] || 0;
      const short = Math.max(0, need - have);
      if (short > 0) {
        const bill = short * costOf(i.id);
        buyCost += bill;                                     // fixed mode tops up
        basisIn += bill;
        const at = bought[i.id] || (bought[i.id] = { qty: 0, cost: 0 });
        at.qty += short;
        at.cost += bill;
        lineBought.push({ id: i.id, qty: short, cost: bill });
      }
      basisIn += cost0.take(i.id, Math.min(need, have), have);
      pool[i.id] = Math.max(0, have - need);
      consumed[i.id] = need;
    }
    const made = batch.made * crafts;
    add(pool, recipe.id, made);
    focusLeft -= batch.focus * crafts;
    // batch already knows the city this job crafts in, so its fee is the
    // right one for this station rather than one number for the whole plan.
    const fees = ((recipe.silver || 0) + batch.usageFee) * crafts;
    feeCost += fees;
    basisIn += fees;
    cost0.put(recipe.id, basisIn);

    craftLines.push({
      job, recipe, batch, crafts, limitedBy, byMaterial, byFocus,
      consumed, made, useFocus, inputs: perCraft, bottleneck,
      // What this job in particular had to go to market for.
      bought: lineBought,
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
  /* Held means your crafting is actually working through it. Holding back
   * every input of every job you happened to list meant that naming a recipe
   * you cannot run \u2014 one missing ingredient is enough \u2014 turned a farm's whole
   * output into stock and reported it as making nothing: on one plot of
   * foxglove and one of geese, 2.9m of profit became 236k just for typing a
   * recipe name. `consumed` carries an entry for every input whether or not
   * the job ran, so the test is the quantity, not the key. */
  const eatenByPlan = new Set();
  for (const line of craftLines) {
    for (const [id, qty] of Object.entries(line.consumed)) {
      if (qty > 0) eatenByPlan.add(id);
    }
  }
  const keepStock = s.sellSurplus !== true;

  const tax = 1 - taxRate(s);
  const sales = [];
  const stock = [];
  let revenue = 0;
  let stockValue = 0;

  let heldBasis = 0;
  for (const [id, qty] of Object.entries(pool)) {
    if (qty <= 0.0001) continue;
    const unit = ctx.priceOf(id);
    if (keepStock && eatenByPlan.has(id)) {
      /* Held for the next batch rather than sold. It stays out of revenue
       * because you did not sell it — and its cost stays out of the bill for
       * the same reason. Expensing what you are still holding is how a farm
       * that grew two million silver of herbs got reported as a loss. */
      stock.push({ id, qty, value: qty * unit * tax, cost: cost0.of(id) });
      stockValue += qty * unit * tax;
      heldBasis += cost0.of(id);
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

  /* What the cycle actually spent, less what is still sitting in the barn.
   * Every silver that entered the pool is tracked by cost0, so the two sides
   * partition exactly: what you sold is expensed, what you kept is carried. */
  const spend = farmCost + buyCost + feeCost;
  const cost = spend - heldBasis;
  const profit = revenue - cost;

  /* The honest day-by-day picture, now that the crafting has said what it
   * actually wanted. Focus only climbs to the cap where the crafting could not
   * absorb it, and only what is over the cap at the end is truly thrown away -
   * the rest you simply start the next cycle holding. */
  const focusUsed = focusBudget - focusLeft;
  const ledger = ledgerAt(focusUsed / cycleDays);
  const focusCarried = Math.min(s.focusCap, Math.max(0, focusLeft));
  const focusWasted = Math.max(0, focusLeft - s.focusCap);

  return {
    cycleDays, farmDays, farmEvery, idleDays: cycleDays - farmDays,
    farmingDays: farmDayCount(farmDays, farmEvery),
    restDays: farmDays - farmDayCount(farmDays, farmEvery),
    ledger,
    // What the whole cycle can put into crafting, spending it as it comes.
    focusBudget, focusAtCraft: focusBudget, focusLeft,
    // Left over: what you carry into the next cycle, and what the cap ate.
    focusCarried, focusWasted,
    farmLines, craftLines, sales, stock, stockValue, balance, pool, stockCap,
    // Your shopping list, biggest bill first.
    buys: Object.entries(bought)
      .map(([id, x]) => ({ id, ...x }))
      .sort((a, b) => b.cost - a.cost || b.qty - a.qty),
    // Watering asked for, paid for, and the share that decides how much of the
    // seed bonus the farm above actually earned.
    wateringPerDay, wateringAsked, wateringPaid, wateredFraction,
    wateringShortfall: ledger.shortfall,
    farmCost, buyCost, feeCost, spend, heldBasis, cost, revenue, profit,
    perDay: profit / cycleDays,
    perMonth: (profit / cycleDays) * 30,
    focusUsed,
  };
}
