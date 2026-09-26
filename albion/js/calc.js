// The profit engine. Pure: game data + prices + settings in, silver out.
// Nothing here touches storage or the DOM, so every screen agrees.

import { gatherRun } from './gather.js';

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
export const taxRate = (s, { instant = false } = {}) => {
  const setup = s.marketSetupFee ?? 2.5;
  const txn = (s.marketTransactionTax ?? 8) / (s.premium ? 2 : 1);
  /* Two charges, and only one of them is always due. The transaction tax is
   * taken out of every sale. The setup fee is what it costs to PUT an order
   * on the board, so accepting somebody else's standing offer skips it \u2014
   * which is the only way you can sell to the Black Market. gamedata.xml
   * publishes both rates and says nothing about when each applies, so that
   * split is a reading of the game rather than a line in its tables. */
  return (instant ? txn : setup + txn) / 100;
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
  // Silver is taxed once, on the way out. A spare seed is something you sell,
  // so it is credited net of tax like any other sale \u2014 not at the sticker
  // price, which is 10.5% more than the market will ever hand you.
  const seedCost = seedsBought * costOf(plant.seedId)
    - seedSurplus * priceOf(plant.seedId) * (1 - taxRate(settings));
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
  const babyCost = babiesBought * costOf(animal.babyId)
    - babySurplus * priceOf(animal.babyId) * (1 - taxRate(settings));

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

/* Two places in the game are not the other kind of place. Your own island has
 * a bench and no fields worth the name; a guild territory in the Outlands has
 * fields worth twenty times a city's and no station anybody can post a fee
 * for. So each picker asks the one question that applies to it. */
export const canFarmIn = (city) => !!city && !city.craftOnly;
export const canCraftIn = (city) => !!city && !city.farmOnly;

/** Where you craft. */
export function cityFor(settings, cityId) {
  const found = cityById(settings, cityId, 'craftCity');
  if (canCraftIn(found)) return found;
  return (settings.cities || []).find((c) => c.id === settings.craftCity && canCraftIn(c))
    || (settings.cities || []).find(canCraftIn) || found || null;
}

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
  if (canFarmIn(found)) return found;
  const fallback = (settings.cities || []).find((c) => c.id === settings.farmCity);
  return (canFarmIn(fallback) ? fallback : null)
    || (settings.cities || []).find(canFarmIn) || found || null;
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
export function cityBonus(city, category, settings, { refine = false } = {}) {
  /* A refining bench and a crafting bench are two different numbers. The five
   * royal cities, Caerleon and Brecilien give 18 either way, but the three
   * Rests give 18 to a crafter and only 15 to a refiner, which is the whole
   * reason the game keeps <refiningbonus> apart from <craftingbonus>. The
   * specialty on top is the same table for both, and it is +40% for the city
   * that specialises in a resource family against +15% for a weapon. */
  const base = Number((refine ? city?.refineBase : city?.craftBase)
    ?? city?.craftBase ?? settings.cityBaseBonus ?? 0);
  const specialty = Number(city?.craftSpecialties?.[category]) || 0;
  return { base, specialty, specialises: specialty > 0, total: base + specialty };
}

/**
 * What a recipe actually makes.
 *
 * Almost always itself. The exception is a recipe that shares its output with
 * another: enchanted rock refines into ordinary stone blocks, two, four or
 * eight at a time, so those rows carry an id of their own and say here what
 * comes off the bench. Price and mastery follow the output, never the id.
 */
export const outputOf = (recipe) => recipe?.out || recipe?.id;

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
  const bonus = cityBonus(city, recipe.category, settings, { refine: !!recipe.refine });
  const spec = Number.isFinite(specLevel)
    ? specLevel : specFor(settings, outputOf(recipe));
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
  const revenue = made * priceOf(outputOf(recipe)) * (1 - taxRate(settings));
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

/* ----------------------------------------------------------- quality --- */

export const QUALITY_LEVELS = [1, 2, 3, 4, 5];

/**
 * Quality points for one item: what the destiny board and focus add up to.
 *
 * The same nodes that cheapen focus also raise quality, in the same shape and
 * matched the same way \u2014 achievements.xml carries both an
 * `craftingfocuscostreduction` and an `itemcraftquality` bonus on 292 of the
 * 317 crafting nodes. A mastery gives 0.75 a level and a specialisation 6 a
 * level on its own item, so a maxed specialist is carrying 675 points before
 * focus adds its 50.
 *
 * Nothing below tier 4 gets any of it: every quality rule in the file is
 * written mintier="4".
 */
export function qualityPoints(itemId, settings) {
  const levels = settings.nodeLevels || {};
  const nodes = settings.focusNodes || [];
  const parts = [];
  let total = 0;
  for (const node of nodes) {
    const level = Number(levels[node.id]) || 0;
    if (level <= 0 || !node.qualityRules) continue;
    for (const rule of node.qualityRules) {
      if (!ruleCovers(rule, itemId)) continue;
      const points = level * rule.bonus;
      total += points;
      parts.push({ node, level, bonus: rule.bonus, points });
    }
  }
  if (settings.useFocus) {
    const bonus = settings.focusQualityBonus ?? 50;
    total += bonus;
    parts.push({ node: { id: '__focus', name: 'Crafting with focus' }, points: bonus });
  }
  parts.sort((a, b) => b.points - a.points);
  return { total, parts };
}

/**
 * What comes off the bench, as a share per quality level.
 *
 * Two of the three numbers here are the game's. gamedata.xml publishes the
 * table a craft rolls on \u2014 689 plain, 250 good, 50 outstanding, 10 excellent,
 * 1 masterpiece, out of a thousand \u2014 and it publishes the points that focus
 * and the destiny board add. What it does NOT publish anywhere is how the
 * points move the table.
 *
 * So this is a reading, not a rule: the points are extra weight on everything
 * above plain, split between those four in the proportions the base table
 * already has. Plain keeps its 689 and the pool grows underneath it, which is
 * the only composition that stays sane at the top end \u2014 subtracting the
 * points from plain instead sends it negative for any maxed specialist.
 *
 * It is shown on screen as a reading and it is editable, because your own
 * crafting station will tell you the truth about your own character and this
 * cannot.
 */
export function qualityMix(points, settings, maxQuality = 5) {
  const table = settings.quality?.weights
    || { 1: 689, 2: 250, 3: 50, 4: 10, 5: 1 };
  /* Some things can never come out above plain. items.xml pins 72 recipes
   * at maxqualitylevel="1" - every tool and every piece of gathering gear -
   * and quoting those an uplift is money that cannot be made. */
  const cap = Math.max(1, Math.min(5, Number(maxQuality) || 5));
  if (cap <= 1) return { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0 };
  const base = QUALITY_LEVELS.map((q) => (q <= cap ? Number(table[q]) || 0 : 0));
  const upper = base.slice(1).reduce((a, b) => a + b, 0);
  const add = Math.max(0, Number(points) || 0);
  const weights = base.map((w, i) => (i === 0 || upper <= 0 ? w : w + add * (w / upper)));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const mix = {};
  QUALITY_LEVELS.forEach((q, i) => { mix[q] = weights[i] / total; });
  return mix;
}

/** The mix a plan is really using: yours if you set one, the model's if not. */
export function mixFor(itemId, settings, maxQuality = 5) {
  const cap = Math.max(1, Math.min(5, Number(maxQuality) || 5));
  const points = qualityPoints(itemId, settings).total;
  const own = settings.qualityMix;
  if (cap > 1 && own && QUALITY_LEVELS.some((q) => Number(own[q]) > 0)) {
    const kept = QUALITY_LEVELS.filter((q) => q <= cap);
    const total = kept.reduce((t, q) => t + (Number(own[q]) || 0), 0) || 1;
    const mix = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const q of kept) mix[q] = (Number(own[q]) || 0) / total;
    return { mix, source: 'yours', points, cap };
  }
  return { mix: qualityMix(points, settings, cap), source: 'model', points, cap };
}

/**
 * What one comes to on average, given how the output is spread across the
 * quality levels and what each level fetches.
 *
 * A level nobody has priced is not free, it is unknown \u2014 so its share falls
 * back to the plain price rather than to zero, and the caller is told which
 * levels are guessed so it can say so.
 */
export function blendedPrice(itemId, mix, priceAt) {
  const plain = priceAt(itemId, 1);
  let value = 0;
  const guessed = [];
  for (const q of QUALITY_LEVELS) {
    const share = Number(mix[q]) || 0;
    if (share <= 0) continue;
    const at = priceAt(itemId, q);
    if (!at && q > 1) guessed.push(q);
    value += share * (at || plain);
  }
  return { value, guessed, plain };
}

/**
 * What one reroll at the repair station is worth, in silver.
 *
 * The game publishes the whole outcome table and the app was ignoring it. Two
 * things in it are worth knowing before you ever look at a price. Every
 * below-diagonal weight is zero, so a reroll can only move an item UP. And
 * from Normal the stay-weight is zero as well, which means rerolling a plain
 * item ALWAYS improves it - four times in five to Good, and one in two
 * thousand straight to Masterpiece.
 *
 * What the station charges for it is published nowhere: no rerollable item
 * carries an itemvalue and <RepairBuilding> gives only a time. So this never
 * quotes a fee. It works out what the reroll is WORTH from your own
 * per-quality prices and hands you the number to hold the station's price
 * against - which is the honest shape for a cost the files do not carry.
 */
export function rerollQuality(itemId, quality, { settings, priceAt, instant = false }) {
  const table = settings?.quality?.rerollWeights?.[String(quality)];
  // A Masterpiece has no row, because a Masterpiece cannot be rerolled.
  if (!table) return null;
  const total = Object.values(table).reduce((t, w) => t + Number(w), 0);
  if (!(total > 0)) return null;

  const now = priceAt(itemId, quality);
  const missing = [];
  const outcomes = [];
  let expected = 0;
  for (const q of QUALITY_LEVELS) {
    const share = (Number(table[String(q)]) || 0) / total;
    if (share <= 0) continue;
    const at = priceAt(itemId, q);
    if (!at) missing.push(q);
    outcomes.push({ quality: q, share, price: at });
    expected += share * at;
  }
  // The fee is paid in silver whatever happens, so the gain it has to beat is
  // what actually reaches you after the market takes its cut.
  const keep = 1 - taxRate(settings, { instant });
  return {
    quality,
    outcomes,
    now,
    expected,
    // What one reroll adds to the sale, after tax. Also the most the station
    // can charge before it stops being worth doing.
    uplift: (expected - now) * keep,
    // Never negative by construction, but a missing price can hide that.
    missing,
    // The odds alone, for a screen that wants to say what happens rather than
    // what it is worth.
    improves: outcomes.filter((o) => o.quality > quality)
      .reduce((t, o) => t + o.share, 0),
  };
}

/* -------------------------------------------------------- the haul ----- */

/**
 * Where a given craft is best done.
 *
 * A city gives +18 to everything and +15 more to the few categories it
 * specialises in, or +40 to a refining category. Those are different cities:
 * bars are smelted in Thetford and swords are forged in Lymhurst, so a sword
 * made of your own bars is two cities whether or not you admit it.
 */
export function bestCityFor(category, settings) {
  const cities = settings.cities || [];
  let best = null;
  for (const c of cities) {
    if (!canCraftIn(c)) continue;
    if (c.craftOnly === true && !c.craftSpecialties) continue;
    const b = cityBonus(c, category, settings);
    if (!best || b.total > best.total) best = { city: c, total: b.total };
  }
  return best?.city || cityFor(settings);
}

/** What one of these weighs, where the game says. */
export const weightOf = (id, settings) =>
  Number(settings.items?.[id]?.weight) || 0;

/**
 * What a pile of things weighs, and what moving it costs you.
 *
 * Weight is the game's; what you can carry is not \u2014 that is your mount and
 * your bags, which the dumps do not publish \u2014 and neither is what a trip is
 * worth to you. So the load is worked out and the rate is yours: leave it at
 * zero and you are told the weight and the number of trips without a silver
 * figure being invented for them.
 */
export function haulOf(lines, settings) {
  const perTrip = Math.max(0, Number(settings.carryWeight) || 0);
  const rate = Math.max(0, Number(settings.haulSilverPerWeight) || 0);
  let weight = 0;
  const items = [];
  for (const { id, qty } of lines) {
    const each = weightOf(id, settings);
    const w = each * (Number(qty) || 0);
    if (w <= 0) continue;
    weight += w;
    items.push({ id, qty, each, weight: w });
  }
  items.sort((a, b) => b.weight - a.weight);
  const trips = perTrip > 0 ? Math.ceil(weight / perTrip) : null;
  return { weight, trips, perTrip, rate, cost: weight * rate, items };
}

/**
 * What has to move, and where to.
 *
 * Every step happens in some city. A step whose output feeds a step in a
 * different city means carrying that output between the two, and so does
 * anything you buy somewhere other than where you use it. This lists the legs
 * so the weight is on screen rather than left as an exercise.
 */
function haulLegs(steps, bought, settings) {
  const madeIn = new Map();
  for (const s of steps) madeIn.set(outputOf(s.recipe), s.cityId);

  const legs = new Map();
  const add = (from, to, id, qty) => {
    if (!from || !to || from === to || !(qty > 0)) return;
    const key = `${from}>${to}`;
    const at = legs.get(key) || { from, to, items: new Map() };
    at.items.set(id, (at.items.get(id) || 0) + qty);
    legs.set(key, at);
  };

  for (const step of steps) {
    for (const i of step.batch.inputs) {
      const qty = i.net * step.crafts;
      // Something you made elsewhere has to travel; something you bought is
      // assumed bought where it is used, because that is what a market is.
      const from = madeIn.get(i.id);
      if (from) add(from, step.cityId, i.id, qty);
    }
  }

  return [...legs.values()].map((leg) => {
    const lines = [...leg.items.entries()].map(([id, qty]) => ({ id, qty }));
    return { from: leg.from, to: leg.to, ...haulOf(lines, settings) };
  }).sort((a, b) => b.weight - a.weight);
}

/* ------------------------------------------------- crafting to order ---- */

/**
 * What it costs to make a run of something, and what you get back for it.
 *
 * This is the whole profit and loss for one batch, with no farm anywhere in
 * it: you decide what to buy and what to make yourself, and it tells you the
 * shopping list, the focus, the station's cut and what is left. It is the
 * same engine whether the thing is a potion, a sword or a stack of steel
 * bars \u2014 the game costs all three the same way, and the only difference is
 * which list the recipe came out of.
 *
 * `make` is the set of input ids you would rather craft than buy. Anything
 * not in it is bought, which is the honest default: most people buy their
 * bars. Putting an id in it walks one level deeper and buys ITS inputs
 * instead, and so on down, so "refine my own ore" and "buy the bars" are the
 * same question asked at different depths.
 *
 * Returns fractional crafts rather than rounding. You are pricing a run, not
 * pressing the button, and rounding 812.4 up to 813 quietly adds a craft's
 * worth of focus to every answer.
 */
export function craftPnL(recipeId, {
  recipeOf, qty = 1, make = new Set(),
  /* Which of the raw materials you are going to go out and gather rather
   * than buy. A gathered leaf costs no silver; it costs hours, and the run
   * reports them separately, because an hour is not a number this app is
   * willing to turn into silver on your behalf. */
  gather = new Set(),
  priceOf, costOf = priceOf, sellPriceOf = priceOf,
  // What each quality of the finished thing fetches, and how the run is
  // spread across them. Leave them out and everything is plain, which is
  // right for a potion and wrong for a sword.
  sellPriceAt = null, sellMix = null,
  settings, cityId, specLevel, sellInstant = false, maxDepth = 6,
  // Where each step happens. Give it a function and every step can sit in
  // the city that is best for its own category, which is what anybody
  // refining their own bars actually does.
  cityOf = null,
}) {
  const top = recipeOf(recipeId);
  if (!top) return null;
  const placeOf = (recipe) => (cityOf ? cityOf(recipe) : cityId);

  const steps = [];
  const stepBy = new Map();      // the same bar can be wanted by two things
  const bought = {};
  const missing = new Set();
  // What was gathered rather than bought, and what that cost in time.
  const gathered = {};
  const gatherWant = {};
  const byproducts = {};
  // The pies and potions the run had to keep up to earn the yield it claimed.
  const kit = {};
  // And the journals its fame filled along the way.
  const journals = {};
  const assumed = new Set();
  let gatherSwingSeconds = 0;
  let gatherHours = 0;
  let gatherFame = 0;
  let gatherWeight = 0;
  let focus = 0;
  let fees = 0;
  let buyCost = 0;

  /* What you have to go and buy, which is not simply what the run consumes.
   *
   * The station takes the FULL recipe amount every time you press the button
   * and hands the return back afterwards - "Saved {0} x{1}!" - so the returns
   * fund later crafts but never the first one. For one batch of Major Healing
   * Potion that is 72 foxglove in your bags however good your return rate is,
   * even though the batch only really costs you 40.7 of them.
   *
   * So: buy enough to start (one craft's full amount) and enough to finish
   * (what the whole run consumes), whichever is larger. Anything over is
   * float that comes back out at the end and is still yours, so the cost
   * charged below stays the net figure. */
  const buy = (id, net, perCraft, bill) => {
    if (!(net > 0) && !(perCraft > 0)) return;
    const at = bought[id] || (bought[id] = {
      id, qty: 0, net: 0, perCraft: 0, cost: 0, unit: costOf(id),
    });
    at.net += net;
    at.perCraft = Math.max(at.perCraft, perCraft);
    at.qty = Math.max(at.net, at.perCraft);
    at.cost += bill;
    buyCost += bill;
  };

  /* One item, some number of them wanted. Either you buy them, or you make
   * them and the question moves down to what they are made of. */
  const need = (itemId, units, perCraft, depth, seen) => {
    if (!(units > 0)) return null;
    const recipe = depth < maxDepth && make.has(itemId) && !seen.has(itemId)
      ? recipeOf(itemId) : null;
    if (!recipe) {
      if (gather.has(itemId)) {
        /* Gathered. The station still wants a full batch in your bags, so
         * the amount is the same as if you had bought it - it is the bill
         * that goes to zero, and the time that does not. A run with a
         * gathered leaf and no measured rate is honest about costing unknown
         * hours in exactly the way a run with no price is honest about
         * costing unknown silver.
         *
         * Only the amount is tallied here. The same log can be wanted by two
         * branches of the same run, and gathering for one branch and then
         * again for the other is not what you would do - you would go out
         * once for the lot. So the runs are worked out after the whole tree
         * is walked, from the totals. */
        const can = gatherRun(itemId, { qty: 1, settings });
        /* A run the game would refuse - your tool is two tiers under the node,
         * or you asked for a grade that node never rolls - is recorded so the
         * screen can say why, and then priced as bought. Billing it at zero
         * because it was impossible would be a free lunch. */
        if (can && can.impossible) gathered[itemId] = can;
        if (can && !can.impossible) {
          gatherWant[itemId] = (gatherWant[itemId] || 0) + units;
          buy(itemId, units, perCraft, 0);
          return null;
        }
      }
      const unit = costOf(itemId);
      if (!unit) missing.add(itemId);
      buy(itemId, units, perCraft, units * unit);
      return null;
    }

    const where = placeOf(recipe);
    const batch = craftBatch(recipe, {
      priceOf, costOf, settings, cityId: where, specLevel,
    });
    // You cannot press the button four fifths of a time. A batch is a batch,
    // so a run is always a whole number of them.
    const crafts = Math.ceil(units / (batch.made || 1) - 1e-9);
    focus += batch.focus * crafts;
    const fee = ((recipe.silver || 0) + batch.usageFee) * crafts;
    fees += fee;

    const at = stepBy.get(recipe.id);
    if (at) {
      at.crafts += crafts;
      at.made += units;
      at.focus += batch.focus * crafts;
      at.fee += fee;
    } else {
      const step = {
        recipe, batch, crafts, made: units, depth, cityId: where,
        focus: batch.focus * crafts, fee,
      };
      stepBy.set(recipe.id, step);
      steps.push(step);
    }

    // Down a level. `seen` stops a recipe that somehow names itself from
    // recursing for ever; the tier ladder in refining (a T5 bar eats a T4
    // bar) is not a cycle and walks all the way down to raw ore.
    const below = new Set(seen).add(itemId);
    for (const i of batch.inputs) {
      need(i.id, i.net * crafts, i.count, depth + 1, below);
    }
    return batch;
  };

  const topCity = placeOf(top);
  const topBatch = craftBatch(top, {
    priceOf, costOf, settings, cityId: topCity, specLevel,
  });
  /* Whole batches. Major Healing Potion comes five at a time, so asking for
   * seven means two batches and ten potions - and saying "1.4 crafts" was
   * quoting a thing the game will not let you do. */
  const perBatch = topBatch.made || 1;
  const crafts = Math.max(1, Math.ceil(qty / perBatch - 1e-9));
  const made = crafts * perBatch;
  focus += topBatch.focus * crafts;
  const topFee = ((top.silver || 0) + topBatch.usageFee) * crafts;
  fees += topFee;
  const topStep = {
    recipe: top, batch: topBatch, crafts, made, depth: 0, cityId: topCity,
    focus: topBatch.focus * crafts, fee: topFee, target: true,
  };
  stepBy.set(top.id, topStep);
  steps.push(topStep);
  for (const i of topBatch.inputs) {
    need(i.id, i.net * crafts, i.count, 1, new Set([top.id]));
  }

  /* One trip per resource, for everything the run wanted of it. Working it
   * out from the total rather than branch by branch matters for more than
   * tidiness: the grade odds are per harvest, so two runs of five hundred and
   * one run of a thousand do not round to the same pile of enchanted logs. */
  for (const [itemId, want] of Object.entries(gatherWant)) {
    const run = gatherRun(itemId, { qty: want, settings });
    if (!run || run.impossible) continue;
    gathered[itemId] = run;
    gatherSwingSeconds += run.swingSeconds;
    gatherHours = run.hours === null ? null
      : (gatherHours === null ? null : gatherHours + run.hours);
    gatherFame += run.fame;
    gatherWeight += run.weight;
    /* What the node handed you that you were not after. A twentieth of every
     * plain harvest comes up enchanted, and an enchanted log is worth a
     * multiple of a plain one, so this is real silver rather than a curiosity
     * - it just is not silver from the recipe. */
    for (const row of run.byproducts) {
      /* priceOf and never sellPriceOf: what this run sells its output into is
       * a choice about the output, and the Black Market makes no offer at all
       * on a log. Pricing them at the sale would have silently zeroed every
       * one of them on a Black Market run. */
      const unit = priceOf(row.id);
      if (!unit) continue;
      byproducts[row.id] = {
        id: row.id,
        qty: (byproducts[row.id]?.qty || 0) + row.qty,
        unit,
        value: (byproducts[row.id]?.value || 0) + row.qty * unit,
      };
    }
    /* The kit is not free. A pie lasts half an hour and a gathering potion
     * under a minute, so an afternoon of holding the bonuses this run assumed
     * is four pies and a hundred and thirty one potions - real silver, spent
     * to make the yield figures above true. Only countable once a run has
     * been timed, because it is a question about wall-clock and not swings;
     * before that it is zero and the screen says the kit is uncosted rather
     * than pretending it was free. */
    for (const [id, qty] of [[run.foodId, run.pies], [run.potionId, run.potions]]) {
      if (!id || !(qty > 0)) continue;
      const unit = costOf(id);
      if (!unit) { missing.add(id); continue; }
      kit[id] = {
        id,
        qty: (kit[id]?.qty || 0) + qty,
        unit,
        cost: (kit[id]?.cost || 0) + qty * unit,
      };
    }
    /* The journals the run filled. Silver a gathering trip earns that has
     * nothing to do with the resources: you buy the books empty, the fame you
     * were earning anyway fills them, and full ones sell. The empty has a
     * published station price, so it has a floor cost even with no market
     * quote - the same rule seeds already live by. The full one is a market
     * item like any other, and unpriced it is a gap rather than a zero. */
    const j = run.journal;
    if (j && j.filled > 0.001) {
      const station = j.silver;
      const listed = costOf(j.emptyId);
      const unitCost = listed > 0 ? Math.min(listed, station) : station;
      const sells = sellPriceOf(j.fullId);
      if (!sells) missing.add(j.fullId);
      journals[j.fullId] = {
        emptyId: j.emptyId,
        fullId: j.fullId,
        filled: (journals[j.fullId]?.filled || 0) + j.filled,
        unitCost,
        unitPrice: sells,
        cost: (journals[j.fullId]?.cost || 0) + j.filled * unitCost,
        value: (journals[j.fullId]?.value || 0) + j.filled * sells,
      };
    }
    for (const a of run.assumed) assumed.add(a);
  }
  const kitCost = Object.values(kit).reduce((t, k) => t + k.cost, 0);
  const journalCost = Object.values(journals).reduce((t, x) => t + x.cost, 0);
  const journalValue = Object.values(journals).reduce((t, x) => t + x.value, 0);

  /* What one is worth. With a quality mix that is the average across the
   * levels the run actually produces, which on equipment is most of the
   * answer: a masterpiece sells for a multiple of a plain one, and pricing
   * the whole run as plain was leaving that on the table. */
  const priceAt = sellPriceAt || ((id) => sellPriceOf(id));
  // What comes off the bench, which for an enchanted-rock row is plain stone
  // blocks rather than the id the row is filed under.
  const outId = outputOf(top);
  const blend = sellMix
    ? blendedPrice(outId, sellMix, priceAt)
    : { value: sellPriceOf(outId), guessed: [], plain: sellPriceOf(outId) };
  const unitPrice = blend.value;
  if (!blend.plain) missing.add(outId);
  const tax = taxRate(settings, { instant: sellInstant });
  const gross = made * unitPrice;
  /* The enchanted resources that fell out of the gathering, sold on the open
   * market. Never at the Black Market, whatever the run's own sale is: it
   * takes equipment and nothing else. Its own line, because it is not what
   * the recipe earned and rolling it into the margin would flatter the
   * recipe. */
  const byproductValue = Object.values(byproducts).reduce((t, b) => t + b.value, 0);
  const byproductRevenue = byproductValue * (1 - taxRate(settings));
  // A full journal is sold on the open market like the enchanted resources,
  // and never at the Black Market, which takes equipment and nothing else.
  const journalRevenue = journalValue * (1 - taxRate(settings));
  const revenue = gross * (1 - tax) + byproductRevenue + journalRevenue;
  const cost = buyCost + fees + kitCost + journalCost;
  const profit = revenue - cost;

  return {
    recipe: top,
    // What you asked for, and what a whole number of batches actually gives
    // you. They differ whenever the ask is not a multiple of the batch size.
    asked: qty,
    qty: made,
    perBatch,
    crafts,
    sellInstant,
    unitPrice,
    // The quality side of the sale, so a screen can show the mix, the uplift
    // over selling it all plain, and which levels it had to guess at.
    mix: sellMix,
    plainPrice: blend.plain,
    qualityUplift: blend.plain > 0 ? unitPrice / blend.plain - 1 : 0,
    qualityGuessed: blend.guessed,
    // Deepest first, so the list reads in the order you would actually do it.
    steps: steps.slice().sort((a, b) => b.depth - a.depth || a.recipe.id.localeCompare(b.recipe.id)),
    buys: Object.values(bought).sort((a, b) => b.cost - a.cost || b.qty - a.qty),
    // Which cities this run touches, and what has to be carried into each.
    // A step done somewhere else is a step whose output you have to move.
    legs: haulLegs(steps, bought, settings),
    focus, fees, buyCost, cost,
    /* The gathering side of the same run. `hours` is null when nothing has
     * been measured: the swing floor is exact and the rest is yours. */
    gathered,
    gatherSwingSeconds,
    gatherHours: Object.keys(gathered).length ? gatherHours : 0,
    gatherFame,
    gatherWeight,
    // The enchanted resources the run picked up along the way, and what they
    // fetch. Counted in revenue above, listed here so a screen can say so.
    byproducts: Object.values(byproducts).sort((a, b) => b.value - a.value),
    byproductValue,
    byproductRevenue,
    // What holding the kit's bonuses cost, and what it was spent on.
    kitItems: Object.values(kit).sort((a, b) => b.cost - a.cost),
    kitCost,
    // The books the run's own fame filled, what the empties cost and what the
    // full ones fetch. Both sides are in the profit above.
    journals: Object.values(journals),
    journalCost,
    journalValue,
    journalRevenue,
    // Everything in this answer that came from you rather than from the game.
    assumed: [...assumed],
    gross,
    tax,
    taxPaid: (gross + byproductValue + journalValue) - revenue,
    revenue,
    profit,
    /* Margin is the whole activity's: profit over everything that came in,
     * byproducts included, because they came in. Per item is the recipe's
     * own, and deliberately not - a plank is not worth more because an
     * enchanted log turned up on the way to it, and quoting it as if it were
     * would flatter the recipe to anyone comparing two of them. */
    margin: revenue > 0 ? profit / revenue : 0,
    perItem: made > 0
      ? (profit - byproductRevenue - journalRevenue + journalCost) / made : 0,
    silverPerFocus: focus > 0 ? profit / focus : null,
    // A missing price reads as free on the way in and worthless on the way
    // out, so a run with any of these is not a number, it is a gap.
    missing: [...missing],
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

/**
 * A cycle is a list of days, and each day is one of three things: you go out
 * and farm, you stay away and let focus bank, or you stand at the station and
 * craft. "Farm N of C days, every other day" was only ever a way of writing
 * that list down, and it could not write down "farm Monday to Wednesday, rest
 * Thursday, craft the weekend". The list can.
 */
export const DAY_MODES = ['farm', 'rest', 'craft'];

/** The day list a length, a farming stretch and a rhythm describe. */
export function scheduleFrom({ cycleDays, farmDays, farmEvery = 1 } = {}) {
  const days = Math.max(1, Math.round(cycleDays) || 14);
  const farm = Math.max(0, Math.min(days, Math.round(farmDays ?? days) || 0));
  const every = Math.max(1, Math.round(farmEvery) || 1);
  const out = [];
  for (let day = 1; day <= days; day++) {
    out.push(day > farm ? 'craft' : (day - 1) % every === 0 ? 'farm' : 'rest');
  }
  return out;
}

/**
 * The day list behind any description of a cycle: an explicit list wins, and
 * the three numbers are only read when there is none. Always a fresh copy.
 */
export function scheduleOf(o = {}) {
  const list = Array.isArray(o.days) && o.days.length ? o.days
    : Array.isArray(o.schedule) && o.schedule.length ? o.schedule : null;
  if (list) return list.map((d) => (DAY_MODES.includes(d) ? d : 'farm'));
  return scheduleFrom(o);
}

/** The shape of a day list in the old three numbers, for anything still reading them. */
export function shapeOf(days) {
  const last = days.lastIndexOf('farm');
  return {
    cycleDays: days.length,
    farmDays: last + 1,
    farmEvery: 1,
    farmingDays: days.filter((d) => d === 'farm').length,
    restDays: days.filter((d) => d === 'rest').length,
    craftDays: days.filter((d) => d === 'craft').length,
  };
}

/** Is `day` one of the days you actually go out and farm? */
export function isFarmDay(day, farmDays, farmEvery = 1) {
  if (Array.isArray(farmDays)) return farmDays[day - 1] === 'farm';
  const every = Math.max(1, Math.round(farmEvery) || 1);
  return day <= farmDays && (day - 1) % every === 0;
}

/** How many days of a farming phase of this shape you are actually out there. */
export function farmDayCount(farmDays, farmEvery = 1) {
  if (Array.isArray(farmDays)) return farmDays.filter((d) => d === 'farm').length;
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
export function harvestsFor(cycle, opts = {}) {
  if (!cycle) return 0;
  const days = scheduleOf(opts);
  const cadenceHours = opts.cadenceHours || 24;
  /* You harvest no faster than the thing grows and no faster than you log in.
   * Whichever is slower sets the gap between harvests: a 44-hour cow does not
   * give you a calf a day just because you visited. */
  const gap = Math.max(
    Math.ceil(cadenceHours / 24),
    Math.ceil(cycle.hours / 24),
  );
  /* Walk the farm days. The first one harvests what the last cycle left
   * growing; after that a farm day only harvests once a growth has had time
   * to finish since the last one, and the days you are not there still count
   * on the clock. Farming every other day with a one-day crop is half the
   * harvests; farming every day with a two-day crop is also half. */
  let count = 0;
  let last = -Infinity;
  days.forEach((mode, i) => {
    const day = i + 1;
    if (mode !== 'farm') return;
    if (day - last >= gap) { count++; last = day; }
  });
  /* Then the ceiling the calendar itself sets: a thing slower than the whole
   * cycle reports the fraction of a growth it really finishes, not a whole
   * one. */
  return Math.min(count, days.length / gap);
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
export function focusLedger(opts) {
  const {
    perDay, cap, start = 0, wateringPerDay = 0, craftingPerDay = 0,
  } = opts;
  const sched = scheduleOf(opts);

  /* Two passes. The first pays only the watering, day by day, which says what
   * each farm day actually spends. From that, walking backwards, comes the
   * reserve: how much has to be in hand at the end of each day so that the
   * watering still to come can be paid. The second pass then crafts with
   * everything above the reserve, on the days you craft at all. Without the
   * reserve, crafting on day 3 ate the bank a day-5 watering was counting on,
   * and the farm above was priced on watering the ledger below never paid. */
  const water = [];
  {
    let focus = Math.min(cap, Math.max(0, start));
    for (let i = 0; i < sched.length; i++) {
      focus = Math.min(cap, focus + perDay);
      const spent = sched[i] === 'farm' ? Math.min(focus, wateringPerDay) : 0;
      focus -= spent;
      water.push(spent);
    }
  }
  const reserve = new Array(sched.length).fill(0);
  for (let i = sched.length - 2; i >= 0; i--) {
    reserve[i] = Math.min(cap, Math.max(0, water[i + 1] + reserve[i + 1] - perDay));
  }

  let focus = Math.min(cap, Math.max(0, start));
  let wasted = 0;
  let shortfall = 0;        // watering you planned but could not pay for
  let spentWatering = 0;
  let spentCrafting = 0;
  let cappedOn = null;
  const days = [];

  sched.forEach((mode, i) => {
    const day = i + 1;
    const before = focus;
    focus = Math.min(cap, focus + perDay);
    const gained = focus - before;
    const lost = perDay - gained;
    wasted += lost;
    if (focus >= cap && cappedOn === null) cappedOn = day;

    const farming = mode === 'farm';
    // You cannot water with focus you do not have.
    const spent = farming ? Math.min(focus, wateringPerDay) : 0;
    if (farming) shortfall += wateringPerDay - spent;
    focus -= spent;
    spentWatering += spent;

    // A rest day is a rest day: nothing is spent, the bar climbs.
    const craft = mode === 'rest' ? 0
      : Math.max(0, Math.min(focus - reserve[i], craftingPerDay));
    focus -= craft;
    spentCrafting += craft;

    days.push({
      day, mode, farming, gained, wasted: lost, spent, craft, focus,
      resting: mode === 'rest',
    });
  });
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
  /* The cycle is a list of days. An explicit list on the settings wins; the
   * three numbers that used to describe one are read only when there is none,
   * so a plan saved before the list existed still means what it meant. */
  const days = scheduleOf(s);
  const shape = shapeOf(days);
  const cycleDays = days.length;
  const { farmDays } = shape;
  // Kept for what still reads it; the list is what is actually farmed on.
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

  const harvestsOf = (cycle) => harvestsFor(cycle, { days, cadenceHours: cadence });

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
  const careDays = Math.max(1, shape.farmingDays);
  const wateringPerDay = careTotal / careDays;

  const ledgerAt = (craftingPerDay) => focusLedger({
    days,
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
  /* What that comes to is what the ledger can put into crafting when the
   * crafting wants everything: all the regeneration the watering does not
   * take, less what the cap throws away on a run of rest days. A cycle that
   * crafts every day never caps, so this is simply the regeneration less the
   * watering, as it always was; one that rests a week banks to the cap and
   * then wastes what comes after, and that waste is not a budget. */
  const open = ledgerAt(Infinity);
  const focusBudget = Math.max(0, open.spentCrafting);
  const capWaste = open.wasted;

  // Pass two: the farm as it really runs.
  const pool = {};
  const cost0 = makeLedgerOfCost();
  const farmLines = [];
  let farmCost = 0;

  /* The shopping list. Seeds, babies and feed are bought before a single
   * craft runs, so they belong on it too \u2014 a farmer's only certain purchase
   * was the one thing the list left out. They stay out of buyCost, which
   * counts crafting purchases, because farmCost already carries this silver. */
  const bought = {};
  const buy = (id, qty, bill, forWhat = 'craft') => {
    if (!(qty > 0)) return;
    const at = bought[id] || (bought[id] = { qty: 0, cost: 0, forFarm: false });
    at.qty += qty;
    at.cost += bill;
    if (forWhat === 'farm') at.forFarm = true;
  };

  /* What you already hold. Seeds left from the last round, calves that came
   * back, a stack of foxglove, a crate of potions: it goes on the pile before
   * anything is planted, with whatever it cost you \u2014 nothing, if you typed
   * it in; what it left the last cycle carrying, if the app carried it in.
   * Anything the plan does not use is sold at the end like any surplus. */
  const stockIn = {};
  let openingBasis = 0;
  let openingValue = 0;
  for (const [id, at] of Object.entries(ctx.stock || {})) {
    const qty = Number(at?.qty ?? at) || 0;
    if (!(qty > 0)) continue;
    const basis = Math.max(0, Number(at?.cost) || 0);
    add(pool, id, qty);
    cost0.put(id, basis);
    stockIn[id] = { qty, cost: basis };
    openingBasis += basis;
    openingValue += qty * ctx.priceOf(id) * (1 - taxRate(s));
  }

  /* Take from the pile first and buy the rest. The basis that leaves with it
   * is whatever share of what it cost you those units carried. */
  const draw = (id, need) => {
    const have = pool[id] || 0;
    const fromStock = Math.min(need, have);
    const basis = cost0.take(id, fromStock, have);
    pool[id] = Math.max(0, have - fromStock);
    const short = Math.max(0, need - fromStock);
    return { fromStock, short, basis, bill: short * costOf(id) };
  };

  /* Plants before animals, so a crop grown in this plan is on the pile by
   * the time an animal wants to eat it. Whole-cycle harvest feeding
   * whole-cycle eating is the same simplification the crafting makes. */
  const rows = [
    ...plan.plots.filter((r) => data.plants.some((p) => p.id === r.itemId)),
    ...plan.plots.filter((r) => !data.plants.some((p) => p.id === r.itemId)),
  ];
  for (const row of rows) {
    const cycle = cycleFor(row, wateredFraction);
    if (!cycle) continue;
    const plant = cycle.kind === 'plant' ? cycle.ref : null;

    const harvests = harvestsOf(cycle);
    const plots = row.count || 0;
    const tiles = tilesOf(row);
    const scale = tiles * harvests;

    /* What this row has to be given before it gives anything back. Seeds
     * and calves are drawn from the pile first \u2014 a held seed is a seed you
     * do not buy \u2014 and only then does the row's own surplus land, or a row's
     * watered surplus would be paying for its own seed within one growth. */
    const took = {};
    let bill = 0;       // cash, to the market
    let basis = 0;      // what the units off the pile were carrying
    const take = (id, need) => {
      const got = draw(id, need);
      took[id] = got.fromStock;
      bill += got.bill;
      basis += got.basis;
      buy(id, got.short, got.bill, 'farm');
    };
    if (plant) {
      take(plant.seedId, cycle.seedsBought * scale);
    } else {
      take(cycle.feedId, cycle.plantsNeeded * scale);
      if (cycle.kind === 'animal') take(cycle.ref.babyId, cycle.babiesBought * scale);
    }
    const cost = bill + basis;

    const { itemId, perTile: perHarvest } = rowOutput(row, cycle, data);
    const produced = perHarvest * tiles * harvests;
    add(pool, itemId, produced);

    /* Seeds and calves that came back beyond what was replanted or re-penned
     * are stock, not a discount. They go on the pile with a cost basis of
     * zero and leave through the sales list, where the market takes its tax
     * like it does on everything else. Babies used to be netted off the cost
     * instead, untaxed and invisible: a watered T8 ox leaves 190k of spare
     * oxen a tile that never appeared on any screen. */
    if (plant && cycle.seedSurplus > 0) {
      add(pool, plant.seedId, cycle.seedSurplus * tiles * harvests);
    }
    if (cycle.kind === 'animal' && cycle.babySurplus > 0) {
      add(pool, cycle.ref.babyId, cycle.babySurplus * tiles * harvests);
    }

    /* The whole bill lands on the crop \u2014 what was bought and the basis of
     * what came off the pile \u2014 and surplus seeds are a by-product carrying
     * nothing, which is why they read as pure profit when sold. */
    farmCost += bill;
    cost0.put(itemId, cost);

    farmLines.push({
      row, cycle, harvests, itemId, produced, cost, plots, tiles,
      rests: restsWith(cycle),
      // What this row got from the pile rather than the market.
      fromStock: took,
    });
  }

  let focusLeft = focusBudget;

  /* ---- craft ---- */
  const craftLines = [];
  let buyCost = 0;
  let feeCost = 0;

  const batchOf = new Map();
  for (const job of plan.crafts) {
    const recipe = recipeOf(job.recipeId);
    if (!recipe) continue;
    batchOf.set(job, craftBatch(recipe, {
      ...ctx, cityId: job.cityId, specLevel: job.specLevel,
      settings: { ...s, useFocus: job.useFocus ?? s.useFocus },
    }));
  }

  /* When two jobs want the same focus and neither feeds the other, whoever
   * happened to be higher up the list used to take it all \u2014 so dragging a
   * row could move the cycle's profit by three hundred per cent. Focus goes
   * to whatever pays best for it instead, and the dependency sort still runs
   * afterwards so a feeder never waits on the thing it feeds.
   *
   * The rate has to be in the same currency the ledger books, or the sort is
   * worse than no sort at all: batch.profit charges every input at the
   * market, while the cycle charges what you grew at what it cost you to grow
   * and does not charge unsold stock at all. So what is already on the pile
   * is valued at its own basis and only the shortfall at the market ask. */
  const unitBasis = (id) => {
    const have = pool[id] || 0;
    return have > 0 ? cost0.of(id) / have : costOf(id);
  };
  const payRate = (job) => {
    const b = batchOf.get(job);
    if (!b || !(b.focus > 0)) return Infinity;      // free, so it never waits
    const spend = b.ref.inputs.reduce((t, i) => {
      const net = i.count * (i.noReturn ? 1 : 1 - b.rrr);
      const have = pool[i.id] || 0;
      const fromPile = Math.min(net, have);
      return t + fromPile * unitBasis(i.id) + (net - fromPile) * costOf(i.id);
    }, 0);
    return (b.revenue - spend - b.fees) / b.focus;
  };
  const byPay = [...plan.crafts].sort((a, b) => payRate(b) - payRate(a));

  for (const job of orderByDependency(byPay, recipeOf)) {
    const recipe = recipeOf(job.recipeId);
    if (!recipe) continue;
    const useFocus = job.useFocus ?? s.useFocus;
    const batch = batchOf.get(job);

    // The return rate hands materials straight back, so the same pile makes
    // more crafts — and each of those still costs focus.
    const perCraft = recipe.inputs.map((i) => {
      // Inputs the game never hands back are consumed whole.
      const net = i.count * (i.noReturn ? 1 : 1 - batch.rrr);
      const have = pool[i.id] || 0;
      /* Two different walls. Over a run the return rate means a pile of
       * `have` is good for have/net crafts, because what comes back goes
       * straight into the next one. But the station takes the FULL recipe
       * amount every time you press the button, so a pile smaller than one
       * batch is good for nothing at all however high the rate is. */
      const allows = net <= 0 ? Infinity
        : have < i.count ? 0
          : Math.floor(have / net);
      return { ...i, net, have, allows };
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
    add(pool, outputOf(recipe), made);
    focusLeft -= batch.focus * crafts;
    // batch already knows the city this job crafts in, so its fee is the
    // right one for this station rather than one number for the whole plan.
    const fees = ((recipe.silver || 0) + batch.usageFee) * crafts;
    feeCost += fees;
    basisIn += fees;
    cost0.put(outputOf(recipe), basisIn);

    craftLines.push({
      job, recipe, batch, crafts, limitedBy, byMaterial, byFocus,
      // Where this job came in the queue for focus, so the card can say why
      // it got none rather than leaving it to look broken.
      payRate: payRate(job),
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
  // The trough is a consumer too: cabbage grown for the geese is not surplus.
  for (const line of farmLines) {
    for (const [id, qty] of Object.entries(line.fromStock || {})) {
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
      (o) => o !== line && o.recipe.inputs.some((i) => i.id === outputOf(line.recipe)));
    line.feeds = feeds ? feeds.recipe : null;
    line.terminal = !line.feeds;
    line.revenue = soldValue[outputOf(line.recipe)] || 0;
    line.gain = line.terminal ? line.revenue - line.basisIn : null;
  }

  /* ---- is the farm outrunning the crafting? ---- */
  const consumed = {};
  for (const line of craftLines) {
    for (const [id, qty] of Object.entries(line.consumed)) {
      consumed[id] = (consumed[id] || 0) + qty;
    }
  }
  for (const line of farmLines) {
    for (const [id, qty] of Object.entries(line.fromStock || {})) {
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
      fromStock: stockIn[l.itemId]?.qty || 0,
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
  /* Plus whatever the stock you started with was carrying. Typed-in stock
   * carries nothing; stock the app carried in from the last cycle carries
   * what it left with, so the same silver is never expensed twice. */
  const cost = openingBasis + spend - heldBasis;
  const profit = revenue - cost;

  /* The honest day-by-day picture, now that the crafting has said what it
   * actually wanted. Focus only climbs to the cap where the crafting could not
   * absorb it, and only what is over the cap at the end is truly thrown away -
   * the rest you simply start the next cycle holding. */
  const focusUsed = focusBudget - focusLeft;
  const focusCarried = Math.min(s.focusCap, Math.max(0, focusLeft));
  // Thrown away: what the crafting left over the cap at the end, plus what
  // the cap ate on the days you rested with the bar already full.
  const focusWasted = Math.max(0, focusLeft - s.focusCap) + capWaste;

  /* The chart is a replay of the cycle that was costed, not a second
   * simulation of it. Re-running the ledger with the crafting spread evenly
   * over every day used to eat the bank a later watering day was counting on,
   * so it funded half the crafting that actually happened, under-paid the
   * watering the farm was priced on, and called the difference waste \u2014 three
   * numbers on screen that the plan above them disagreed with. So the
   * watering pass is annotated rather than redone: the days keep the watering
   * they really paid, and the crafting is laid over them in proportion to the
   * room each day had left. How it is spread is a drawing choice; that the
   * three totals match the plan is not. */
  const room = banked.days.map((d) => (d.mode === 'rest' ? 0
    : Math.max(0, focusPerDayOf(s) - d.spent)));
  const roomTotal = room.reduce((a, b) => a + b, 0);
  let craftedSoFar = 0;
  const ledger = {
    ...banked,
    spentCrafting: focusUsed,
    wasted: focusWasted,
    days: banked.days.map((d, i) => {
      const craft = roomTotal > 0 ? (room[i] / roomTotal) * focusUsed : 0;
      craftedSoFar += craft;
      return { ...d, craft, focus: Math.max(0, d.focus - craftedSoFar) };
    }),
  };
  // Recomputed off the annotated column: the no-crafting pass reaches the cap
  // on a day the real cycle never would.
  ledger.cappedOn = ledger.days.find((d) => d.focus >= s.focusCap)?.day ?? null;

  return {
    cycleDays, farmDays, farmEvery,
    // The day list itself, and what it adds up to.
    days,
    farmingDays: shape.farmingDays,
    restDays: shape.restDays,
    craftDays: shape.craftDays,
    idleDays: shape.craftDays,
    ledger,
    // What the whole cycle can put into crafting, spending it as it comes.
    focusBudget, focusAtCraft: focusBudget, focusLeft,
    // Left over: what you carry into the next cycle, and what the cap ate.
    focusCarried, focusWasted,
    farmLines, craftLines, sales, stock, stockValue, balance, pool, stockCap,
    /* What the cycle makes you carry. You farm where the bonus is and you
     * craft where the specialty is, and those are rarely the same city, so
     * the harvest has to travel. The weight is the game's; whether that is a
     * ride or a bill is yours. */
    legs: (() => {
      const to = s.craftCity;
      const by = new Map();
      for (const line of farmLines) {
        const from = line.row.cityId || s.farmCity;
        if (!from || from === to) continue;
        // Only what the crafting actually gets through has to travel; what
        // you leave on the pile stays where it grew.
        const used = Math.min(line.produced, consumed[line.itemId] || 0);
        if (!(used > 0)) continue;
        const at = by.get(from) || [];
        at.push({ id: line.itemId, qty: used });
        by.set(from, at);
      }
      return [...by.entries()]
        .map(([from, lines]) => ({ from, to, ...haulOf(lines, s) }))
        .filter((leg) => leg.weight > 0)
        .sort((a, b) => b.weight - a.weight);
    })(),
    // Your shopping list, biggest bill first.
    buys: Object.entries(bought)
      .map(([id, x]) => ({ id, ...x }))
      .sort((a, b) => b.cost - a.cost || b.qty - a.qty),
    // Watering asked for, paid for, and the share that decides how much of the
    // seed bonus the farm above actually earned.
    wateringPerDay, wateringAsked, wateringPaid, wateredFraction,
    wateringShortfall: ledger.shortfall,
    farmCost, buyCost, feeCost, spend, heldBasis, cost, revenue, profit,
    // What you started the cycle holding, what it was carrying, and what it
    // would fetch sold as is.
    stockIn, openingBasis, openingValue,
    // Everything the plan ate, by item: trough, seed drill and station alike.
    consumed,
    perDay: profit / cycleDays,
    perMonth: (profit / cycleDays) * 30,
    focusUsed,
  };
}
