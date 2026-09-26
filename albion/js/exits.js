// What to do with what you gathered.
//
// One resource, every way out of it, costed the same way and ranked. Sell
// the logs, refine them, transmute them a grade up, transmute them a tier
// up, or transmute and then refine. Each row is the crafting engine and the
// gathering engine over the same kit, the same city, the same focus budget
// and the same tax, so the comparison is between the routes rather than
// between two screens that disagree.
//
// Its own file because it is the one thing that needs both engines, and
// calc.js already imports gather.js.

import { craftPnL, taxRate } from './calc.js';
import { enchantUp, gatherRun, rawIdOf, refinedOf, tierUp } from './gather.js';

/**
 * Selling it exactly as it came out of the ground.
 *
 * Shaped like a craftPnL so the rows below can be read the same way. The
 * enchanted resources the run picked up on the way are credited here too -
 * leaving them off only this row would make selling the logs look worse than
 * refining them for a reason that has nothing to do with refining.
 */
function sellRaw(rawId, qty, run, ctx) {
  const price = ctx.sellPriceOf || ctx.priceOf;
  const unit = price(rawId);
  const gross = qty * unit;
  const tax = taxRate(ctx.settings);
  const byproducts = (run.byproducts || [])
    .map((row) => ({ id: row.id, qty: row.qty, unit: price(row.id), value: row.qty * price(row.id) }))
    .filter((row) => row.value > 0);
  const byproductValue = byproducts.reduce((t, b) => t + b.value, 0);
  const byproductRevenue = byproductValue * (1 - tax);
  /* And the kit this run assumed you were holding up, charged the same way
   * craftPnL charges it — otherwise selling the logs would look better than
   * refining them by exactly the price of the pies. */
  const cost = ctx.costOf || price;
  const kitItems = [[run.foodId, run.pies], [run.potionId, run.potions]]
    .filter(([id, qty]) => id && qty > 0 && cost(id))
    .map(([id, qty]) => ({ id, qty, unit: cost(id), cost: qty * cost(id) }));
  const kitCost = kitItems.reduce((t, k) => t + k.cost, 0);
  const revenue = gross * (1 - tax) + byproductRevenue;
  return {
    qty,
    made: qty,
    unitPrice: unit,
    gross,
    tax,
    taxPaid: (gross + byproductValue) - revenue,
    revenue,
    buyCost: 0,
    fees: 0,
    cost: kitCost,
    focus: 0,
    profit: revenue - kitCost,
    missing: unit ? [] : [rawId],
    steps: [],
    buys: [],
    gathered: { [rawId]: run },
    gatherSwingSeconds: run.swingSeconds,
    gatherHours: run.hours,
    gatherFame: run.fame,
    gatherWeight: run.weight,
    byproducts,
    byproductValue,
    byproductRevenue,
    kitItems,
    kitCost,
    assumed: run.assumed,
  };
}

/**
 * How many raws one unit of an exit eats, so every row can be sized to the
 * same pile. Asking for one plank and reading what it wanted is exact, and
 * it costs one extra pass of an engine that runs in microseconds.
 */
function rawsPerUnit(id, rawId, ctx, make) {
  const probe = craftPnL(id, {
    ...ctx, qty: 1, make, gather: new Set([rawId]),
  });
  const used = probe?.gathered?.[rawId]?.qty || 0;
  return { used, probe };
}

/**
 * Every exit from one gathered resource, best first.
 *
 * Ranked on silver per second of actual swinging, which is the one measure
 * available whether or not you have ever timed a run: the swing floor comes
 * out of the game's own tables. Silver an hour is there too, and is null
 * until you have measured, because travel and respawn are in no dump.
 */
export function resourceExits(rawId, ctx, { qty = 999 } = {}) {
  const at = rawIdOf(rawId);
  if (!at) return [];
  /* The run every row is costed against. If the game will not let you gather
   * this at all - your tool is two tiers under it, there is no node of that
   * sort at that tier, or it is a grade the node never rolls - then there is
   * no pile to have routes out of, and a screen that listed them anyway would
   * be ranking five ways to spend an afternoon you cannot have. The caller
   * asks gatherRun itself for the reason. */
  const base = gatherRun(rawId, { qty, settings: ctx.settings });
  if (!base || base.impossible) return [];
  const recipeOf = ctx.recipeOf;
  const up = enchantUp(rawId);
  const over = tierUp(rawId);

  const routes = [
    { key: 'raw', label: 'Sell it as it is', id: rawId, make: [] },
    { key: 'refine', label: 'Refine it', id: refinedOf(rawId), make: [] },
    { key: 'enchant', label: 'Transmute a grade up', id: up, make: [] },
    { key: 'tier', label: 'Transmute a tier up', id: over, make: [] },
    {
      key: 'enchantRefine',
      label: 'Transmute a grade up, then refine',
      id: up ? refinedOf(up) : null,
      make: up ? [up] : [],
    },
  ];

  const rows = [];
  for (const route of routes) {
    if (!route.id) continue;
    if (route.key === 'raw') {
      rows.push({ ...route, pnl: sellRaw(rawId, qty, base, ctx) });
      continue;
    }
    if (!recipeOf(route.id)) continue;
    const make = new Set(route.make);
    const { used } = rawsPerUnit(route.id, rawId, ctx, make);
    if (!(used > 0)) continue;
    /* Size the row to the pile, then check what it really ate and correct
     * once. A single-unit probe under-counts a chain, because the station
     * takes whole crafts at every step and rounding one up at the bottom of
     * a two-step chain is most of a unit. One pass converges; a comparison
     * between routes that started from different piles is not a comparison. */
    let units = Math.max(1, Math.round(qty / used));
    let pnl = craftPnL(route.id, { ...ctx, qty: units, make, gather: new Set([rawId]) });
    const ate = pnl?.gathered?.[rawId]?.qty || 0;
    if (ate > 0 && Math.abs(ate - qty) / qty > 0.005) {
      units = Math.max(1, Math.round(units * (qty / ate)));
      pnl = craftPnL(route.id, { ...ctx, qty: units, make, gather: new Set([rawId]) });
    }
    if (!pnl) continue;
    rows.push({ ...route, pnl });
  }

  return rows.map((row) => {
    const p = row.pnl;
    const seconds = p.gatherSwingSeconds || 0;
    return {
      ...row,
      profit: p.profit,
      revenue: p.revenue,
      focus: p.focus,
      made: p.qty ?? p.made,
      rawsUsed: p.gathered?.[rawId]?.qty || 0,
      swingSeconds: seconds,
      hours: p.gatherHours,
      fame: p.gatherFame,
      byproductRevenue: p.byproductRevenue || 0,
      missing: p.missing || [],
      assumed: p.assumed || [],
      silverPerSwingSecond: seconds > 0 ? p.profit / seconds : null,
      silverPerHour: p.gatherHours ? p.profit / p.gatherHours : null,
      silverPerFocus: p.focus > 0 ? p.profit / p.focus : null,
    };
  }).sort((a, b) => (b.silverPerSwingSecond ?? -Infinity)
    - (a.silverPerSwingSecond ?? -Infinity));
}
