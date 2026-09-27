// What an hour on the water is worth, and the one thing about it nobody knows.
//
// gather.js turns swings into resources. It can do that because
// harvestables.xml publishes, for every family and tier, how long a swing
// takes and how much comes off it. For fishing there is no such row: the word
// FISH appears nowhere in that file, resources.xml carries a bare
// <Resource name="FISH"/> and gamedata.xml one line, <Fishing safety="3"/>.
//
// So this file is deliberately the same engine with one number missing, and it
// does not fill the hole in. How many fish an hour is yours, timed, exactly as
// travel and respawn already are on land. Everything else about a fish IS
// published, and there is a lot of it: the yield stack is the land stack to
// the decimal, the backpack ladder and its two exclusions are stated per item,
// bait is ten casts to the charge, the journals are priced and capped, and any
// fish becomes chops at one chop a point of value.
//
// Two rules this file keeps, because breaking either is how fishing goes
// quietly wrong rather than loudly wrong:
//
//   1. rawIdOf in gather.js stays land-only. Widening that regex to admit fish
//      turns a dozen honest refusals into a dozen wrong numbers: fame 0 and
//      weight 0 (fish are not in gathering.raws), a flat 30% pack cut where
//      the truth is 20-40% with two rares at nothing, no board bonus at all
//      (the fishing nodes carry no family or tier to match on), a tool time
//      factor no file supports, and refinedOf returning the string
//      "T5_undefined".
//   2. The yield multiplier is never applied to a count you measured. A count
//      you measured already contains your rod, your set, your board, your pie
//      and your bait. Multiplying it again would double every bonus you own.
//      The multiplier is here to answer "what is my kit worth", which is a
//      different and answerable question.

import { taxRate } from './calc.js';

const pct = (frac) => `${(frac * 100).toFixed(frac < 0.01 ? 2 : 1)}%`;

/* --------------------------------------------------------------- ids --- */

/** The published row for one fish, or null if that is not a fish id. */
export const fishOf = (settings, itemId) =>
  settings?.gathering?.fishing?.fish?.[itemId] || null;

/** Is this something you catch, rather than swing at, buy or make? */
export const isFish = (settings, itemId) => !!fishOf(settings, itemId);

/**
 * The id of the plain catch for one water at one tier.
 *
 * Commons only, and that is the whole contract. A rare cannot be built this
 * way: two different freshwater rares per tier both carry the zone word
 * "avalon" - the dragon-area one's shopsubcategory3 is `fish_avalon` too - so
 * anything that constructed a rare id from (tier, water, zone) would silently
 * drop one of them. Rares are listed from the table by id instead.
 */
export const commonFishId = (tier, water) =>
  `T${tier}_FISH_${water === 'saltwater' ? 'SALTWATER' : 'FRESHWATER'}_ALL_COMMON`;

/**
 * Every fish you could be going out for, grouped the way the water is.
 *
 * Commons exist at every tier in both waters. Rares only ever exist at T3, T5
 * and T7, and each one is tied to a landscape - which is why they are listed
 * rather than derived: a swamp clam and a highlands rare are different items
 * at the same tier, and only one of them is in the zone you are standing in.
 */
export function fishChoices(settings, tier) {
  const all = settings?.gathering?.fishing?.fish || {};
  return Object.entries(all)
    .filter(([, row]) => row.tier === tier)
    .map(([id, row]) => ({ id, ...row }))
    .sort((a, b) => a.value - b.value || a.id.localeCompare(b.id));
}

/* ----------------------------------------------------------- the kit --- */

const DEFAULTS = {
  rodTier: 0,
  rodAvalon: false,
  gear: { head: 0, armor: 0, shoes: 0, backpack: 0 },
  bait: '',
  water: 'freshwater',
  zone: 'forest',
  danger: 'black',
  measured: {},
};

/**
 * The landscapes that carry a rare, in the order the file lists them.
 *
 * Derived rather than hard-coded, and the reason is the two Avalonian ones:
 * T?_FISH_FRESHWATER_AVALON_RARE and T?_FISH_FRESHWATER_DRAGON_AREA_RARE both
 * carry the zone word `avalon`, so a zone is not a key - it is a label, and the
 * id is the thing.
 */
export function fishZones(settings, tier = 5) {
  const all = settings?.gathering?.fishing?.fish || {};
  return Object.entries(all)
    .filter(([, f]) => f.rarity === 'rare' && f.water === 'freshwater' && f.tier === tier)
    .map(([id, f]) => ({ id, zone: f.zone, name: f.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The fishing kit, which is NOT the gathering kit.
 *
 * The game sells a separate set for it - T?_HEAD_GATHERER_FISH against
 * T?_HEAD_GATHERER_ORE - so owning a T8 ore set says nothing about what you
 * can wear on the water. Reusing the land tiers here would quote a fishing
 * bonus off equipment the user has never bought, which is the same mistake as
 * inventing the number outright.
 *
 * The pie, the potion and premium ARE shared, because those are literally the
 * same items: one pork pie writes gatheringyield and fishingyield in the same
 * breath at the same value, and the build breaks if that ever stops being true.
 */
export function fishKitOf(settings) {
  const kit = settings?.gather?.fish || {};
  return {
    ...DEFAULTS,
    ...kit,
    gear: { ...DEFAULTS.gear, ...(kit.gear || {}) },
    // Shared with the land kit, because they are the same consumables.
    food: settings?.gather?.food || '',
    foodEnchant: settings?.gather?.foodEnchant || 0,
    potion: settings?.gather?.potion || '',
    potionEnchant: settings?.gather?.potionEnchant || 0,
    premiumMode: settings?.gather?.premiumMode || 'add',
    specLevels: settings?.gather?.specLevels || settings?.nodeLevels || {},
  };
}

/** The key one timed fishing count is filed under. */
export const fishRateKey = (tier, kit) =>
  `FISH:${tier}:${kit.water}:${kit.bait || 'none'}`;

/**
 * What you counted yourself, in fish an hour. Zero when you have not.
 *
 * Keyed on the bait as well as the water, and that is not fussiness: bait is
 * +50%, +125% or +250% fishing speed where the whole destiny board is +50%, so
 * a count taken without bait and a count taken with the good stuff are not the
 * same measurement of the same thing. Changing bait asks again rather than
 * scaling the old number, because how much of a catch is waiting for the bite
 * - which is the only part speed touches - is not published either.
 */
export function fishPerHour(settings, tier) {
  const kit = fishKitOf(settings);
  const at = kit.measured?.[fishRateKey(tier, kit)];
  const per10 = Number(at?.per10min) || 0;
  return per10 > 0 ? per10 * 6 : 0;
}

/* --------------------------------------------------------- the yield --- */

/**
 * How much more a catch gives than a bare one does.
 *
 * Every source writes into one engine number, and every one declares a plain
 * value, so they add. The numbers are the land numbers - a T8 chest is 0.035 a
 * charge over ten charges either way - with two differences the file is
 * explicit about: the tier floor is 1 rather than 2, because there are T1 fish
 * and no T1 trees, and the board is two nodes covering every tier rather than
 * five nodes covering one tier each.
 *
 * This is never applied to a count you measured. See the header.
 */
export function fishYield(settings, itemId) {
  const F = settings?.gathering?.fishing;
  const row = fishOf(settings, itemId);
  const kit = fishKitOf(settings);
  if (!F || !row) return { multiplier: 1, parts: [], assumed: [] };
  const tier = row.tier;
  const parts = [];
  const assumed = [];

  // The set, a little every 30 seconds up to ten stacks, each piece capped at
  // its own tier. Assumed fully ramped, as the land engine assumes for a pile.
  let gear = 0;
  for (const slot of ['head', 'armor', 'shoes']) {
    const worn = kit.gear[slot];
    const gearRow = worn && F.gear[slot]?.[String(worn)];
    if (!gearRow) continue;
    if (tier > gearRow.maxTier || tier < gearRow.minTier) continue;
    gear += gearRow.perCharge * gearRow.maxCharges;
  }
  if (gear) parts.push({ what: "Fisherman's set", value: gear });

  // The Avalonian rod. A plain rod has no passive slot and gives no yield -
  // its only contribution is the 5% speed every rod has.
  let rod = 0;
  const floor = F.toolYieldMinTier ?? 1;
  if (kit.rodAvalon && tier <= kit.rodTier && tier >= floor) {
    rod = F.toolYield[String(kit.rodTier)] || 0;
    if (rod) parts.push({ what: 'Avalonian rod', value: rod });
  }

  const G = settings.gathering;
  const foodRow = G.food[kit.food]?.grades?.[String(kit.foodEnchant || 0)];
  const food = foodRow?.fishingyield || 0;
  if (food) parts.push({ what: G.food[kit.food].name, value: food });

  const potionRow = G.potions[kit.potion]?.grades?.[String(kit.potionEnchant || 0)];
  const potion = potionRow?.fishingyield || 0;
  if (potion) parts.push({ what: G.potions[kit.potion].name, value: potion });

  /* Both board nodes, summed. Land gathering matches one node by family and
   * tier; these two carry neither, because each pays on tiers 1 to 8. At a
   * hundred levels apiece they come to the same +50% one land tier does. */
  let spec = 0;
  for (const node of F.board || []) {
    const level = Math.min(Number(kit.specLevels?.[node.id] || 0), node.maxLevel);
    const worth = level * node.yieldPerLevel;
    if (worth) {
      spec += worth;
      parts.push({ what: node.name, value: worth });
    }
  }

  const inGame = gear + rod + food + potion + spec;
  const premium = settings.premium ? (G.premiumYield || 0) : 0;
  const multiplier = premium && kit.premiumMode === 'multiply'
    ? (1 + inGame) * (1 + premium)
    : 1 + inGame + premium;
  if (premium) {
    parts.push({ what: 'Premium', value: premium, mode: kit.premiumMode });
    /* Two separate unknowns on a fishing row, where a land row has one. The
     * land caveat argues about whether the +50% adds or multiplies; here the
     * prior question is whether it applies at all, because the store copy
     * names gathering and says nothing about fishing either way. */
    assumed.push("premium's +50% is advertised for gathering and the game says "
      + 'nothing about fishing either way — it is counted here on that reading');
    assumed.push(`and it is ${kit.premiumMode === 'multiply' ? 'multiplied' : 'added'}`
      + ' — the game does not publish which');
  }
  return { multiplier, parts, assumed, gear, rod, food, potion, spec, premium };
}

/**
 * Every published source of fishing speed, and why none of them is an hour.
 *
 * `usable` is false on purpose and it is the whole point of the function: a
 * screen should show a player the +250% their bait is worth without converting
 * it into a time, because speed here scales the wait for a bite and no file
 * says how long that wait is, or what share of a catch it even is.
 *
 * Note there is no cap. GatheringSpeed is the only gathering attribute in
 * gamedata.xml's cap table - no FishingSpeed row exists - which is the same
 * reading this codebase already applies to yield. It matters: the best bait
 * alone is six times the 40% that caps a swing.
 */
export function fishSpeed(settings) {
  const F = settings?.gathering?.fishing;
  const kit = fishKitOf(settings);
  const parts = [];
  if (!F) return { total: 0, parts, usable: false, why: 'no game data' };

  if (kit.rodTier) parts.push({ what: 'Any fishing rod', value: F.rodSpeed });
  const bait = F.bait?.[kit.bait];
  if (bait) {
    parts.push({ what: 'Bait', value: bait.speed, casts: bait.charges,
      seconds: bait.seconds });
  }
  const potionRow = settings.gathering.potions[kit.potion]
    ?.grades?.[String(kit.potionEnchant || 0)];
  if (potionRow?.fishingspeed) {
    parts.push({ what: settings.gathering.potions[kit.potion].name,
      value: potionRow.fishingspeed, seconds: potionRow.seconds });
  }
  /* The board's speed half is gated on a rod being held - the achievement
   * carries an itempattern of T?_2H_TOOL_FISHINGROD* on the speed bonus and
   * none at all on the yield bonus - so with no rod set neither the 5% nor the
   * board's share of speed exists. */
  if (kit.rodTier) {
    for (const node of F.board || []) {
      const level = Math.min(Number(kit.specLevels?.[node.id] || 0), node.maxLevel);
      const worth = level * node.speedPerLevel;
      if (worth) parts.push({ what: `${node.name}, with a rod`, value: worth });
    }
  }
  const total = parts.reduce((t, p) => t + p.value, 0);
  return {
    total,
    parts,
    // Never true. Kept as a field so a caller reads the reason rather than
    // discovering the absence.
    usable: false,
    why: 'the game publishes no cast time, so a speed bonus has nothing to '
      + 'divide into — time ten minutes on the water instead',
    capped: false,
  };
}

/* -------------------------------------------------------- what it weighs -- */

/**
 * What one fish weighs in your bags, after the Fisherman's pack.
 *
 * The pack is a proportional cut, it rises with tier rather than staying flat
 * like the five land packs, and it names every item id it covers - which is
 * how we know it covers no Avalonian and no dragon-area rare at any tier. A
 * tier check alone would hand the cut to exactly the fish worth the most.
 */
export function fishWeight(settings, itemId) {
  const row = fishOf(settings, itemId);
  if (!row) return { each: 0, cut: 0, why: '' };
  const kit = fishKitOf(settings);
  const pack = settings.gathering.fishing.backpack?.[String(kit.gear.backpack)];
  if (!pack || row.tier > pack.maxTier) {
    return { each: row.weight, cut: 0, why: pack ? 'over your pack\'s tier' : '' };
  }
  if (row.noPack) {
    return {
      each: row.weight,
      cut: 0,
      why: 'no Fisherman\'s pack carries this one — the spell names every fish '
        + 'it covers and the Avalonian and dragon-area rares are in none of them',
    };
  }
  return { each: row.weight * (1 - pack.value), cut: pack.value, why: '' };
}

/* ---------------------------------------------------------- the books --- */

/**
 * The Fisherman's journal a catch of this tier fills, and what it is worth.
 *
 * Their ladder is nothing like the land one - higher than a wood book up to
 * T5, under a third of one at T8 - so this reads the table rather than
 * assuming the land shape.
 *
 * What it does NOT read is `lootFrom`. That is the lowest tier in the book's
 * loot list, which is what it pays OUT on; which catches FILL a fisherman's
 * book is in no file, because the land journals state the rule and these carry
 * a bare fame value. The field is named that way so nothing gates on it.
 */
export function fishJournal(settings, tier) {
  const books = settings?.gathering?.fishing?.journals || {};
  /* The book of your own tier, which is the land convention, and the T2 book
   * for a T1 fish because the published ladder starts at T2. Deliberately NOT
   * gated on the table's lootFrom: that is the lowest tier the book pays out
   * on, and which catches FILL a fisherman's book is in no file - the land
   * journals state the rule and these carry a bare fame value. */
  const book = books[String(Math.max(2, tier))];
  if (!book) return null;
  const t = Math.max(2, tier);
  return {
    tier: t,
    ...book,
    emptyId: `T${t}_JOURNAL_FISHING_EMPTY`,
    fullId: `T${t}_JOURNAL_FISHING_FULL`,
  };
}

/* ------------------------------------------------------------- the run -- */

/**
 * A pile of one fish: everything that needs no clock, and the clock if you
 * have set one.
 *
 * The split is the design. Nine things here come out of published numbers and
 * your own prices and are exact on the first open of the screen: what a fish
 * is worth after tax, what it weighs in your bags, how many fit a load, the
 * fame, the books that fame fills, the chops it makes, the sauce those chops
 * make, what your kit adds, and what bait costs a cast. One thing - how long
 * it takes - is yours, and until you give it `hours` and `perHour` are null
 * rather than a guess.
 */
export function fishRun(itemId, { qty = 999, settings } = {}) {
  const row = fishOf(settings, itemId);
  if (!row) return null;
  const F = settings.gathering.fishing;
  const kit = fishKitOf(settings);
  const tier = row.tier;

  if (!kit.rodTier) {
    return {
      kind: 'fish', itemId, qty, tier, row, impossible: true,
      why: 'say which rod you hold and this comes alive',
    };
  }
  /* Unlike a land tool, no file says a rod under the fish's tier is slower or
   * refused - there is no rod tier table for fishing at all. So an undersized
   * rod is a warning carried ON the run, never a run that does not exist: the
   * weights, the fame, the books and the chops are all still exact, and only
   * the missing rule is missing. Returning early here left every field off the
   * object and crashed the screen that read them. */
  const warn = kit.rodTier < tier
    ? `your T${kit.rodTier} rod is under a T${tier} fish, and no file says what `
      + 'that costs you'
    : '';
  return { ...fishRunAt(itemId, { qty, settings, row, kit, F, tier }), warn };
}

function fishRunAt(itemId, { qty, settings, row, kit, F, tier }) {
  const yld = fishYield(settings, itemId);
  const speed = fishSpeed(settings);
  const weight = fishWeight(settings, itemId);

  /* Fame. The per-fish figure and the zone factor are both published - the
   * ClusterDangerBonus rows carry a fishingfamefactor beside the gathering one,
   * identical at every colour. Premium's half again is not: there is no
   * premium row in gamedata.xml at all, it is the client's store copy, and that
   * copy says "while gathering" and does not mention fishing. It is counted
   * here on that reading and the run says so. */
  const fameFactor = F.fameFactor?.[kit.danger] ?? 1;
  const famePer = row.fame * fameFactor * (settings.premium ? 1.5 : 1);
  const fame = famePer * qty;

  const book = fishJournal(settings, tier);
  const journal = book ? { ...book, filled: fame / book.fame } : null;

  // Bait. The one part of fishing whose cost is exact rather than measured:
  // ten casts to a bait, stated as startcharges on the spell.
  const bait = F.bait?.[kit.bait];
  /* An hour belongs to the common, and only to the common. A timed count is
   * "fish an hour at this tier in this water with this bait" - it is a count
   * of what actually bit, which is overwhelmingly the common. How often a rare
   * takes the hook instead is in no file at all, so handing the common's rate
   * to a rare would quietly claim you can catch 600 clams an hour because you
   * once caught 600 trout. The stack and the load stay exact for every row. */
  const rated = row.rarity === 'common';
  const perHour = rated ? fishPerHour(settings, tier) : 0;
  const hours = perHour > 0 ? qty / perHour : null;
  /* How many baits the pile eats. A bait ends on ten casts OR ten minutes,
   * whichever comes first, so you need enough to cover both bounds and the
   * count is the larger of the two. Both are floors in their own way: a cast
   * is not always a catch, so ten fish is the least ten casts can produce,
   * and the clock bound only exists once you have timed a run. */
  const baitsByCast = bait ? qty / bait.charges : null;
  const baitsByClock = bait && hours ? (hours * 3600) / bait.seconds : null;
  const baits = bait ? Math.max(baitsByCast, baitsByClock || 0) : null;

  return {
    kind: 'fish',
    itemId,
    qty,
    tier,
    row,
    water: row.water,
    rarity: row.rarity,
    yield: yld,
    speed,
    weightEach: weight.each,
    weight: weight.each * qty,
    weightCut: weight.cut,
    weightWhy: weight.why,
    famePer,
    fame,
    fameFactor,
    journal,
    baitId: kit.bait || null,
    baits,
    baitsByCast,
    baitsByClock,
    baitBound: baits == null ? null
      : (baitsByClock && baitsByClock > baitsByCast ? 'clock' : 'casts'),
    chopsEach: row.value,
    chops: row.value * qty,
    perHour,
    hours,
    /* What the kit is worth, in the only unit fishing can answer it in. Not
     * applied to anything - it is the answer to "did the set and the board pay
     * off", which is what the user asked, and on the water it is the only
     * answer available because there is no swing time to shorten. */
    kitShare: yld.multiplier > 1 ? 1 - 1 / yld.multiplier : 0,
    warn: '',
    assumed: [
      ...yld.assumed,
      settings.premium
        ? "premium's half again on fame is store copy too, not a row in any "
          + 'table, and the copy names gathering rather than fishing'
        : '',
      !rated
        ? `how often a ${row.rarity === 'boss' ? 'boss' : 'rare'} bites is in no `
          + 'game file, so this one has no hour at all — the stack and the load '
          + 'are still exact'
        : hours == null
          ? 'how long a catch takes is in no game file, so nothing here is per hour '
            + 'until you have timed ten minutes on the water'
          : `${Math.round(perHour)} fish an hour is your own count, timed`
            + `${kit.bait ? ` with ${(fishNameOf(settings, kit.bait) || kit.bait).toLowerCase()}` : ' with no bait'}`,
      bait
        ? `bait is ${bait.charges} casts or ${bait.seconds / 60} minutes, whichever `
          + 'runs out first, and a cast is not always a catch — so the bait count '
          + 'here is a floor'
        : '',
    ].filter(Boolean),
  };
}

/* ------------------------------------------------------------ the exits -- */

/**
 * Every way out of a pile of fish, best first.
 *
 * Two, where a land resource has five, and that is the file's fault rather
 * than a gap here: fish do not refine into a bar and do not transmute a grade
 * up. What they do is become chops at one chop a point of value, and chops
 * plus seaweed become the sauce that enchants food - a route the dumps state
 * completely. How much sauce comes back per craft is NOT stated, so this
 * costs the inputs and says the return is yours to read off the station.
 */
export function fishExits(itemId, ctx, { qty = 999 } = {}) {
  const { settings } = ctx;
  const run = fishRun(itemId, { qty, settings });
  if (!run || run.impossible) return [];
  const price = ctx.sellPriceOf || ctx.priceOf;
  const cost = ctx.costOf || price;
  const tax = taxRate(settings);
  const F = settings.gathering.fishing;

  const baitCost = run.baits && run.baitId && cost(run.baitId)
    ? run.baits * cost(run.baitId) : 0;
  const bookCost = run.journal && cost(run.journal.emptyId)
    ? Math.ceil(run.journal.filled) * cost(run.journal.emptyId) : 0;
  const bookValue = run.journal && price(run.journal.fullId)
    ? run.journal.filled * price(run.journal.fullId) * (1 - tax) : 0;

  const rows = [];

  const unit = price(itemId);
  rows.push({
    key: 'raw',
    label: 'Sell the catch',
    id: itemId,
    made: qty,
    revenue: qty * unit * (1 - tax),
    cost: baitCost + bookCost,
    profit: qty * unit * (1 - tax) - baitCost - bookCost + bookValue,
    bookValue,
    baitCost,
    missing: unit ? [] : [itemId],
    assumed: run.assumed || [],
  });

  /* Sauce. Every fish becomes chops at its own item value, so the pile is
   * worth run.chops chops however mixed it was, and the sauce recipe eats a
   * fixed number of chops and seaweed. The station's return rate on that craft
   * is in no file, so this is the input cost and the sauce price, with the
   * return called out rather than assumed to be 1.0. */
  for (const [sauceId, recipe] of Object.entries(F.sauce)) {
    const made = Math.floor(run.chops / recipe.chops);
    if (made < 1) continue;
    const seaweed = made * recipe.seaweed;
    const seaweedCost = cost(F.seaweedId) ? seaweed * cost(F.seaweedId) : 0;
    const sauceUnit = price(sauceId);
    const missing = [
      ...(sauceUnit ? [] : [sauceId]),
      ...(cost(F.seaweedId) ? [] : [F.seaweedId]),
    ];
    rows.push({
      key: `sauce${recipe.grade}`,
      label: `Chop it and make grade ${recipe.grade} fish sauce`,
      id: sauceId,
      made,
      chops: run.chops,
      seaweed,
      revenue: made * sauceUnit * (1 - tax),
      cost: baitCost + bookCost + seaweedCost,
      profit: made * sauceUnit * (1 - tax) - baitCost - bookCost - seaweedCost + bookValue,
      bookValue,
      baitCost,
      missing,
      assumed: [
        ...(run.assumed || []),
        'the station\'s return rate on a sauce craft is in no dump, so this '
          + 'counts one sauce per recipe and no resources back',
      ],
    });
  }

  return rows.map((r) => ({
    ...r,
    silverPerFish: qty > 0 ? r.profit / qty : null,
    silverPerKg: run.weight > 0 ? r.profit / run.weight : null,
    silverPerHour: run.hours ? r.profit / run.hours : null,
    run,
  })).sort((a, b) => (b.silverPerKg ?? -Infinity) - (a.silverPerKg ?? -Infinity));
}

/**
 * How many more fish an hour the next bait up has to win you to pay for
 * itself, which is the honest shape of a question with no published answer.
 *
 * The app cannot say how much faster better bait makes you, because the wait
 * for a bite is not published and neither is what share of a catch it is. It
 * CAN say exactly what the upgrade costs and exactly what a fish is worth, and
 * therefore the count at which the trade turns - a threshold to check in game
 * with a stopwatch, rather than a number to believe.
 */
export function baitBreakEven(itemId, ctx) {
  const { settings } = ctx;
  const row = fishOf(settings, itemId);
  if (!row) return null;
  const F = settings.gathering.fishing;
  const price = ctx.sellPriceOf || ctx.priceOf;
  const cost = ctx.costOf || price;
  const kit = fishKitOf(settings);
  const tax = taxRate(settings);
  const perFish = price(itemId) * (1 - tax);
  if (!(perFish > 0)) return null;

  const have = F.bait?.[kit.bait] || null;
  /* Guard on the ROW, not on the price. A save can carry a bait id the tables
   * no longer know - normalizeFish deliberately does not throw those away,
   * because it runs before the game file is hydrated - and then `have` is null
   * while `cost()` happily returns the price the user typed against it. */
  const haveCost = have && cost(kit.bait) ? cost(kit.bait) / have.charges : 0;
  const rows = [];
  for (const [id, bait] of Object.entries(F.bait)) {
    if (id === kit.bait) continue;
    const unit = cost(id);
    if (!unit) { rows.push({ id, missing: true }); continue; }
    const perCast = unit / bait.charges;
    const extra = perCast - haveCost;
    rows.push({
      id,
      speed: bait.speed,
      perCast,
      // Fish an hour it must add to cover the difference, at your own price.
      // Negative means it is cheaper than what you use now and pays at once.
      fishPerHour: extra / perFish * 60,
      extraPerCast: extra,
    });
  }
  return {
    from: kit.bait || null,
    fromSpeed: have?.speed ?? 0,
    perFish,
    rows: rows.sort((a, b) => (a.speed ?? 0) - (b.speed ?? 0)),
    why: 'the game publishes what bait costs and what a fish sells for, but not '
      + 'how much faster a bite comes — so this is the count to check against a '
      + 'stopwatch, not a prediction',
  };
}

/** What to call one of the things a fishing screen prices. */
export const fishNameOf = (settings, itemId) =>
  fishOf(settings, itemId)?.name
  || settings?.gathering?.fishing?.names?.[itemId]
  || null;

/** Every id a fishing screen needs a price for, for one scoped fetch. */
export function fishPricedIds(settings) {
  const F = settings?.gathering?.fishing;
  if (!F) return [];
  return [
    ...Object.keys(F.fish),
    ...Object.keys(F.bait),
    ...Object.keys(F.sauce),
    F.chopsId,
    F.seaweedId,
    ...Object.keys(F.journals).flatMap((t) => [
      `T${t}_JOURNAL_FISHING_EMPTY`, `T${t}_JOURNAL_FISHING_FULL`,
    ]),
  ];
}

export { pct as fishPct };
