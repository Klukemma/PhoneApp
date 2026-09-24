// What an hour in the open world is worth.
//
// The crafting engine in calc.js turns materials into silver. This turns
// time into materials, which is the other half of the same question: a log
// you chopped and a log you bought are the same log at the refining bench,
// and the only thing that separates them is what they cost you.
//
// The split that matters, and that most calculators get wrong: your TOOL
// decides how long a swing takes, and everything else - the gatherer set,
// the Avalonian tool's own bonus, the pie, the destiny board, premium -
// decides how much a swing gives. Bonuses do not make you faster. They make
// you need fewer swings.
//
// Every number here comes from data.gathering, which is built from
// harvestables.xml and spells.xml. The two things no file anywhere carries
// are how many nodes a map holds and how premium's advertised fifty percent
// combines with the rest; both are labelled rather than invented.

/* ------------------------------------------------------------- ids --- */

/** `T5_WOOD_LEVEL1` -> { family: 'WOOD', tier: 5, enchant: 1 }. */
export function rawIdOf(itemId) {
  const m = /^T(\d)_(WOOD|ORE|FIBER|HIDE|ROCK)(?:_LEVEL(\d))?$/.exec(itemId || '');
  if (!m) return null;
  return { family: m[2], tier: Number(m[1]), enchant: Number(m[3] || 0) };
}

/** The other way round. */
export const rawId = (family, tier, enchant = 0) =>
  `T${tier}_${family}${enchant ? `_LEVEL${enchant}` : ''}`;

/** Is this something you go out and gather, rather than buy or make? */
export const isRaw = (itemId) => !!rawIdOf(itemId);

/** What the game calls this sort of node, for a sentence about it. */
const kindLabel = (settings, kind) =>
  (settings?.gathering?.kindLabels?.[kind] || kind).toLowerCase();

const pct = (frac) => `${(frac * 100).toFixed(frac < 0.01 ? 2 : 1)}%`;

/* ---------------------------------------------------------- the kit --- */

const DEFAULTS = {
  kind: 'static',
  zone: 'royal',
  danger: 'black',
  toolTier: 0,
  toolAvalon: false,
  gear: { head: 0, armor: 0, shoes: 0, backpack: false },
  food: '',
  foodEnchant: 0,
  potion: '',
  potionEnchant: 0,
  // How long you have been wearing the set when the run starts. Null means
  // "long enough", which is right for a stack and wrong for a short test.
  wornSeconds: null,
  // Whether the gear and the Avalonian tool pay their yield on an enchanted
  // node. Their buffs name resourcetype="WOOD" exactly while an enchanted
  // log is resourcetype="WOOD_LEVEL1", so the file does not settle it.
  gearCoversEnchanted: true,
  // Whether premium's advertised 50% joins the pool or multiplies the total.
  // No spell implements it, so this is the caller's call and it is labelled.
  premiumMode: 'add',
  specLevels: {},
  measured: {},
};

export const kitOf = (settings) => ({
  ...DEFAULTS,
  ...(settings?.gather || {}),
  gear: { ...DEFAULTS.gear, ...(settings?.gather?.gear || {}) },
  /* A gathering node is a destiny board node like any other, so the levels
   * live with the rest of your board rather than in a second list you would
   * have to remember to fill in twice. A caller can still hand them in
   * directly, which is what the tests do. */
  specLevels: settings?.gather?.specLevels || settings?.nodeLevels || {},
});

/** The key one measured rate is filed under. One per thing you actually farm. */
export const rateKey = (family, tier, kit) =>
  `${family}:${tier}:${kit.kind}:${kit.zone}`;

/* --------------------------------------------------------- the yield -- */

/**
 * How much more a swing gives than the bare node does.
 *
 * Every source writes into one engine number, GatheringYield, and every one
 * of them declares a plain value, so they add rather than compound. Each
 * carries its own rules about what it covers, and the differences are real:
 * the pie has no resource filter at all, the destiny board matches the family
 * by glob and so covers enchanted logs, and the gear and the Avalonian tool
 * name the plain resource type exactly.
 */
export function gatherYield(family, tier, enchant, settings) {
  const G = settings.gathering;
  const kit = kitOf(settings);
  if (!G) return { multiplier: 1, parts: [], assumed: [] };

  // A gear or tool bonus only reaches an enchanted node if it covers it, and
  // the game files do not say whether it does.
  const covers = !enchant || kit.gearCoversEnchanted;
  const parts = [];
  const assumed = [];

  // The set. A little every 30 seconds up to ten stacks, so the figure a
  // tooltip quotes is what you have after five minutes, not what you start
  // with. And every piece is capped at its own tier.
  const charges = kit.wornSeconds == null ? 1
    : Math.min(1, Math.floor(kit.wornSeconds / (G.gearInterval || 30))
      / (G.gear.head['4']?.maxCharges || 10));
  let gear = 0;
  for (const slot of ['head', 'armor', 'shoes']) {
    const worn = kit.gear[slot];
    const row = worn && G.gear[slot]?.[String(worn)];
    if (!row) continue;
    if (tier > row.maxTier || tier < row.minTier) continue;
    if (!covers) continue;
    gear += row.perCharge * row.maxCharges * charges;
  }
  if (gear) parts.push({ what: 'Gatherer set', value: gear });

  // The Avalonian tool. A plain tool has no passive slot and gives nothing.
  let tool = 0;
  if (kit.toolAvalon && covers && tier <= kit.toolTier) {
    tool = G.toolYield[String(kit.toolTier)] || 0;
    if (tool) parts.push({ what: 'Avalonian tool', value: tool });
  }

  // The pie. No resource filter of any kind, so it covers every family and
  // every grade.
  const foodRow = G.food[kit.food]?.grades?.[String(kit.foodEnchant || 0)];
  const food = foodRow?.gatheringyield || 0;
  if (food) parts.push({ what: G.food[kit.food].name, value: food });

  const potionRow = G.potions[kit.potion]?.grades?.[String(kit.potionEnchant || 0)];
  const potion = potionRow?.gatheringyield || 0;
  if (potion) parts.push({ what: G.potions[kit.potion].name, value: potion });

  // The destiny board, which is the largest single source at 100.
  const node = G.board.find((n) => n.family === family && n.tier === tier);
  const level = Math.min(Number(kit.specLevels?.[node?.id] || 0), node?.maxLevel || 0);
  const spec = node ? level * node.yieldPerLevel : 0;
  if (spec) parts.push({ what: node.name, value: spec });

  const inGame = gear + tool + food + potion + spec;
  const premium = settings.premium ? (G.premiumYield || 0) : 0;
  const multiplier = premium && kit.premiumMode === 'multiply'
    ? (1 + inGame) * (1 + premium)
    : 1 + inGame + premium;
  if (premium) {
    parts.push({ what: 'Premium', value: premium, mode: kit.premiumMode });
    assumed.push(`premium's +${Math.round(premium * 100)}% gathering yield is `
      + `${kit.premiumMode === 'multiply' ? 'multiplied' : 'added'} — the game does not publish which`);
  }
  if (enchant && (gear || tool)) {
    assumed.push('gear and tool yield count on enchanted nodes');
  }

  return {
    multiplier, parts, assumed,
    gear, tool, food, potion, spec, premium,
    atCharges: charges, ramped: charges >= 1,
  };
}

/**
 * How much faster you swing. The only two sources in the game are the
 * gathering potion and the destiny board, and the total is hard capped.
 * Gear, Avalonian tools, pies and premium contain no speed effect at all.
 */
export function gatherSpeed(family, tier, settings) {
  const G = settings.gathering;
  const kit = kitOf(settings);
  if (!G) return { total: 0, capped: false, spec: 0, potion: 0 };
  const node = G.board.find((n) => n.family === family && n.tier === tier);
  const level = Math.min(Number(kit.specLevels?.[node?.id] || 0), node?.maxLevel || 0);
  const spec = node ? level * (node.speedPerLevel || 0) : 0;
  const potionRow = G.potions[kit.potion]?.grades?.[String(kit.potionEnchant || 0)];
  const potion = potionRow?.gatheringspeed || 0;
  const raw = spec + potion;
  const cap = G.speedCap ?? 0.4;
  return { spec, potion, raw, total: Math.min(raw, cap), capped: raw > cap, cap };
}

/* ---------------------------------------------------------- the rate -- */

/**
 * One swing, costed in seconds and counted in resources.
 *
 * Two separate levers and they must not be confused: the tool cuts the
 * seconds, every yield bonus cuts the number of swings. A node below your
 * tool by two is half the time; a node one above it is half again as long;
 * two above and the game will not let you harvest it at all.
 */
export function gatherRate(family, tier, enchant, settings) {
  const G = settings.gathering;
  const kit = kitOf(settings);
  const node = G?.nodes?.[family]?.[kit.kind]?.[String(tier)];
  if (!node) return null;

  const diff = kit.toolTier - tier;
  const factor = G.toolTimeFactor[String(Math.min(7, diff))];
  if (factor == null) {
    return { impossible: true, node, diff, needTool: tier - 1 };
  }

  const speed = gatherSpeed(family, tier, settings);
  const yld = gatherYield(family, tier, enchant, settings);
  const secondsPerSwing = node.seconds * factor / (1 + speed.total);
  const perSwing = node.yield * node.perHarvest * yld.multiplier;

  return {
    node, diff, factor, speed, yield: yld,
    secondsPerSwing,
    unitsPerSwing: perSwing,
    secondsPerUnit: secondsPerSwing / perSwing,
    // How many whole nodes a stack works out at, which is the figure that
    // tells you whether a zone can even hold the run.
    unitsPerNode: node.charges * node.yield * yld.multiplier,
  };
}

/** What you measured yourself, in units an hour. Zero when you have not. */
export function measuredPerHour(family, tier, settings) {
  const kit = kitOf(settings);
  const at = kit.measured?.[rateKey(family, tier, kit)];
  if (!at) return 0;
  const per10 = Number(at.per10min) || 0;
  return per10 > 0 ? per10 * 6 : 0;
}

/* ----------------------------------------------------------- the run -- */

/**
 * A whole run at one resource: the swing floor, the real hours if you have
 * measured them, the grades it comes back in, and the fame.
 *
 * `hours` is null rather than a guess when nothing has been measured. The
 * floor is exact and file-backed; the hours are yours, because node density,
 * travel, competition and live respawn appear in no dump and the app does
 * not invent numbers it cannot source.
 */
export function gatherRun(itemId, { qty = 999, settings }) {
  const at = rawIdOf(itemId);
  if (!at) return null;
  const { family, tier, enchant } = at;
  const kit = kitOf(settings);
  const rate = gatherRate(family, tier, enchant, settings);
  if (!rate) {
    /* There is no node of that sort at that tier - no T2 living resource, no
     * guardian outside T6. A refusal with a reason on it, not a null: every
     * caller has to be able to say why, and a null is a crash waiting for the
     * one person whose kit is set to critters on the day they look at T2. */
    return {
      kind: 'gather', itemId, qty, impossible: true, ungatherable: true, rate: null,
      why: `there is no T${tier} ${kindLabel(settings, kit.kind)} to harvest`,
      assumed: [], hours: null, swingSeconds: 0, mix: [], byproducts: [],
      fame: 0, weight: 0, harvests: 0, swings: 0, nodes: 0,
    };
  }
  if (rate.impossible) {
    return {
      kind: 'gather', itemId, qty, impossible: true, rate,
      why: kit.toolTier
        ? `your T${kit.toolTier} tool is too small for a T${tier} node — it takes a T${rate.needTool}`
        : 'no tool set yet',
      assumed: [], hours: null, swingSeconds: 0, mix: [], byproducts: [],
      fame: 0, weight: 0, harvests: 0, swings: 0, nodes: 0,
    };
  }

  /* What grade comes off the node, and so how many swings a pile of ONE grade
   * really takes. Every harvest rolls: in a royal cluster 94.45% come up
   * plain and the rest come up enchanted. That cuts both ways, and the
   * direction everyone forgets is the second one. A stack of plain logs needs
   * 5.9% more harvests than the yield maths alone says, because a twentieth
   * of them turn out not to be plain. And a stack of T5.1 logs needs twenty
   * times as many, because you cannot aim at one - they only fall out of
   * ordinary gathering. That is the whole reason enchanted resources cost
   * what they do, and an app that reported them as equally farmable would be
   * wrong by a factor of twenty. */
  const odds = settings.gathering?.rareOdds?.[kit.zone]
    || settings.gathering?.rareOdds?.royal || [1, 0, 0, 0, 0];
  const rolls = rate.node.rare || [];
  const chance = { 0: 1 };
  for (const g of rolls) {
    chance[g] = odds[g] || 0;
    chance[0] -= chance[g];
  }
  const share = chance[enchant] || 0;
  if (!(share > 0)) {
    /* Not a roll this node makes. T?.4 is the honest case: pristine exists
     * only on a resource treasure and the published weights give it zero, so
     * the app says it cannot be farmed rather than quoting a time for it. */
    return {
      kind: 'gather', itemId, qty, impossible: true, ungatherable: true, rate,
      why: enchant
        ? `a ${kindLabel(settings, kit.kind)} never rolls grade .${enchant}`
        : 'this node gives nothing plain',
      assumed: [], hours: null, swingSeconds: 0, mix: [], byproducts: [],
      fame: 0, weight: 0, harvests: 0, swings: 0, nodes: 0,
    };
  }

  // Everything the node hands you on the way to the pile you asked for.
  const harvests = qty / share;
  const swings = harvests / rate.unitsPerSwing;
  const swingSeconds = swings * rate.secondsPerSwing;
  const nodes = harvests / rate.unitsPerNode;

  const perHour = measuredPerHour(family, tier, settings);
  const hours = perHour > 0 ? harvests / perHour : null;
  // What share of a real hour is spent actually swinging. Anything above a
  // few percent usually means the rate was measured somewhere very rich.
  const uptime = hours ? swingSeconds / (hours * 3600) : null;

  const mix = Object.entries(chance)
    .map(([g, sh]) => ({ grade: Number(g), share: sh }))
    .filter((row) => row.share > 0)
    .sort((a, b) => a.grade - b.grade)
    .map((row) => ({ ...row, id: rawId(family, tier, row.grade), qty: harvests * row.share }));
  // What you did not set out for and come home with anyway. Worth real silver:
  // an enchanted log sells for a multiple of a plain one.
  const byproducts = mix.filter((row) => row.grade !== enchant);

  /* Fame, over everything the run picks up rather than only the grade you
   * were after - an enchanted log is worth double the fame of the plain one,
   * and they are a twentieth of the run. The zone factor is 1 everywhere but
   * the deep black zones, and premium's half again on fame is the one part of
   * premium the game does publish plainly. */
  const fameFactor = settings.gathering?.fameFactor?.[kit.danger] ?? 1;
  const raws = settings.gathering?.raws || {};
  const fame = mix.reduce((t, row) => t + row.qty * (raws[row.id]?.fame || 0), 0)
    * fameFactor * (settings.premium ? 1.5 : 1);

  const foodRow = settings.gathering?.food?.[kit.food]?.grades?.[String(kit.foodEnchant || 0)];
  const pies = hours && foodRow?.seconds
    ? Math.ceil((hours * 3600) / foodRow.seconds) : 0;

  const assumed = [...rate.yield.assumed];
  if (hours === null) {
    assumed.push('how fast you actually gather — time a ten-minute run');
  }
  if (enchant) {
    assumed.push(`a grade .${enchant} node is ${pct(share)} of harvests, so this `
      + 'is what it takes to collect that many by gathering plain');
  }
  if (kit.wornSeconds != null && !rate.yield.ramped) {
    assumed.push('the set has not reached full charges yet');
  }
  if (kit.kind === 'treasure') {
    assumed.push('a resource treasure can roll a pristine node, and how often '
      + 'is not published — the grades below use the ordinary node odds');
  }

  return {
    kind: 'gather', itemId, qty, family, tier, enchant,
    rate, harvests, share, swings, swingSeconds, nodes,
    hours, uptime, perHour,
    mix, byproducts, fame, pies,
    weight: mix.reduce((t, row) => t + row.qty * (raws[row.id]?.weight || 0), 0),
    assumed,
  };
}

/* --------------------------------------------------------- the exits -- */

/** The refined material a raw becomes, keeping its grade. */
export function refinedOf(itemId) {
  const at = rawIdOf(itemId);
  if (!at) return null;
  const WORD = {
    WOOD: 'PLANKS', ORE: 'METALBAR', FIBER: 'CLOTH', HIDE: 'LEATHER', ROCK: 'STONEBLOCK',
  };
  // Enchanted rock has no enchanted block: it buys extra plain ones instead,
  // and those rows carry an id of their own.
  if (at.family === 'ROCK') {
    return at.enchant
      ? `T${at.tier}_STONEBLOCK#${at.enchant}`
      : `T${at.tier}_STONEBLOCK`;
  }
  return `T${at.tier}_${WORD[at.family]}${at.enchant ? `_LEVEL${at.enchant}` : ''}`;
}

/** One grade up, if the game has one. */
export function enchantUp(itemId) {
  const at = rawIdOf(itemId);
  if (!at) return null;
  const top = at.family === 'ROCK' ? 3 : 4;
  return at.enchant >= top ? null : rawId(at.family, at.tier, at.enchant + 1);
}

/** One tier up, if the game has one. */
export function tierUp(itemId) {
  const at = rawIdOf(itemId);
  if (!at || at.tier >= 8) return null;
  return rawId(at.family, at.tier + 1, at.enchant);
}
