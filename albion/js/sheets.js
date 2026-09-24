// Bottom sheets: pickers, editors, settings.

import {
  cityBonus, cityFor, craftBatch, farmBonus, farmCityFor, feedFor,
  focusCostAt, focusEfficiency, mixFor, perPeriod, QUALITY_LEVELS,
  qualityMix, qualityPoints, simulateCycle, specFor, TILES_PER_PLOT,
} from './calc.js';
import {
  explain, fetchItem, fetchPrices, serverName, BLACK_MARKET, CITIES, SERVERS,
} from './prices.js';
import {
  addCraft, addPlot, addSpare, applySolution, bmPriceOf, carryStockIn,
  clearLand, clearStock, commit, costOf, DATA, exportJSON, importJSON, itemMeta,
  landSummary, plotsOwned, pricedItemIds, priceOf, qBmPriceOf, qPriceOf,
  removeCraft, removePlot, scheduleDays, setBmPrice, setBuyPrice,
  setCraftCity, setDayMode, setGather, setGoal, setGoalStamp, setHolding,
  setMeasured, setNodeLevel, setPrice, setPrices, setQualityPrice,
  setQualityPrices, setSchedule, setScheduleLength, setSettings, setSpec,
  setStock, state, updateCraft, updatePlot, wipe,
} from './store.js';
import {
  enchantUp, gatherRun, gatherSpeed, gatherYield, kitOf, rateKey, rawId, rawIdOf,
} from './gather.js';
import { resourceExits } from './exits.js';
import { solve } from './solve.js';
import { $, $$, closeSheet, esc, openSheet, toast } from './ui.js';
import { ICON, amt, go, moreHTML, note, rowHTML, tag, tick } from './html.js';
import { row as meRow, toggle as meToggle } from './me.js';
import { ago, hours, pct, short, silver, tierText } from './util.js';
import {
  cityDeltas, ctx, cycleFor, detailHTML, lastSim, setSolution, solution,
  solveStamp,
} from './views.js';
import {
  allRecipes, craftTarget, currentRun, ensureGear, gearReady, groupIcon,
  groupOf as craftGroupOf, GROUPS, hasQuality as craftHasQuality,
  nameOf as craftNameOf, recipeOf, resetMakeIfFollowing, scan, scanBlackIds,
  scanIds, setCraftRoute, setCraftTarget, setScan,
} from './craft.js';

/* Whichever file knows this item. Once the Craft tab has loaded the weapon
 * and armour list, a steel bar has a name here too; before that it does not,
 * and showing the raw id is better than pretending. */
const nameOf = (id) => itemMeta(id)?.name || id;

/* Sheets do not usually change tab: whatever they set, the screen behind them
 * is already the one showing it. A ranked route is the exception - it is read
 * on Best and worked on in Craft - so the shell lends its router. */
let navigate = () => {};
export const setNavigate = (fn) => { navigate = fn; };

/* Ask the market about all five qualities at once. It is the same request
 * either way, and on equipment the four above plain are where the money is. */
const QUALITIES = [1, 2, 3, 4, 5];

/**
 * Which list a recipe belongs in. Butchering is its own crafting category per
 * species \u2014 meat_cow, meat_goose and four more \u2014 so anything that is not a
 * potion or a cooked meal would otherwise be filed with the potions and drawn
 * with a flask beside it.
 */
const groupOf = (r) => (r.category === 'food' ? 'food'
  : r.category.startsWith('meat_') ? 'meat' : 'potion');

const GROUP_ICON = { food: '\u{1F35E}', meat: '\u{1F969}', potion: '\u{1F9EA}' };

/** The three troughs, in the order the animals that eat from them appear. */
const FEED_LABELS = [
  ['plants', 'Crops, for livestock and pack animals'],
  ['meat', 'Meat, for the kennel carnivores'],
  ['mount', 'Grown mounts, which only the drake eats'],
];

/* ------------------------------------------------------------- goal --- */

/** What you are making. Land and days have their own sheets. */
export function openGoal() {
  const goal = state.goal;
  const byCat = { potion: [], food: [], meat: [] };
  // Enchanted versions hang off their base rather than trebling the list: the
  // game writes them T6.1, T6.2 and T6.3, and they are the same potion made
  // with alchemy extract stirred in, for a lot more focus and a lot more money.
  const enchantsOf = new Map();
  for (const r of DATA.recipes) {
    if (r.enchant) {
      const base = r.id.split('@')[0];
      if (!enchantsOf.has(base)) enchantsOf.set(base, []);
      enchantsOf.get(base).push(r);
    } else {
      byCat[groupOf(r)].push(r);
    }
  }
  for (const list of enchantsOf.values()) list.sort((a, b) => a.enchant - b.enchant);
  let query = '';

  const chips = (r) => {
    const variants = enchantsOf.get(r.id) || [];
    if (!variants.length) return '';
    return `
      <div class="seg small" style="margin:6px 0 10px 48px">
        ${[r, ...variants].map((v) => `
          <button type="button" data-recipe="${esc(v.id)}"
            aria-pressed="${v.id === goal.recipeId}">
            ${tierText(v.tier, v.enchant)}</button>`).join('')}
      </div>`;
  };

  const list = (rs) => rs
    .filter((r) => !query || `${tierText(r.tier, r.enchant)} ${r.name}`.toLowerCase().includes(query))
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name))
    .map((r) => recipeRow(r, goal.recipeId, GROUP_ICON[groupOf(r)]) + chips(r)).join('');

  const section = (title, rs) => {
    const html = list(rs);
    return html ? `<div class="section-head"><h2>${title}</h2></div>${html}` : '';
  };

  const render = (root) => {
    $('#goalList', root).innerHTML = `
      ${section('Potions', byCat.potion)}
      ${section('Food', byCat.food)}
      ${byCat.meat.length ? section('Butchering', byCat.meat) : ''}
      ${!query || list(byCat.potion) || list(byCat.food) || list(byCat.meat) ? ''
        : '<div class="empty">Nothing farmable by that name.</div>'}`;
  };

  openSheet(`
    <h2>What are you making?</h2>
    <div class="field">
      <input type="search" id="goalSearch" placeholder="Find a potion or meal…" autocomplete="off">
    </div>
    <div id="goalList"></div>
    ${note('The .1, .2 and .3 under a potion are its enchanted versions: same ingredients plus alchemy extract, much more focus, much more money.')}
  `, {
    onMount(root) {
      render(root);
      const search = $('#goalSearch', root);
      search.oninput = () => { query = search.value.trim().toLowerCase(); render(root); };
      root.onclick = (e) => {
        const btn = e.target.closest('[data-recipe]');
        if (!btn) return;
        setGoal({ recipeId: btn.dataset.recipe });
        // Craft follows the plan until you pick something there; its make/buy
        // choices belonged to the old potion.
        resetMakeIfFollowing();
        closeSheet();
        solveWithPrices();
      };
    },
  });
}

/**
 * Work the plan out and put it in place.
 *
 * The search runs a few hundred simulations, which is long enough to feel like
 * a freeze on a phone, so the screen says what it is doing before it starts.
 */
export function runSolve() {
  const goal = state.goal;
  const recipe = DATA.recipes.find((r) => r.id === goal.recipeId);
  if (!recipe) { openGoal(); return; }
  if (!plotsOwned()) { toast('Say how much land you have first'); openFarm(); return; }

  toast(`Working out ${recipe.name}…`);
  setTimeout(() => {
    let result;
    try {
      /* The solver sizes the farm, and a bag of seeds is not a reason to plant
       * fewer plots: it is a reason to buy fewer seeds. So it plans from an
       * empty bag, and the plan it hands back is then read against the real
       * one, which is where the saving shows. */
      result = solve(goal.recipeId, plotsOwned(), DATA, { ...ctx(), stock: undefined }, {
        ...(goal.keepDays ? { schedule: scheduleDays() }
          : goal.cycleDays ? { cycleDays: goal.cycleDays } : {}),
        ...(state.farm.length ? { holdings: state.farm } : {}),
      });
    } catch (err) {
      console.error(err);
      toast('Could not work that one out');
      return;
    }
    if (!result.ok) {
      setSolution(null);
      // A plan is only as real as its prices, so offer to go and get them
      // rather than asking you to type a number you would have to guess.
      if (result.reason === 'no-price') {
        toast(`No market price for ${recipe.name}`, {
          label: 'Fetch live',
          run: () => runPriceFetch(chainIds(goal.recipeId)).then((ok) => ok && runSolve()),
        });
      } else {
        toast('No plan makes that at these prices');
      }
      return;
    }
    // Remember what this answer was worked out against, so the screen can say
    // when the board, the prices or the question have moved on since.
    // Taken after the answer is in place: the solver writes settings of its
    // own (whether to water), and a stamp taken before that would be stale
    // the moment it was made.
    applySolution(result);
    const stamp = solveStamp();
    // The solution first: stamping the goal redraws the screen, and the
    // screen reads the stamp off the solution when there is one.
    setSolution({ ...result, stamp });
    setGoalStamp(stamp);
    const stale = result.steps.filter((x) => !priceOf(x.itemId)).length;
    if (stale) {
      toast(`${stale} ingredient${stale === 1 ? ' has' : 's have'} no price`, {
        label: 'Fetch live',
        run: () => runPriceFetch(chainIds(goal.recipeId)).then((ok) => ok && runSolve()),
      });
    } else {
      toast(`${short(result.perDay)} a day · ${Math.round(result.made)} ${recipe.name}`);
    }
  }, 30);
}

/** Take the solver up on its suggestion for the land the chain did not need. */
export function acceptSpare(count, cityId) {
  const spare = solution?.spare;
  if (!spare) return;
  const n = Math.round(Number(count)) || spare.plots;
  addSpare(spare, { count: n, cityId });
  toast(`${n} ${n === 1 ? 'plot' : 'plots'} added`);
}

/* -------------------------------------------------------------- land --- */

/** The four farm buildings, as the game draws them. */
const PLOT_ICON = {
  farm: '\u{1F33E}', herbgarden: '\u{1F33F}', pasture: '\u{1F404}', kennel: '\u{1F43A}',
};


/**
 * The land you actually own.
 *
 * The game has four farm buildings and will not let you mix them: a Farm takes
 * crops, a Herb Garden takes herbs, a Pasture takes livestock and a Kennel
 * takes the exotic mounts. Five plots of carrots and seven of agaric are not
 * twelve interchangeable plots, and a plan that treats them as such will tell
 * you to grow foxglove somewhere foxglove cannot go.
 *
 * The city matters too, and per crop: Martlock grows foxglove and potatoes ten
 * percent better, Lymhurst does the same for geese.
 */
/* Cities you asked to add land in this time, before any of it is saved. */
let extraCities = [];

export function openFarm() {
  // Every island is bound to a city and farms with that city's bonus, so
  // there is nowhere to put land that is not a city. The island entry exists
  // for crafting, where the bonus really is zero, and has no place here.
  const cities = (state.settings.cities || []).filter((c) => !c.craftOnly);
  const mine = new Map();
  for (const h of state.farm) mine.set(`${h.cityId}:${h.kind}`, h.count);
  const owned = [...new Set(state.farm.map((h) => h.cityId))];
  if (!owned.length && !extraCities.length) extraCities = [state.settings.farmCity];
  const listed = [...new Set([...owned, ...extraCities])].filter((id) => cities.some((c) => c.id === id));
  const rest = cities.filter((c) => !listed.includes(c.id));

  const nameOfCity = (id) => (state.settings.cities || [])
    .find((c) => c.id === id)?.name || id;

  // What this city is worth growing, said in terms of the buildings above.
  const bonusHere = (id) => {
    const city = (state.settings.cities || []).find((c) => c.id === id);
    const items = Object.keys(city?.farmBonus || {});
    if (!items.length) return 'no crop bonus here';
    return `+10% ${items.slice(0, 2).map((x) => nameOf(x)).join(', ')}${
      items.length > 2 ? ` and ${items.length - 2} more` : ''}`;
  };

  const box = (cityId, kind, label) => `
    <div class="field" style="margin:0">
      <label>${PLOT_ICON[kind]} ${label}</label>
      <input type="number" inputmode="numeric" min="0" max="99"
        data-land="${esc(cityId)}" data-kind="${kind}"
        value="${mine.get(`${cityId}:${kind}`) || ''}" placeholder="0"></div>`;

  const cityBlock = (id) => {
    const loose = (mine.get(`${id}:plant`) || 0) + (mine.get(`${id}:animal`) || 0);
    return `
    <div class="card" style="padding:12px;margin-bottom:8px">
      <div class="row slim" style="border:0;background:none;padding:0;min-height:0;margin-bottom:8px">
        <span class="body"><span class="title">${esc(nameOfCity(id))}</span>
          <span class="meta">${esc(bonusHere(id))}</span></span>
      </div>
      <div class="two">${box(id, 'farm', 'Farms')}${box(id, 'herbgarden', 'Herb Gardens')}</div>
      <div class="two" style="margin-top:8px">${box(id, 'pasture', 'Pastures')}${
        box(id, 'kennel', 'Kennels')}</div>
      ${loose ? `<div class="warn-note">
        ${loose} ${loose === 1 ? 'plot' : 'plots'} here were saved before the app
        told the buildings apart. Put the real numbers in above and
        <button class="linkish" data-drop="${esc(id)}">clear the old ones</button>.
        </div>` : ''}
    </div>`;
  };

  openSheet(`
    <h2>Your land</h2>
    ${note('Whole 3×3 plots. Crops need a Farm, herbs a Herb Garden, livestock a Pasture, mounts a Kennel. Islands count under their city.')}
    ${state.farm.length ? '' : `
      <div class="field"><label>Plots that can grow anything</label>
        <input type="number" id="plots" inputmode="numeric" min="0" max="999" value="${state.goal.plots || ''}" placeholder="0">
        <div class="hint">Fine to start with. Say which buildings they are below and the plan stops guessing.</div></div>`}

    ${listed.map(cityBlock).join('')}

    ${rest.length ? `
      <button class="row add" id="addCity">+ Add a city</button>
      <select id="cityPick" class="hide" style="margin-top:8px">
        <option value="">Which city?</option>
        ${rest.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}
      </select>` : ''}

    ${state.farm.length ? `
      <button class="btn ghost danger" id="clear" style="margin-top:12px">Forget all this</button>` : ''}

    <div class="sheet-actions">
      <button class="btn primary" id="save">Save</button>
    </div>
  `, {
    onMount(root) {
      for (const input of $$('[data-land]', root)) {
        // Saved as you type, without redrawing the sheet under your finger:
        // a redraw between blur and tap would eat the Save that follows.
        input.onchange = () => {
          setHolding(input.dataset.land, input.dataset.kind, input.value);
          $('#plots', root)?.closest('.field')?.classList.toggle('hide', state.farm.length > 0);
        };
      }
      for (const btn of $$('[data-drop]', root)) {
        btn.onclick = () => {
          for (const kind of ['plant', 'animal']) setHolding(btn.dataset.drop, kind, 0);
          openFarm();
        };
      }
      const add = $('#addCity', root);
      const pick = $('#cityPick', root);
      if (add) {
        add.onclick = () => { add.classList.add('hide'); pick.classList.remove('hide'); pick.focus(); };
        pick.onchange = () => {
          if (pick.value) { extraCities.push(pick.value); openFarm(); }
        };
      }
      $('#clear', root)?.addEventListener('click', () => { clearLand(); openFarm(); });
      $('#save', root).onclick = () => {
        const plots = $('#plots', root);
        if (plots) setGoal({ plots: Number(plots.value) || state.goal.plots });
        extraCities = [];
        closeSheet();
        // Describing your land is a change to the question, so answer it again.
        if (state.goal.recipeId) runSolve();
      };
    },
    onDismiss: () => { extraCities = []; },
  });
}

/* ------------------------------------------------------- pick a plant -- */

export function openAddPlot() {
  const s = state.settings;
  const group = (title, list) => !list.length ? '' : `
    <div class="section-head"><h2>${esc(title)}</h2></div>
    ${list.map((x) => `
      <button class="row" data-pick="${esc(x.id)}" data-mode="${esc(x.mode || 'grow')}">
        <span class="ico">${x.emoji}</span>
        <span class="body"><span class="title">T${x.tier} ${esc(x.name)}</span>
          <span class="meta">${esc(x.meta)}</span></span>
        ${go()}
      </button>`).join('')}`;

  const plants = DATA.plants.map((p) => ({
    id: p.id, tier: p.tier, name: p.name,
    emoji: p.kind === 'herb' ? '\u{1F33F}' : '\u{1F33E}',
    meta: `${hours(p.growSeconds / 3600)} · ${Math.round(p.seedReturn * 100)}% seeds back`,
  }));
  const livestock = DATA.animals.filter((a) => a.kind === 'livestock');
  const mounts = DATA.animals.filter((a) => a.kind === 'mount');

  openSheet(`
    <h2>What are you growing?</h2>
    ${group('Crops', plants.filter((p) => DATA.plants.find((x) => x.id === p.id).kind === 'crop'))}
    ${group('Herbs', plants.filter((p) => DATA.plants.find((x) => x.id === p.id).kind === 'herb'))}
    ${group('Animals to raise and sell', livestock.map((a) => ({
      id: a.id, tier: a.tier, name: a.name, emoji: '\u{1F414}',
      meta: `${hours(a.growSeconds / 3600)} · eats ${a.nutrition / 48} plants`,
    })))}
    ${group('Animals kept for eggs and milk', livestock.filter((a) => a.product).map((a) => ({
      id: a.id, tier: a.tier, name: `${nameOf(a.product.itemId)} from ${a.name}`,
      emoji: '\u{1F95A}', mode: 'product',
      meta: `every ${hours(a.product.seconds / 3600)}`,
    })))}
    ${s.hideMounts ? '' : group('Mounts', mounts.map((a) => ({
      id: a.id, tier: a.tier, name: a.name, emoji: '\u{1F40E}',
      meta: `${hours(a.growSeconds / 3600)} · eats ${a.nutrition / 48} plants`,
    })))}
  `, {
    onMount(root) {
      root.onclick = (e) => {
        const btn = e.target.closest('[data-pick]');
        if (!btn) return;
        addPlot(btn.dataset.pick, 9, btn.dataset.mode);
        closeSheet();
        toast('Added to your plan');
      };
    },
  });
}

/* -------------------------------------------------------- edit a plot -- */

export function openPlot(row) {
  const cycle = cycleFor(row.itemId, row.mode, row.cityId);
  if (!cycle) return;
  // A cycle is priced per tile; this sheet is about plots.
  const rate = perPeriod(cycle, {
    count: (row.count || 0) * (state.settings.tilesPerPlot || TILES_PER_PLOT),
    cadenceHours: state.settings.cadenceHours,
  });
  const ref = cycle.ref;
  const heading = cycle.kind === 'product'
    ? `${nameOf(ref.product.itemId)} from ${ref.name}` : ref.name;
  // The bonus is keyed on the seed for plants and the grown animal for produce.
  const bonusKey = cycle.kind === 'product' ? ref.grownId : ref.id;

  openSheet(`
    <h2>T${ref.tier} ${esc(heading)}</h2>

    <div class="field">
      <label>Where is this farm?</label>
      <select id="cityId">${farmCityOptions(row.cityId || state.settings.farmCity, bonusKey)}</select>
      <div class="hint">${esc(farmHint(row.cityId, bonusKey, cycle.kind))}</div>
    </div>

    <div class="field">
      <label>How many 3\u00d73 plots</label>
      <input type="number" id="count" inputmode="numeric" min="1" max="999" value="${row.count}">
      <div class="hint">One plot is a 3\u00d73 grid, so nine tiles or nine animals.
        ${row.count} ${row.count === 1 ? 'plot is' : 'plots are'}
        <b>${(row.count || 0) * 9} tiles</b>.</div>
    </div>
    ${detailHTML(cycle, rate)}
    <div class="sheet-actions">
      <button class="btn primary" id="save">Save</button>
      <button class="btn ghost danger" id="del">Remove</button>
    </div>
  `, {
    onMount(root) {
      const apply = (close) => {
        updatePlot(row.id, {
          count: Math.max(1, Number($('#count', root).value) || 1),
          cityId: $('#cityId', root).value,
        });
        if (close) closeSheet();
        else openPlot(state.plan.plots.find((x) => x.id === row.id));
      };
      $('#cityId', root).onchange = () => apply(false);
      $('#save', root).onclick = () => apply(true);
      $('#del', root).onclick = () => {
        const gone = removePlot(row.id);
        closeSheet();
        toast('Removed', { label: 'Undo', run: () => { addPlotBack(gone); } });
      };
    },
  });
}

/** City options for a farm, flagging the ones that boost this particular thing. */
function farmCityOptions(selected, bonusKey) {
  return (state.settings.cities || [])
    .filter((c) => !c.craftOnly)           // an island carries its city's bonus
    .map((c) => {
      const pct = farmBonus(c, bonusKey);
      return `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>
        ${esc(c.name)}${pct ? ` \u2014 +${pct}%` : ''}</option>`;
    }).join('');
}

function farmHint(cityId, bonusKey, kind) {
  const city = farmCityFor(state.settings, cityId);
  const pct = farmBonus(city, bonusKey);
  if (kind === 'animal') {
    return 'Raising animals gets no city bonus \u2014 only their eggs and milk do.';
  }
  if (pct) return `${city.name} gives +${pct}% yield on this. Islands bound here get it too.`;
  const better = (state.settings.cities || [])
    .filter((c) => farmBonus(c, bonusKey) > 0).map((c) => c.name);
  return better.length
    ? `No bonus here. ${better.join(' and ')} give +10%.`
    : 'No city gives a bonus on this one.';
}

/** Choose where your farm or island sits, for the Best screen and new plots. */
export function openFarmCity() {
  const s = state.settings;
  openSheet(`
    <h2>Where is your farm?</h2>
    <p class="muted">A private island carries the farming bonus of the city it is
      bound to, so pick that city. Each plot can override it.</p>
    ${(s.cities || []).filter((c) => !c.craftOnly).map((c) => {
      const items = Object.keys(c.farmBonus || {});
      return `
        <button class="row ${c.id === s.farmCity ? 'selected' : ''}" data-farm-city="${esc(c.id)}">
          <span class="ico">\u{1F33E}</span>
          <span class="body"><span class="title">${esc(c.name)}</span>
            <span class="meta">${items.length
              ? `+10% on ${items.map((k) => nameOf(bonusItemOf(k))).join(', ')}`
              : 'no farming bonus'}</span></span>
          <span class="amt">${c.id === s.farmCity ? '\u2713' : ''}</span>
        </button>`;
    }).join('')}
    <p class="muted small" style="margin-top:12px">
      The bonus is +10% yield on a few named crops, herbs and animal products.
      An animal's favourite food deliberately grows better somewhere else, so no
      one city is best at everything.</p>
  `, {
    onMount(root) {
      root.onclick = (e) => {
        const id = e.target.closest('[data-farm-city]')?.dataset.farmCity;
        if (!id) return;
        setSettings({ farmCity: id });
        closeSheet();
        toast(`Farming in ${farmCityFor(state.settings, id)?.name}`);
      };
    },
  });
}

/** farmBonus keys are seeds and grown animals; show what they produce. */
function bonusItemOf(key) {
  const plant = DATA.plants.find((p) => p.id === key);
  if (plant) return plant.cropId;
  const animal = DATA.animals.find((a) => a.grownId === key);
  return animal?.product?.itemId || key;
}

function addPlotBack(row) {
  if (!row) return;
  state.plan.plots.push(row);
  commit();
}

/* ------------------------------------------------------ pick a recipe -- */

export function openAddCraft() {
  const byCat = { potion: [], food: [], meat: [] };
  for (const r of DATA.recipes) byCat[groupOf(r)].push(r);

  const list = (rs) => rs
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name))
    .map((r) => recipeRow(r, null, GROUP_ICON[groupOf(r)])).join('');

  openSheet(`
    <h2>What are you crafting?</h2>
    <div class="section-head"><h2>Potions</h2></div>${list(byCat.potion)}
    <div class="section-head"><h2>Food</h2></div>${list(byCat.food)}
    ${byCat.meat.length ? `<div class="section-head"><h2>Butchering</h2></div>
      ${note('One grown animal, 38 focus, 18 cuts of meat. The animal does not come back.')}${list(byCat.meat)}` : ''}
  `, {
    onMount(root) {
      root.onclick = (e) => {
        const btn = e.target.closest('[data-recipe]');
        if (!btn) return;
        addCraft(btn.dataset.recipe, 10);
        closeSheet();
        toast('Added to your plan');
      };
    },
  });
}

export function openCraft(job) {
  const recipe = DATA.recipes.find((r) => r.id === job.recipeId);
  if (!recipe) return;
  const s = state.settings;
  const cityId = job.cityId || s.craftCity;
  const spec = Number.isFinite(job.specLevel) ? job.specLevel : specFor(s, recipe.id);
  const mode = job.mode || 'auto';
  const useFocus = job.useFocus ?? s.useFocus;
  const base = ctx();
  const batch = craftBatch(recipe, {
    ...base, cityId, specLevel: spec,
    settings: { ...s, useFocus },
  });
  const rawFocus = craftBatch(recipe, {
    ...base, cityId, specLevel: spec, settings: { ...s, useFocus: true },
  }).focus;

  // How this job actually plays out inside the whole cycle.
  const sim = simulateCycle(state.plan, DATA, base);
  const line = sim.craftLines.find((l) => l.job.id === job.id);
  const rate = line
    ? { perMonth: batch.profit * line.crafts * (30 / sim.cycleDays) }
    : null;

  openSheet(`
    <h2>${tierText(recipe.tier, recipe.enchant)} ${esc(recipe.name)}</h2>

    <div class="field">
      <label>Where do you craft this?</label>
      <select id="cityId">${cityOptions(cityId, recipe.category)}</select>
      <div class="hint" id="cityHint">${esc(cityHint(cityId, recipe.category))}</div>
    </div>

    <div class="field">
      <label>How many this cycle</label>
      <div class="seg">
        <button type="button" data-mode="auto" aria-pressed="${mode === 'auto'}">
          As many as I can</button>
        <button type="button" data-mode="fixed" aria-pressed="${mode === 'fixed'}">
          A set number</button>
      </div>
    </div>
    <div class="field ${mode === 'fixed' ? '' : 'hide'}" id="fixedWrap">
      <label>Crafts per cycle</label>
      <input type="number" id="perCycle" inputmode="numeric" min="0" max="99999"
        value="${job.perCycle || 0}">
      <div class="hint">Anything you have not farmed is bought at market price.</div>
    </div>

    <div class="toggle" style="margin-bottom:12px">
      <div class="body"><div class="t">Use focus on this</div>
        <div class="d">${Math.round(batch.focus || rawFocus)} focus each. Cheap
          intermediate steps are often better done without it, to save focus for
          what actually pays.</div></div>
      <button class="switch" data-jobfocus aria-pressed="${useFocus}"></button>
    </div>

    <div class="field">
      <label>Mastery for this item</label>
      <input type="number" id="specLevel" inputmode="numeric" min="0" max="120" value="${spec}">
      <div class="hint">Halves focus cost at 100.</div>
    </div>

    ${line ? cycleOutcome(line, sim) : ''}
    ${detailHTML(batch, rate)}
    <div class="sheet-actions">
      <button class="btn primary" id="save">Save</button>
      <button class="btn ghost danger" id="del">Remove</button>
    </div>
  `, {
    onMount(root) {
      const read = () => ({
        cityId: $('#cityId', root).value,
        specLevel: Math.max(0, Number($('#specLevel', root).value) || 0),
        perCycle: Math.max(0, Number($('#perCycle', root)?.value) || 0),
      });
      // Re-render live, so the effect of every switch is visible before you
      // commit to it.
      const refresh = (patch = {}) => {
        updateCraft(job.id, { ...read(), ...patch });
        openCraft(state.plan.crafts.find((c) => c.id === job.id));
      };
      $('#cityId', root).onchange = () => refresh();
      $('#specLevel', root).onchange = () => refresh();
      $('#perCycle', root)?.addEventListener('change', () => refresh());
      for (const b of $$('[data-mode]', root)) {
        b.onclick = () => refresh({ mode: b.dataset.mode });
      }
      $('[data-jobfocus]', root).onclick = () => refresh({ useFocus: !useFocus });

      $('#save', root).onclick = () => { updateCraft(job.id, read()); closeSheet(); };
      $('#del', root).onclick = () => { removeCraft(job.id); closeSheet(); toast('Removed'); };
    },
  });
}

/** City <option>s, flagging the ones that actually boost this category. */
function cityOptions(selected, category) {
  return (state.settings.cities || []).map((c) => {
    const boosts = c.specialties?.includes(category);
    return `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>
      ${esc(c.name)}${boosts ? ' \u2014 bonus' : ''}</option>`;
  }).join('');
}

function cityHint(cityId, category) {
  const s = state.settings;
  const city = cityFor(s, cityId);
  const b = cityBonus(city, category, s);
  const withFocus = s.useFocus ? b.total + s.focusCraftBonus : b.total;
  const rate = (1 - 100 / (100 + withFocus)) * 100;
  const what = category === 'potion' ? 'Potions'
    : category === 'food' ? 'Cooked food'
      // Butchering is specialised per species, so name the species: Martlock
      // is the city for beef and nowhere else.
      : `${category.replace('meat_', '').replace(/^./, (c) => c.toUpperCase())} meat`;
  return b.specialises
    ? `${what} get this city's specialty: +${b.base} base and +${b.specialty} specialty, ` +
      `so ${rate.toFixed(1)}% of materials come back.`
    : `${what} are not this city's specialty, so just the +${b.base} base — ` +
      `${rate.toFixed(1)}% of materials come back.`;
}

/** Choose the default city used by the Best screen and new craft jobs. */
/**
 * The one place where you craft is decided. Opened from the Plan, it shows
 * what every city would earn on the plan on screen; from Craft or Me, what
 * each city's bonus is worth to the recipe in hand.
 */
export function openCraftCity() {
  const s = state.settings;
  const recipe = craftTarget() ? recipeOf(craftTarget()) : null;
  const deltas = state.plan.crafts.length && lastSim ? cityDeltas(lastSim) : [];
  const byCity = new Map(deltas.map((d) => [d.city.id, d]));
  const shown = deltas.length ? deltas.map((d) => d.city) : (s.cities || []);

  const rowFor = (c) => {
    const d = byCity.get(c.id);
    const here = c.id === s.craftCity;
    let meta;
    let right;
    if (d) {
      meta = `${short(d.profit)} a cycle · ${short(d.weight)} kg to carry${
        d.others ? ` · same in ${d.others} more` : ''}`;
      right = here ? tick() : amt(d.delta, { unit: '/cycle', sign: true });
    } else if (recipe && !c.craftOnly) {
      const b = cityBonus(c, recipe.category, s);
      meta = `+${b.base} base${b.specialises ? `, +${b.specialty} ${esc(recipe.category === 'food' ? 'food' : recipe.category)}` : ''} → ${pct(returnRateOf(b.total), 1)} back`;
      right = here ? tick() : '';
    } else {
      const spec = c.craftSpecialties || {};
      const tags = [spec.potion && `+${spec.potion} potions`, spec.food && `+${spec.food} food`].filter(Boolean).join(', ');
      meta = c.craftOnly ? 'No city bonus: your own station, away from any city'
        : `+${c.craftBase} base${tags ? `, ${tags}` : ', no specialty here'}`;
      right = here ? tick() : '';
    }
    return rowHTML({
      attrs: `data-pick-city="${esc(c.id)}"`, icon: c.craftOnly ? ICON.island : ICON.city,
      title: esc(c.name),
      meta, cls: here ? 'selected' : '', right: (d?.best && !here ? tag('best') : '') + right,
    });
  };

  openSheet(`
    <h2>Where do you craft?</h2>
    ${recipe ? `
      <div class="toggle" style="margin-bottom:8px">
        <div class="body"><div class="t">Best city per step</div>
          <div class="d">Refine where refining is specialised, ride between.</div></div>
        <button class="switch" id="bestStep" aria-pressed="${s.craftWhere === 'best'}"></button>
      </div>` : ''}
    ${shown.map(rowFor).join('')}
    ${note(deltas.length
      ? 'Each is the whole cycle run again there: its return rate, its specialty, its fee, and the extra ride. Moves every job on your plan; a job can still be set on its own from its row.'
      : 'Only Brecilien boosts potions and only Caerleon boosts cooked food. The royal cities specialise in weapons and armour.')}
  `, {
    onMount(root) {
      $('#bestStep', root)?.addEventListener('click', () => {
        setSettings({ craftWhere: s.craftWhere === 'best' ? 'one' : 'best' });
        openCraftCity();
      });
      for (const b of $$('[data-pick-city]', root)) {
        b.onclick = () => {
          const id = b.dataset.pickCity;
          setCraftCity(id);
          closeSheet();
          toast(`Crafting in ${cityFor(state.settings, id)?.name}`);
        };
      }
    },
  });
}

/** Return rate from a total bonus, the game's own curve. */
const returnRateOf = (bonus) => 1 - 100 / (100 + bonus);

/* ------------------------------------------------------------ prices -- */

/**
 * One item's market: the two prices the maths uses, and what every city is
 * actually paying for it right now.
 *
 * Buying and selling are deliberately separate. The cheapest offer on the
 * shelf is what a material costs you; what you take for a potion is whatever
 * is left after the market's cut, in whichever city you are standing in. One
 * number cannot be both, and a plan built on the wrong one of them looks
 * better than it is.
 */
export function openPrice(id, market = null, busy = false, err = null) {
  const name = nameOf(id);
  const sell = priceOf(id);
  const buy = state.buyPrices[id];
  const server = serverName(state.settings.server);
  // The Black Market is the third price an item can have, and only equipment
  // has it: it buys weapons, armour, bags, capes and tools, and nothing else.
  const takesBlack = ['weapon', 'armor', 'gear']
    .includes(craftGroupOf(recipeOf(id) || {}));
  // Quality is a wider net than the Black Market: a saddled mount comes in
  // five grades too, and the Black Market takes no mounts at all.
  const graded = craftHasQuality(recipeOf(id) || {});
  const black = bmPriceOf(id);

  const quotes = (rows, key, best, target) => rows.map((r, n) => {
    const v = r[key];
    const when = key === 'sellMin' ? r.sellAt : r.buyAt;
    const rank = n === 0 ? best : n === rows.length - 1 && rows.length > 2 ? 'worst' : '';
    // A day-old quote sitting next to an hour-old one is not the same
    // information, and ranking them together quietly pretends it is.
    const stale = Number.isFinite(when) && Date.now() - when > 24 * 3600e3;
    return `
      <button class="row price ${stale ? 'warn' : ''} ${n === 0 ? 'selected' : ''}"
        data-city="${esc(r.city)}" data-target="${target}" data-value="${v}">
        <span class="body">
          <span class="title">${esc(r.city)}${rank ? ` <small>${rank}</small>` : ''}</span>
          <span class="meta">${esc(ago(when))}${stale ? ' · too old to trust' : ''}</span>
        </span>
        <span class="amt num">${silver(v)}</span>
      </button>`;
  }).join('');

  const buyable = (market || []).filter((r) => r.sellMin)
    .sort((a, b) => a.sellMin - b.sellMin);
  const sellable = (market || []).filter((r) => r.sellMin)
    .sort((a, b) => b.sellMin - a.sellMin);
  const instant = (market || []).filter((r) => r.buyMax)
    .sort((a, b) => b.buyMax - a.buyMax);

  openSheet(`
    <h2>${esc(name)}</h2>
    ${note(`${tierText(itemMeta(id)?.tier || 0, itemMeta(id)?.enchant || 0)} \u00b7 ${esc(itemMeta(id)?.cat || 'item')}`)}

    <div class="two">
      <div class="field"><label>You sell it for</label>
        <input type="number" id="sell" inputmode="numeric" min="0" step="1"
          value="${sell || ''}" placeholder="0"></div>
      <div class="field"><label>You pay</label>
        <input type="number" id="buy" inputmode="numeric" min="0" step="1"
          value="${buy || ''}" placeholder="${sell || 0}"></div>
    </div>
    ${takesBlack ? `
      <div class="field"><label>The Black Market pays</label>
        <input type="number" id="blackPrice" inputmode="numeric" min="0" step="1"
          value="${black || ''}" placeholder="0">
        <div class="hint">What its standing order is offering. It only buys, so
          this is a sell price and never a cost, and filling an order that is
          already there skips the setup fee.</div></div>

    ` : ''}
    ${graded ? `
      <div class="field">
        <label>Above plain</label>
        <div class="two">
          ${[2, 3, 4, 5].map((q) => `
            <div class="field" style="margin:0">
              <label style="font-size:11px">${esc(
                state.settings.quality?.names?.[q] || `Q${q}`)}</label>
              <input type="number" inputmode="numeric" min="0" step="1"
                data-q="${q}" placeholder="market"
                value="${qPriceOf(id, q) || ''}">
              ${takesBlack ? `<input type="number" inputmode="numeric" min="0" step="1"
                data-qb="${q}" placeholder="black market" style="margin-top:4px"
                value="${qBmPriceOf(id, q) || ''}">` : ''}</div>`).join('')}
        </div>
        <div class="hint">The market prices each grade separately${takesBlack
          ? ', and so does the Black Market: top box is the market, bottom the Black Market'
          : ''}. Anything left blank is counted at the plain price, which
          understates what a run is worth rather than overstating it.</div>
      </div>` : ''}
    <div class="hint" style="margin:-4px 0 12px">Leave "you pay" blank and it
      costs the same as it sells for. Set it when you buy this in cheaper than
      you would list it \u2014 materials off another city's market, say.</div>

    <button class="btn ${market ? '' : 'primary'}" id="look" ${busy ? 'disabled' : ''}>
      ${busy ? 'Asking every city' + '…' : market ? 'Check again' : 'Where is it cheapest?'}</button>
    <div class="hint centered">Live from the Albion Online Data Project ·
      ${esc(server)} · <button class="linkish" data-src>change server</button></div>

    ${err ? `<div class="warn-note" style="margin-top:12px">${esc(err)}</div>` : ''}

    ${market && !market.length ? `<div class="warn-note" style="margin-top:12px">
      No city has a quote for this. Nobody running the data project's client has
      stood in a market with it open lately \u2014 type a price in instead.</div>` : ''}

    ${buyable.length ? `
      <div class="section-head" style="margin-top:18px"><h2>\u{1F53D} Cheapest to buy</h2>
        <span class="right num flat">tap to use</span></div>
      ${quotes(buyable, 'sellMin', 'cheapest', 'buy')}` : ''}

    ${sellable.length ? `
      <div class="section-head" style="margin-top:18px"><h2>\u{1F53C} Best place to sell</h2>
        <span class="right num flat">tap to use</span></div>
      <p class="muted small" style="margin:-4px 0 8px">What it is listed at there,
        so what you could ask. Your own sale still pays the market's cut.</p>
      ${quotes(sellable, 'sellMin', 'best', 'sell')}` : ''}

    ${instant.length ? `
      <div class="section-head" style="margin-top:18px"><h2>Sell this second</h2></div>
      <p class="muted small" style="margin:-4px 0 8px">The best standing buy order:
        what you get without waiting for a listing to sell. Normally a lot less.</p>
      ${quotes(instant, 'buyMax', 'best', 'sell')}` : ''}

    <div class="sheet-actions">
      <button class="btn primary" id="save">Save</button>
    </div>
  `, {
    onMount(root) {
      $('[data-src]', root)?.addEventListener('click', () => openPriceSource());

      const sellIn = $('#sell', root);
      const buyIn = $('#buy', root);
      if (!market && !busy) { sellIn.focus(); sellIn.select(); }

      const blackIn = $('#blackPrice', root);
      const save = () => {
        setPrice(id, sellIn.value);
        setBuyPrice(id, buyIn.value);
        if (blackIn) setBmPrice(id, blackIn.value);
        for (const box of $$('[data-q]', root)) {
          setQualityPrice(id, Number(box.dataset.q), box.value, false);
        }
        for (const box of $$('[data-qb]', root)) {
          setQualityPrice(id, Number(box.dataset.qb), box.value, true);
        }
      };
      $('#save', root).onclick = () => { save(); closeSheet(); };
      for (const el of [sellIn, buyIn, blackIn].filter(Boolean)) {
        el.onkeydown = (e) => { if (e.key === 'Enter') { save(); closeSheet(); } };
      }

      $('#look', root).onclick = async () => {
        save();
        openPrice(id, market, true, null);
        try {
          const rows = await fetchItem(id, { server: state.settings.server });
          openPrice(id, rows, false, null);
        } catch (e) {
          openPrice(id, market, false, explain(e));
        }
      };

      // Taking a quote writes it to the side of the ledger that list is about,
      // so there is never a question of which number just changed. The sheet
      // stays open on the same figures, with the field now showing it.
      for (const row of $$('[data-city]', root)) {
        row.onclick = () => {
          const v = Math.round(Number(row.dataset.value));
          if (!(v > 0)) return;
          const toBuy = row.dataset.target === 'buy';
          (toBuy ? buyIn : sellIn).value = v;
          save();
          toast(`${toBuy ? 'Paying' : 'Selling at'} ${silver(v)} · ${row.dataset.city}`);
          openPrice(id, market, false, null);
        };
      }
    },
  });
}


export function openPriceSource() {
  openSheet(`
    <h2>Where prices come from</h2>
    <div class="field"><label>Game server</label>
      <select id="server">${SERVERS.map((sv) =>
        `<option value="${esc(sv.id)}" ${sv.id === state.settings.server ? 'selected' : ''}>${esc(sv.name)}</option>`).join('')}</select></div>
    <div class="field"><label>City</label>
      <select id="city">${CITIES.map((c) =>
        `<option value="${esc(c)}" ${c === state.settings.priceCity ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <div class="hint">Prices are the cheapest current sell order in that city.</div></div>
    <div class="sheet-actions">
      <button class="btn primary" id="save">Save</button>
    </div>
  `, {
    onMount(root) {
      $('#save', root).onclick = () => {
        setSettings({
          server: $('#server', root).value,
          priceCity: $('#city', root).value,
        });
        closeSheet();
        toast('Saved');
      };
    },
  });
}

/**
 * Everything one recipe needs priced: the thing itself, its inputs all the
 * way down, and the seeds, babies and feed behind whatever is farmed.
 */
export function chainIds(recipeId) {
  const ids = new Set();
  const seen = new Set();
  const walk = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.add(id);
    const r = DATA.recipes.find((x) => x.id === id);
    if (r) for (const i of r.inputs) walk(i.id);
    const p = DATA.plants.find((x) => x.cropId === id);
    if (p) ids.add(p.seedId);
    const a = DATA.animals.find((x) => x.grownId === id || x.product?.itemId === id);
    if (a) { ids.add(a.babyId); ids.add(feedFor(a, state.settings).id); }
  };
  walk(recipeId);
  return [...ids];
}

/* Recipes whose prices were fetched on your behalf this session. A fetch
 * that failed or was cancelled is not retried on every tap of the button. */
const autoFetched = new Set();

/**
 * Work it out, fetching the prices it needs first if they are missing. Only
 * the recipe's own chain is asked for, once per recipe per session; after
 * that it is runSolve, which stays synchronous and routes as it always did.
 */
export async function solveWithPrices() {
  const id = state.goal.recipeId;
  if (id && !autoFetched.has(id)) {
    const need = chainIds(id).filter((x) => !priceOf(x));
    if (need.length) {
      autoFetched.add(id);
      const ok = await runPriceFetch(need);
      if (!ok) return;
    }
  }
  runSolve();
}

/** Fetch prices for these ids, or for everything. Resolves true when they landed. */
export async function runPriceFetch(ids = pricedItemIds()) {
  const sheet = openSheet(`
    <h2>Fetching prices</h2>
    <div class="note">${ids.length} items from ${esc(serverName(state.settings.server))} ·
      ${esc(state.settings.priceCity)}</div>
    <div class="meter"><i id="bar" style="width:6%"></i></div>
    <div class="note" id="status">Contacting the Albion Online Data Project…</div>
    <div class="sheet-actions"><button class="btn ghost" id="cancel">Cancel</button></div>
  `);
  const controller = new AbortController();
  $('#cancel', sheet).onclick = () => { controller.abort(); closeSheet(); };

  try {
    const out = await fetchPrices(ids, {
      server: state.settings.server,
      city: state.settings.priceCity,
      signal: controller.signal,
      onProgress: (done, total) => {
        const bar = $('#bar', sheet);
        if (bar) bar.style.width = `${Math.max(6, (done / total) * 100)}%`;
        const st = $('#status', sheet);
        if (st) st.textContent = `Batch ${done} of ${total}…`;
      },
    });
    setPrices(out.plain);
    closeSheet();
    toast(out.missing.length
      ? `${out.found.length} prices updated, ${out.missing.length} had no market data`
      : `${out.found.length} prices updated`);
    return true;
  } catch (err) {
    if (controller.signal.aborted) return false;
    closeSheet();
    openSheet(`
      <h2>Could not fetch prices</h2>
      <div class="note">${esc(explain(err))}</div>
      <div class="sheet-actions">
        <button class="btn primary" id="ok">Enter them by hand</button>
      </div>
    `, { onMount: (r) => { $('#ok', r).onclick = closeSheet; } });
    return false;
  }
}

/* ------------------------------------------------------- assumptions -- */

/**
 * What a ranking takes for granted, editable where you read it. The same
 * switches the Me screen has, so a setting is edited in one widget wherever
 * you meet it.
 */
export function openAssumptions(tab = 'farm') {
  const body = tab === 'farm' ? `
      ${meRow('farm-city', ICON.farm, `Farm in ${esc(farmCityFor(state.settings)?.name || 'a city')}`,
    "+10% on that city's crops, herbs and produce")}
      <div class="card tight" style="margin-top:8px">
        ${meToggle('watered', 'Water and nurture with focus', 'Every plot, as far as focus stretches.')}
        ${meToggle('premium', 'Premium', 'Double yield, double growth, the focus a day.')}
        ${meToggle('hideMounts', 'Hide mounts', 'Only livestock and plants in the list.')}
      </div>`
    : tab === 'craft' ? `
      ${meRow('craft-city', ICON.city, `Craft in ${esc(cityFor(state.settings)?.name || 'a city')}`,
      'Its specialty is worth +15% return')}
      <div class="card tight" style="margin-top:8px">
        ${meToggle('useFocus', 'Craft with focus', '+59% return rate, and better quality.')}
        ${meToggle('ownInputsAtCost', 'Value my own produce at what it cost me', 'Rather than at what it would have sold for.')}
      </div>`
    : `
      ${meRow('craft-city', ICON.city, `Craft in ${esc(cityFor(state.settings)?.name || 'a city')}`,
      'Its specialty is worth +15% return, or +40% on refining')}
      <div class="card tight" style="margin-top:8px">
        ${meToggle('useFocus', 'Craft with focus', '+59% return rate, and better quality.')}
        ${meToggle('premium', 'Premium', 'Double yield, double growth, the focus a day.')}
      </div>`;
  openSheet(`
    <h2>What this assumes</h2>
    ${body}
    <div class="sheet-actions"><button class="btn primary" id="done">Done</button></div>
  `, {
    onMount(root) {
      root.onclick = (e) => {
        e.stopPropagation();
        const t = e.target.closest('[data-toggle]');
        if (t) {
          setSettings({ [t.dataset.toggle]: !state.settings[t.dataset.toggle] });
          openAssumptions(tab);
          return;
        }
        const a = e.target.closest('[data-act]')?.dataset.act;
        if (a === 'farm-city') openFarmCity();
        if (a === 'craft-city') openCraftCity();
        if (e.target.closest('#done')) closeSheet();
      };
    },
  });
}

/** Which slice of the gear list the Best tab ranks: group, tier, enchant. */
export function openScanFilter() {
  const cur = scan();
  openSheet(`
    <h2>Which gear?</h2>
    ${GROUPS.map(([k, label]) => rowHTML({
    attrs: `data-group="${esc(k)}"`, icon: groupIcon(k), title: esc(label),
    cls: k === cur.group ? 'selected' : '', right: k === cur.group ? tick() : '',
  })).join('')}
    <div class="section-head" style="margin-top:14px"><h2>Tier</h2></div>
    <div class="chips">
      ${[1, 2, 3, 4, 5, 6, 7, 8].map((t) => `
        <button class="chip" data-tier="${t}" aria-pressed="${t === cur.tier}">T${t}</button>`).join('')}
    </div>
    <div class="section-head" style="margin-top:14px"><h2>Enchantment</h2></div>
    <div class="chips">
      ${[0, 1, 2, 3, 4].map((e) => `
        <button class="chip" data-enchant="${e}" aria-pressed="${e === cur.enchant}">${e ? `.${e}` : 'plain'}</button>`).join('')}
    </div>
    <div class="sheet-actions"><button class="btn primary" id="done">Done</button></div>
  `, {
    onMount(root) {
      for (const b of $$('[data-group]', root)) {
        b.onclick = () => { setScan({ group: b.dataset.group }); openScanFilter(); };
      }
      for (const b of $$('[data-tier]', root)) {
        b.onclick = () => { setScan({ tier: Number(b.dataset.tier) }); openScanFilter(); };
      }
      for (const b of $$('[data-enchant]', root)) {
        b.onclick = () => { setScan({ enchant: Number(b.dataset.enchant) }); openScanFilter(); };
      }
      $('#done', root).onclick = closeSheet;
    },
  });
}

/** One recipe in a picker: tier and name, what goes in, a tick when chosen. */
function recipeRow(r, selectedId, icon, attr = 'data-recipe') {
  const on = r.id === selectedId;
  const inputs = (r.inputs || []).map((i) => `${i.count} ${nameOf(i.id)}`).join(' + ');
  return rowHTML({
    attrs: `${attr}="${esc(r.id)}"`, icon,
    title: `${tierText(r.tier, r.enchant)} ${esc(r.name)}`,
    meta: `${esc(inputs)} → ${r.amount || 1}`,
    cls: on ? 'selected' : '', right: on ? tick() : '',
  });
}

/* ---------------------------------------------------------- settings -- */

/* ----------------------------------------------- the rest of the dials - */

/**
 * The station's posted rate and the constants out of the game files.
 *
 * These used to sit at the bottom of one long Setup sheet along with
 * everything else about you. They are not about you: they are what a building
 * charges and what the game's own tables say, and you touch them on a patch
 * day or never. Everything you DO touch is on the Me screen now.
 */
export function openAdvanced() {
  const s = state.settings;
  openSheet(`
    <h2>Station fees and game numbers</h2>

    <div class="field">
      <label>Station usage fee, per 100 nutrition</label>
      <div class="two">
        ${(s.cities || []).filter((c) => !c.craftOnly).slice(0, 8).map((c) => `
          <div class="field" style="margin:0">
            <label style="font-size:11px">${esc(c.name)}</label>
            <input type="number" inputmode="numeric" min="0" max="${s.maxUsageFee || 1000}"
              data-fee="${esc(c.id)}" placeholder="0"
              value="${(s.stationFee || {})[c.id] || ''}"></div>`).join('')}
      </div>
      <div class="hint">The number posted on the station, which its owner sets.
        The game charges it on the nutrition a craft burns, not per craft: a
        Major Healing Potion burns 486 and a Potato Schnapps 4.5, so one flat
        figure cannot be right for both. Tier 1 and 2 are free, and so is your
        own island. Capped at ${s.maxUsageFee || 1000}.</div>
    </div>

    <div class="field">
      <label>What goes in the trough</label>
      ${FEED_LABELS.map(([cat, what]) => {
        const table = s.feeds?.[cat] || {};
        const opts = Object.entries(table)
          .map(([id, nut]) => ({ id, nut, per: priceOf(id) ? priceOf(id) / nut : Infinity }))
          .sort((a, b) => a.per - b.per || a.id.localeCompare(b.id));
        const picked = (s.feedItemIds || {})[cat];
        return `
          <div class="field" style="margin:8px 0 0">
            <label style="font-size:11px">${esc(what)}</label>
            <select data-feed="${esc(cat)}">${opts.map((o) => `
              <option value="${esc(o.id)}" ${o.id === picked ? 'selected' : ''}>
                ${esc(nameOf(o.id))} \u00b7 ${o.nut} nutrition${
                  Number.isFinite(o.per) ? ` \u00b7 ${o.per.toFixed(2)} silver each`
                    : ' \u00b7 no price yet'}</option>`).join('')}
            </select></div>`;
      }).join('')}
      <div class="hint">The game refuses food from the wrong list outright, so
        a direwolf eats meat whatever wheat costs and a drake eats grown mounts.
        Sorted by silver per nutrition, which is the number that matters.</div>
    </div>

    <div class="section-head"><h2>Straight from the game files</h2></div>
    <p class="muted small">Two of these are not in its tables. The premium
      multipliers are the word "double" on the game's own benefits screen, and
      focus regeneration is published nowhere at all \u2014 so those stay yours to
      set. City bonuses are read from the game's tables and are not listed here.</p>
    <div class="two">
      <div class="field"><label>Default mastery</label>
        <input type="number" id="specLevel" inputmode="numeric" min="0" max="120"
          value="${s.specLevel}">
        <div class="hint">Used only where the board says nothing.</div></div>
      <div class="field"><label>Harvest every (hours)</label>
        <input type="number" id="cadenceHours" inputmode="numeric" min="1" max="72"
          value="${s.cadenceHours}">
        <div class="hint">Crops ripen in 22h; 24 means once a day.</div></div>
      <div class="field"><label>Spare stock you will sit on</label>
        <input type="number" id="stockCap" inputmode="numeric" min="0" step="500"
          value="${s.stockCap}"></div>
      <div class="field"><label>Focus craft bonus (%)</label>
        <input type="number" id="focusCraftBonus" inputmode="decimal" value="${s.focusCraftBonus}"></div>
      <div class="field"><label>Premium yield \u00d7</label>
        <input type="number" id="premiumYieldMultiplier" inputmode="decimal" step="0.1"
          value="${s.premiumYieldMultiplier}"></div>
      <div class="field"><label>Premium growth \u00d7</label>
        <input type="number" id="premiumGrowthMultiplier" inputmode="decimal" step="0.1"
          value="${s.premiumGrowthMultiplier}"></div>
      <div class="field"><label>Focus per day</label>
        <input type="number" id="focusPerDay" inputmode="numeric" value="${s.focusPerDay}"></div>
      <div class="field"><label>Focus quality bonus</label>
        <input type="number" id="focusQualityBonus" inputmode="numeric"
          value="${s.focusQualityBonus ?? 50}"></div>
      <div class="field"><label>Market setup fee (%)</label>
        <input type="number" id="marketSetupFee" inputmode="decimal" step="0.1"
          value="${s.marketSetupFee}"></div>
      <div class="field"><label>Transaction tax (%)</label>
        <input type="number" id="marketTransactionTax" inputmode="decimal" step="0.1"
          value="${s.marketTransactionTax}">
        <div class="hint">Premium halves this.</div></div>
    </div>

    <div class="sheet-actions">
      <button class="btn primary" id="save">Save</button>
    </div>
  `, {
    onMount(root) {
      const NUM = ['specLevel', 'cadenceHours', 'focusCraftBonus',
        'premiumYieldMultiplier', 'premiumGrowthMultiplier', 'focusPerDay',
        'focusQualityBonus', 'marketSetupFee', 'marketTransactionTax', 'stockCap'];
      $('#save', root).onclick = () => {
        const patch = {};
        for (const k of NUM) {
          const box = $(`#${k}`, root);
          if (!box) continue;
          const v = Number(box.value);
          if (Number.isFinite(v)) patch[k] = v;
        }
        // One posted rate per city, because it is the owner's and you stand
        // in their building. A blank means they charge nothing.
        const stationFee = {};
        for (const box of $$('[data-fee]', root)) {
          const v = Math.max(0, Number(box.value) || 0);
          if (v > 0) stationFee[box.dataset.fee] = v;
        }
        patch.stationFee = stationFee;
        // One trough per food category: the game will not let them share.
        const feedItemIds = { ...state.settings.feedItemIds };
        for (const box of $$('[data-feed]', root)) feedItemIds[box.dataset.feed] = box.value;
        patch.feedItemIds = feedItemIds;
        setSettings(patch);
        closeSheet();
        toast('Saved');
      };
    },
  });
}

/** Your data, which lives on this phone and nowhere else. */
export function openData() {
  openSheet(`
    <h2>Backup and restore</h2>
    <div class="bar-row"><span class="n">Game data</span><span class="v num">${esc(DATA.generated || '')}</span></div>
    ${note('Everything is stored on this phone only. Nothing is sent anywhere except the price lookups, which ask the Albion Online Data Project about item ids and tell it nothing about you.')}
    <div class="btn-row">
      <button class="btn" id="export">Export backup</button>
      <button class="btn" id="import">Restore</button>
    </div>
    <button class="btn ghost danger" id="wipe" style="margin-top:10px">Erase everything</button>
    <input type="file" id="file" accept="application/json,.json" class="hide">
  `, {
    onMount(root) {
      $('#export', root).onclick = () => {
        const blob = new Blob([exportJSON()], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `albion-farm-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        toast('Backup saved to downloads');
      };
      $('#import', root).onclick = () => $('#file', root).click();
      $('#file', root).onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try { importJSON(await file.text()); closeSheet(); toast('Restored'); }
        catch (err) { toast(`Could not read that file: ${err.message}`); }
      };
      $('#wipe', root).onclick = () => {
        if (confirm('Erase your prices, plan and settings on this phone?')) {
          wipe(); closeSheet(); toast('Erased');
        }
      };
    },
  });
}

/* ----------------------------------------------------------- mastery -- */

const focusAt = (base, spec) =>
  base / (state.settings.focusCostConstant || 1.00695555005672) ** Math.max(0, spec);

/**
 * Mastery is an input to the plan, not a display setting: halving what a craft
 * costs in focus doubles the batch it can pay for, which changes what to plant
 * and how many days of the cycle are worth farming at all. So changing it and
 * walking away re-solves, rather than leaving you holding the answer to the
 * old numbers.
 */
let masteryWas = null;

const rememberMastery = () => {
  if (masteryWas === null) masteryWas = solveStamp().mastery;
};

function leaveMastery() {
  const moved = masteryWas !== null && masteryWas !== solveStamp().mastery;
  masteryWas = null;
  if (moved && state.goal.recipeId && state.plan.plots.length) runSolve();
}


/**
 * Mastery is per item line in Albion, not one global number, so this lists
 * recipes individually. Anything left blank falls back to your default level.
 */
export function openMastery(filter = '') {
  rememberMastery();
  const s = state.settings;
  const inPlan = new Set(state.plan.crafts.map((c) => c.recipeId));
  const term = filter.trim().toLowerCase();

  const match = (r) => !term || r.name.toLowerCase().includes(term)
    || `t${r.tier}`.startsWith(term);
  const shown = DATA.recipes.filter(match);
  const mine = shown.filter((r) => inPlan.has(r.id) || state.spec[r.id] != null);
  const rest = shown.filter((r) => !inPlan.has(r.id) && state.spec[r.id] == null)
    .slice(0, term ? 40 : 0);

  const row = (r) => {
    const own = state.spec[r.id];
    const focus = Math.round(focusAt(r.focus, own ?? s.specLevel));
    return `
      <div class="row" style="gap:8px">
        <span class="ico">${GROUP_ICON[groupOf(r)]}</span>
        <span class="body"><span class="title">${tierText(r.tier, r.enchant)} ${esc(r.name)}</span>
          <span class="meta">${focus} focus each${own == null ? ', default' : ''}</span></span>
        <input type="number" class="spec-input" data-spec="${esc(r.id)}"
          inputmode="numeric" min="0" max="120" placeholder="${s.specLevel}"
          value="${own ?? ''}" aria-label="Mastery for ${esc(r.name)}">
      </div>`;
  };

  openSheet(`
    <h2>Mastery per recipe</h2>
    <p class="muted">Albion specialises per item, so each one has its own level.
      Leave a box empty to use your default of ${s.specLevel}.</p>
    <div class="field">
      <input type="text" id="find" placeholder="Search recipes" value="${esc(filter)}">
    </div>
    ${mine.length ? `<div class="section-head"><h2>In your plan</h2></div>${mine.map(row).join('')}` : ''}
    ${rest.length ? `<div class="section-head"><h2>Other recipes</h2></div>${rest.map(row).join('')}` : ''}
    ${!mine.length && !rest.length ? `<div class="empty">${term
      ? 'Nothing matches that.'
      : 'Add a craft job, or search, to set mastery for a recipe.'}</div>` : ''}
    <div class="sheet-actions">
      <button class="btn primary" id="done">Done</button>
    </div>
  `, {
    onMount(root) {
      for (const input of $$('[data-spec]', root)) {
        input.onchange = () => { setSpec(input.dataset.spec, input.value); openMastery(filter); };
      }
      const find = $('#find', root);
      find.onchange = () => openMastery(find.value);
      $('#done', root).onclick = () => { leaveMastery(); closeSheet(); };
    },
    onDismiss: leaveMastery,
  });
}

/** What this job actually managed inside the cycle, and what held it back. */
function cycleOutcome(line, sim) {
  const cap = line.limitedBy === 'materials'
    ? `Materials run out first \u2014 they allow ${Math.floor(line.byMaterial)} crafts,
       focus would allow ${Number.isFinite(line.byFocus) ? Math.floor(line.byFocus) : 'any number'}.`
    : line.limitedBy === 'focus'
      ? `Focus runs out first \u2014 it allows ${Math.floor(line.byFocus)} crafts,
         materials would allow ${Math.floor(line.byMaterial)}.`
      : 'Set by you.';
  const short_ = (n) => Math.round(n).toLocaleString();
  return `
    <div class="card" style="margin-bottom:12px">
      <div class="bar-row"><span class="n">Crafts this cycle</span>
        <span class="v num">${short_(line.crafts)}</span></div>
      <div class="bar-row"><span class="n">Items made</span>
        <span class="v num">${short_(line.made)}</span></div>
      <div class="bar-row"><span class="n">Focus used</span>
        <span class="v num">${short_(line.focusUsed)} of ${short_(sim.focusAtCraft)}</span></div>
      <div class="warn-note" style="color:var(--dim);border-color:var(--line);background:var(--card-2)">
        ${cap}</div>
    </div>`;
}

/* ------------------------------------------------------------- cycle -- */

/**
 * The cycle, day by day.
 *
 * Every day is one of three things: you farm, you rest, or you craft. Tap a
 * day to change it. The three numbers this used to be (how long, how much of
 * it farming, how often) could not say "farm the weekdays, craft the weekend",
 * and that is how people actually play.
 */
let cycleWas = null;

export function openCycle() {
  const s = state.settings;
  const goal = state.goal;
  const days = scheduleDays();
  const sim = simulateCycle(state.plan, DATA, ctx());
  const l = sim.ledger;
  const count = (m) => days.filter((d) => d === m).length;
  const LABEL = { farm: 'Farm', rest: 'Rest', craft: 'Craft' };
  const DAY_ICON = { farm: '\u{1F33E}', rest: '\u{1F4A4}', craft: '\u{1F9EA}' };
  // What the question was when the sheet first opened, kept across the
  // re-opens every tap does, so Done knows whether anything really changed.
  if (cycleWas === null) cycleWas = solveStamp().goal;
  const was = cycleWas;

  const presets = [
    ['daily', 'Farm every day', (n) => Array.from({ length: n }, () => 'farm')],
    ['alternate', 'Every other day', (n) => Array.from({ length: n }, (_, i) => (i % 2 ? 'rest' : 'farm'))],
    ['stretch', 'Farm, then craft', (n) => Array.from({ length: n },
      (_, i) => (i < Math.max(1, Math.round(n * 0.7)) ? 'farm' : 'craft'))],
    ['weekend', 'Weekdays farm, weekend craft', (n) => Array.from({ length: n },
      (_, i) => (i % 7 >= 5 ? 'craft' : 'farm'))],
  ];

  const mode = goal.keepDays ? 'custom' : goal.cycleDays || 0;
  openSheet(`
    <h2>Your days</h2>
    <div class="seg" style="margin-bottom:12px">
      ${[[0, 'Let it choose'], [3, '3'], [7, '7'], [14, '14'], ['custom', 'Custom']].map(([v, label]) => `
        <button type="button" data-cycle="${v}" aria-pressed="${String(mode) === String(v)}">${label}</button>`).join('')}
    </div>
    ${note('Tap a day to change it. Farm days water and harvest; rest days let focus bank untouched; craft days spend it at the station. Crafting runs on farm days too, with whatever is left.')}

    <div class="field">
      <div class="stepper">
        <button type="button" class="btn" data-len="-1" aria-label="One day shorter">−</button>
        <span class="num"><b>${days.length}</b> ${days.length === 1 ? 'day' : 'days'}</span>
        <button type="button" class="btn" data-len="1" aria-label="One day longer">+</button>
      </div>
      <div class="days">
        ${days.map((m, i) => `
          <button type="button" class="day ${m}" data-day="${i}"
            aria-label="Day ${i + 1}, ${LABEL[m]}. Tap to change">
            <span class="n">${i + 1}</span><span class="m">${DAY_ICON[m]}</span></button>`).join('')}
      </div>
      <div class="legend" style="margin-top:6px">
        <span><i class="sw farm"></i> farm ${count('farm')}</span>
        <span><i class="sw rest"></i> rest ${count('rest')}</span>
        <span><i class="sw craft"></i> craft ${count('craft')}</span>
      </div>
    </div>

    <div class="field">
      <label>Or start from a pattern</label>
      <div class="seg">
        ${presets.map(([k, label]) => `
          <button type="button" data-preset="${k}">${label}</button>`).join('')}
      </div>
    </div>

    <div class="toggle">
      <div class="body"><div class="t">Plan around these days</div>
        <div class="d">${goal.keepDays
          ? '"Work it out" keeps this calendar and solves everything inside it.'
          : '"Work it out" may pick a different calendar and overwrite this one.'}</div></div>
      <button class="switch" id="keepDays" aria-pressed="${!!goal.keepDays}"></button>
    </div>

    <div class="field" style="margin-top:12px"><label>Focus in hand at the start</label>
      <input type="number" id="startFocus" inputmode="numeric" min="0" max="${s.focusCap}"
        value="${s.startFocus || 0}">
      <div class="hint">Zero if you emptied it on the last batch.</div></div>

    ${moreHTML('cycle-stats', 'What this cycle gives you', '', `
    <div class="card" style="margin-bottom:12px">
      <div class="bar-row"><span class="n">Harvests this cycle</span>
        <span class="v num">${sim.farmingDays}</span></div>
      <div class="bar-row"><span class="n">Focus the crafting can spend</span>
        <span class="v num">${Math.round(sim.focusBudget).toLocaleString()}</span></div>
      <div class="bar-row"><span class="n">Watering costs</span>
        <span class="v num">${Math.round(sim.wateringPerDay).toLocaleString()} per farm day</span></div>
      ${sim.ledger.shortfall > 0 ? `<div class="bar-row">
        <span class="n">Watering you cannot pay for</span>
        <span class="v num bad">${Math.round(sim.ledger.shortfall).toLocaleString()}</span></div>` : ''}
      <div class="bar-row"><span class="n">Regeneration wasted at the cap</span>
        <span class="v num ${sim.focusWasted ? 'bad' : ''}">${Math.round(sim.focusWasted).toLocaleString()}</span></div>
    </div>

    ${l.cappedOn && sim.focusWasted > 0 ? `<div class="warn-note" style="margin-bottom:12px">
      The bar is full on day ${l.cappedOn}. Every rest day after that throws
      away ${Math.round(s.focusPerDay).toLocaleString()} focus: turn one into a
      craft day, or shorten the cycle.</div>` : ''}`)}

    <div class="sheet-actions">
      <button class="btn primary" id="save">Done</button>
    </div>
  `, {
    onMount(root) {
      // Editing the days by hand is saying you want them kept.
      const touched = () => { if (!goal.keepDays) setGoal({ keepDays: true }); };
      for (const b of $$('[data-day]', root)) {
        b.onclick = () => { setDayMode(Number(b.dataset.day)); touched(); openCycle(); };
      }
      for (const b of $$('[data-len]', root)) {
        b.onclick = () => {
          setScheduleLength(days.length + Number(b.dataset.len));
          touched();
          openCycle();
        };
      }
      for (const b of $$('[data-preset]', root)) {
        b.onclick = () => {
          const make = presets.find(([k]) => k === b.dataset.preset)[2];
          setSchedule(make(days.length));
          touched();
          openCycle();
        };
      }
      $('#keepDays', root).onclick = () => { setGoal({ keepDays: !goal.keepDays }); openCycle(); };
      for (const b of $$('[data-cycle]', root)) {
        b.onclick = () => {
          const v = b.dataset.cycle;
          if (v === 'custom') setGoal({ keepDays: true });
          else {
            setGoal({ cycleDays: Number(v), keepDays: false });
            if (Number(v) > 0) setScheduleLength(Number(v));
          }
          openCycle();
        };
      }
      $('#startFocus', root).onchange = () => {
        setSettings({ startFocus: Math.max(0, Number($('#startFocus', root).value) || 0) });
        openCycle();
      };
      $('#save', root).onclick = () => {
        cycleWas = null;
        closeSheet();
        toast('Cycle saved');
        // A different question deserves a fresh answer; the same one does not.
        if (state.goal.recipeId && solveStamp().goal !== was) runSolve();
      };
    },
    onDismiss: () => { cycleWas = null; },
  });
}

/* ------------------------------------------------------------ stock --- */

/**
 * What is already in the bag. Seeds and calves that came back last round, a
 * stack of herbs you never brewed, a crate of potions waiting for a better
 * price: all of it goes on the pile before anything is planted, so the plan
 * buys less and the profit reads what it really is.
 *
 * The list starts with everything the plan touches, then lets you search for
 * anything else the game knows. A cost is optional — typed-in stock carries
 * nothing, stock the app carried over carries what it left the last cycle
 * with — and it only matters for what the profit line says, never for what
 * the plan does.
 */
export function openStock() {
  const sim = simulateCycle(state.plan, DATA, ctx());
  const stock = state.stock || {};
  let query = '';

  // The things this plan plants, feeds, brews from and makes, in that order.
  const touched = [];
  const seen = new Set();
  const push = (id) => { if (id && !seen.has(id)) { seen.add(id); touched.push(id); } };
  for (const l of sim.farmLines) {
    const ref = l.cycle.ref;
    push(ref.seedId); push(ref.babyId); push(l.cycle.feedId); push(l.itemId);
  }
  for (const l of sim.craftLines) {
    for (const i of l.recipe.inputs || []) push(i.id);
    push(l.recipe.id);
  }
  for (const id of Object.keys(stock)) push(id);

  const line = (id) => {
    const at = stock[id] || { qty: 0, cost: 0 };
    const unit = priceOf(id);
    return `
      <div class="stock-line" data-stock="${esc(id)}">
        <span class="body">
          <span class="title">${esc(nameOf(id))}</span>
          <span class="meta">${unit ? `${silver(unit)} each on the market` : 'no price set'}${
            at.qty > 0 && at.cost > 0.5 ? ` · cost you ${short(at.cost)} in all` : ''}</span>
        </span>
        <input type="number" inputmode="numeric" min="0" step="1" placeholder="0"
          data-qty="${esc(id)}" value="${at.qty || ''}" aria-label="How many ${esc(nameOf(id))}">
      </div>`;
  };

  const results = () => {
    const q = query.toLowerCase();
    if (!q) return '';
    const hits = Object.entries(DATA.items)
      .filter(([id, m]) => !seen.has(id) && (m.name.toLowerCase().includes(q)
        || id.toLowerCase().includes(q)))
      // What you hold is usually the tier you farm, so the higher tiers first.
      .sort((a, b) => (b[1].tier || 0) - (a[1].tier || 0) || a[1].name.localeCompare(b[1].name))
      .slice(0, 12);
    if (!hits.length) return '<div class="hint">Nothing the game knows by that name.</div>';
    return hits.map(([id, m]) => `
      <button class="row" data-add-stock="${esc(id)}">
        <span class="body"><span class="title">${esc(m.name)}</span>
          <span class="meta">${tierText(m.tier || 0, m.enchant || 0)} · ${esc(m.cat || '')}</span></span>
        <span class="amt">+</span>
      </button>`).join('');
  };

  const total = Object.entries(stock).reduce((t, [id, at]) => t + at.qty * priceOf(id), 0);

  openSheet(`
    <h2>What you already have</h2>
    <p class="muted">Anything in the bag is something the plan does not have to
      buy. Seeds, calves, herbs, potions — type how many you hold. What the plan
      does not use is sold at the end like any other surplus.</p>

    <div class="field">
      <input type="search" id="stockSearch" placeholder="Add anything else…"
        autocomplete="off">
      <div id="stockHits"></div>
    </div>

    <div class="card" id="stockList">
      ${touched.map(line).join('')
        || '<div class="hint">Nothing in the plan yet. Search above to add something.</div>'}
    </div>
    <div class="hint" style="margin-top:8px">${total > 0
      ? `Worth about ${short(total)} at today's prices.` : ''}
      Costs are optional: use "Start next cycle from here" on the Plan screen
      and they are carried in for you, at what the last cycle paid.</div>

    <div class="sheet-actions">
      <button class="btn" id="clearStock">Empty the bag</button>
      <button class="btn primary" id="done">Done</button>
    </div>
  `, {
    onMount(root) {
      const search = $('#stockSearch', root);
      const hits = $('#stockHits', root);
      search.oninput = () => {
        query = search.value.trim();
        hits.innerHTML = results();
        for (const b of $$('[data-add-stock]', hits)) {
          b.onclick = () => {
            const id = b.dataset.addStock;
            setStock(id, 1);
            openStock();
          };
        }
      };
      for (const box of $$('[data-qty]', root)) {
        box.onchange = () => setStock(box.dataset.qty, Number(box.value) || 0);
      }
      $('#clearStock', root).onclick = () => { clearStock(); openStock(); };
      $('#done', root).onclick = () => { closeSheet(); toast('Bag saved'); };
    },
  });
}

/**
 * Start the next cycle where this one ends. What is left on the pile goes
 * into the bag carrying what it cost, and the focus you did not spend is what
 * you start with. Pressing it twice is the same as once.
 */
export function carryLeftoversIn() {
  const sim = simulateCycle(state.plan, DATA, ctx());
  const rows = sim.stock.map((x) => ({ id: x.id, qty: x.qty, cost: x.cost || 0 }));
  carryStockIn(rows, sim.focusCarried);
  toast(rows.length
    ? `${rows.length} ${rows.length === 1 ? 'thing' : 'things'} carried into the bag`
    : `Bag emptied · ${Math.round(sim.focusCarried || 0).toLocaleString()} focus carried`);
}

/* ------------------------------------------------------ destiny board -- */

/**
 * Your destiny board levels, which is where every focus cost really comes from.
 *
 * Both halves matter and the mastery half is easy to forget: the branch node
 * covers everything under it, and each specialisation also quietly cheapens its
 * siblings. Levels are shown against the things you actually farm and brew.
 */
/* Gathering is a branch of the same board, and its nodes come from the
 * gathering tables rather than from the focus tables, because what they buy is
 * yield and swing speed rather than a cheaper craft. Same list of levels
 * underneath, so there is one destiny board and not two. */
export const GATHER_BRANCH = 'Gathering';

export function openBoard(branch = null) {
  rememberMastery();
  const s = state.settings;
  const nodes = s.focusNodes || [];
  /* Group by the name the game gives the top of each tree. With weapons and
   * armour loaded that is forty-odd branches rather than five, so they are
   * sorted and the whole strip wraps. */
  const labelOf = (n) => n.branchLabel || n.branch;
  const branches = [...new Set(nodes.map(labelOf))].sort();
  const gatherNodes = s.gathering?.board || [];
  /* Farming branches first: they are the ones a potion plan cares about, and
   * with the gear file loaded the rest is forty-odd names. */
  const farmIds = new Set([
    ...DATA.recipes.map((r) => r.id), ...DATA.plants.map((p) => p.id), ...DATA.animals.map((a) => a.id),
  ]);
  const isFarming = (b) => nodes.some((n) => labelOf(n) === b
    && n.rules.some((r) => r.patterns.some((pat) => [...farmIds].some((id) => id.includes(String(pat).replace(/\*/g, ''))))));
  const farming = branches.filter(isFarming);
  const gear = branches.filter((b) => !farming.includes(b));
  const BY_CAT = { potion: 'Alchemist', food: 'Chef' };
  const first = DATA.recipes.find((r) => r.id === state.plan.crafts[0]?.recipeId);
  const wanted = first ? (first.category.startsWith('meat_') ? 'Animal Breeder' : BY_CAT[first.category]) : null;
  const most = branches.map((b) => [b, nodes.filter((n) => labelOf(n) === b && state.nodeLevels[n.id]).length])
    .sort((a, b) => b[1] - a[1])[0];
  const open = branch === GATHER_BRANCH ? GATHER_BRANCH
    : branches.includes(branch) ? branch
      : branches.includes(wanted) ? wanted
        : most && most[1] > 0 ? most[0] : farming[0] || branches[0];
  const mine = nodes.filter((n) => labelOf(n) === open);
  const gathering = open === GATHER_BRANCH;

  // What your current levels do to the things on your plan.
  const examples = [];
  for (const job of state.plan.crafts.slice(0, 3)) {
    const r = DATA.recipes.find((x) => x.id === job.recipeId);
    if (r) examples.push({ id: r.id, name: r.name, base: r.focus });
  }
  for (const row of state.plan.plots.slice(0, 2)) {
    const pl = DATA.plants.find((x) => x.id === row.itemId);
    if (pl) examples.push({ id: pl.id, name: `${pl.name} (watering)`, base: pl.focusCost });
  }

  const nodeRow = (n) => {
    const level = state.nodeLevels[n.id] || '';
    const own = n.rules.find((r) => r.patterns.length <= 2);
    const shared = n.rules.find((r) => r !== own);
    const what = [
      own ? `+${own.bonus} to its own` : null,
      shared ? `+${shared.bonus} to the whole branch` : null,
    ].filter(Boolean).join(', ');
    return `
      <div class="row" style="gap:8px">
        <span class="ico">${n.kind === 'mastery' ? '\u2B50' : '\u2022'}</span>
        <span class="body"><span class="title">${esc(n.name)}</span>
          <span class="meta">${esc(what)} per level</span></span>
        <input type="number" class="spec-input" data-node="${esc(n.id)}"
          inputmode="numeric" min="0" max="100" placeholder="0"
          value="${level}" aria-label="Level for ${esc(n.name)}">
      </div>`;
  };

  /* A gathering node buys yield and swing speed rather than a cheaper craft,
   * so its row says what it is worth in those terms instead. */
  const gatherRow = (n) => {
    const level = state.nodeLevels[n.id] || '';
    const on = Number(level) || 0;
    return `
      <div class="row" style="gap:8px">
        <span class="ico">${FAMILY_ICON[n.family] || '\u2022'}</span>
        <span class="body"><span class="title">${esc(n.name)}</span>
          <span class="meta">${esc(on
      ? `+${pct(on * n.yieldPerLevel, 0)} yield, +${pct(Math.min(on * n.speedPerLevel,
        s.gathering.speedCap), 0)} speed at ${on}`
      : `+${pct(n.yieldPerLevel, 1)} yield and speed a level, to ${n.maxLevel}`)}</span></span>
        <input type="number" class="spec-input" data-node="${esc(n.id)}"
          inputmode="numeric" min="0" max="${n.maxLevel}" placeholder="0"
          value="${level}" aria-label="Level for ${esc(n.name)}">
      </div>`;
  };

  openSheet(`
    <h2>Destiny board</h2>
    <div class="field">
      <select id="branch">
        <optgroup label="Farming">${farming.map((b) => `
          <option value="${esc(b)}" ${b === open ? 'selected' : ''}>${esc(b)}</option>`).join('')}</optgroup>
        ${gatherNodes.length ? `<optgroup label="Gathering">
          <option value="${esc(GATHER_BRANCH)}" ${gathering ? 'selected' : ''}>Gatherer</option>
        </optgroup>` : ''}
        ${gear.length ? `<optgroup label="Gear">${gear.map((b) => `
          <option value="${esc(b)}" ${b === open ? 'selected' : ''}>${esc(b)}</option>`).join('')}</optgroup>` : ''}
      </select>
    </div>

    ${gathering ? (s.gathering.families || []).map((f) => {
      const rows = gatherNodes.filter((n) => n.family === f);
      return rows.length ? `
        <div class="section-head" style="margin-top:14px"><h2>${esc(FAMILY_LABEL[f] || f)}</h2></div>
        ${rows.map(gatherRow).join('')}` : '';
    }).join('') : ''}
    ${gathering ? note(`Every level is +${pct(0.005, 1)} to how much a swing gives AND +${
      pct(0.005, 1)} to how fast you swing, and the speed half is capped at +${
      pct(s.gathering.speedCap, 0)} across everything. At 100 that is half again as
      much per swing, which is the largest single bonus in gathering — bigger than
      a full set, an Avalonian tool and a pork pie together.`) : ''}

    ${gathering ? '' : mine.filter((n) => n.kind === 'mastery').map(nodeRow).join('')}
    ${!gathering && mine.some((n) => n.kind === 'spec')
      ? `<div class="section-head" style="margin-top:14px"><h2>Specialisations</h2></div>` : ''}
    ${gathering ? '' : mine.filter((n) => n.kind === 'spec').map(nodeRow).join('')}

    ${!gathering && examples.length ? `
      <div class="section-head" style="margin-top:16px"><h2>What that costs you</h2></div>
      <div class="card">
        ${examples.map((e) => {
          const eff = focusEfficiency(e.id, s).total;
          const cost = focusCostAt(e.base, eff, s.focusCostConstant);
          return `<div class="bar-row">
            <span class="n">${esc(e.name)}</span>
            <span class="v num">${Math.round(cost)} focus${eff > 0
              ? ` <small>was ${Math.round(e.base)}</small>` : ''}</span></div>`;
        }).join('')}
        <div class="bar-row" style="border-top:1px solid var(--line);padding-top:10px">
          <span class="n">Every 100 efficiency</span>
          <span class="v num">halves the cost</span></div>
      </div>` : ''}
    ${gathering ? '' : note('The branch node counts for everything under it, and every specialisation also cheapens its siblings a little: levelling Potato Schnapps makes healing potions cheaper too.')}

    <div class="sheet-actions">
      <button class="btn primary" id="done">Done</button>
    </div>
  `, {
    onMount(root) {
      $('#branch', root).onchange = (e) => openBoard(e.target.value);
      for (const input of $$('[data-node]', root)) {
        input.onchange = () => { setNodeLevel(input.dataset.node, input.value); openBoard(open); };
      }
      $('#done', root).onclick = () => { leaveMastery(); closeSheet(); };
    },
    onDismiss: leaveMastery,
  });
}

/* --------------------------------------------------- the gathering kit -- */

const FAMILY_LABEL = {
  WOOD: 'Wood', ORE: 'Ore', FIBER: 'Fibre', HIDE: 'Hide', ROCK: 'Rock',
};
const FAMILY_ICON = {
  WOOD: '\u{1FAB5}', ORE: '⛰️', FIBER: '\u{1F33F}',
  HIDE: '\u{1F98C}', ROCK: '\u{1FAA8}',
};

/** How good the cluster is, which is the only thing that sets the grade odds. */
const ZONES = [
  ['royal', 'Royal', 'Royal continent and the starter zones'],
  ['outlandsLow', 'Outlands, low', 'A low-quality black-zone cluster'],
  ['outlandsMedium', 'Outlands, medium', 'Twice the enchanted of a royal zone'],
  ['outlandsHigh', 'Outlands, high', 'Four times the enchanted of a royal zone'],
];

/** Zone colour, which changes gathering fame and nothing else at all. */
const DANGERS = [
  ['yellow', 'Yellow'], ['red', 'Red'], ['black', 'Black'],
  ['black3', 'Deep black (3)'], ['black6', 'Deepest black (6)'],
];

const GATHER_SLOTS = [['head', 'Cap'], ['armor', 'Garb'], ['shoes', 'Workboots']];

/** Which resource the preview is about. Not saved: it is a question, not a plan. */
let gatherPeek = { family: 'WOOD', tier: 5 };

/**
 * Your gathering kit, and what it is worth.
 *
 * Two levers here and confusing them is how every other calculator gets this
 * wrong. The TOOL decides how long a swing takes. Everything else decides how
 * much a swing gives, which is not the same thing as being faster - it means
 * needing fewer swings. Only the gathering potion and the destiny board touch
 * the swing itself, and their total is hard capped at 40%.
 *
 * Nothing in here is switched on to begin with. A full set and a pork pie is
 * most of a second run's worth of resources, so assuming them would double
 * every answer on the screen for someone who owns neither.
 */
export function openGatherSetup(forId = null) {
  const s = state.settings;
  const G = s.gathering;
  const kit = kitOf(s);
  const at = forId ? rawIdOf(forId) : null;
  if (at) gatherPeek = { family: at.family, tier: at.tier };
  const { family, tier } = gatherPeek;
  const peekId = rawId(family, tier, at?.enchant || 0);

  const seg = (name, options, chosen, attr) => `
    <div class="seg small">${options.map(([v, label, title]) => `
      <button data-${attr}="${esc(String(v))}" aria-pressed="${String(v) === String(chosen)}"
        ${title ? `title="${esc(title)}"` : ''}>${esc(label)}</button>`).join('')}</div>`;

  /* A row of tier buttons. `none` is a real answer for a piece of gear you do
   * not own and is not one for the resource the preview is about. */
  const tiers = (attr, chosen, { min = 2, none = true } = {}) => seg(attr,
    [...(none ? [[0, 'none']] : []),
      ...Array.from({ length: 9 - min }, (_, i) => [min + i, `T${min + i}`])],
    chosen, attr);

  /* The preview. Everything above it is a control and this is the answer, so it
   * sits at the top where it can be watched changing rather than at the bottom
   * where it would have to be scrolled to. */
  const run = gatherRun(peekId, { qty: 999, settings: s });
  const yld = gatherYield(family, tier, at?.enchant || 0, s);
  const speed = gatherSpeed(family, tier, s);
  const key = rateKey(family, tier, kit);
  const measured = kit.measured[key];

  const part = (label, value, extra = '') => (value > 0 ? `
    <div class="bar-row"><span class="n">${esc(label)}${extra ? ` <small>${esc(extra)}</small>` : ''}</span>
      <span class="v num good">+${pct(value, 1)}</span></div>` : '');

  const preview = run?.impossible ? `
    <div class="warn-note bad">${esc(run.why)}.</div>`
    : run ? `
    <div class="card">
      <div class="bar-row"><span class="n">A swing</span>
        <span class="v num">${run.rate.secondsPerSwing.toFixed(1)}s${
  run.rate.factor !== 1 ? ` <small>T${kit.toolTier} tool on a T${tier} node</small>` : ''}</span></div>
      <div class="bar-row"><span class="n">Gives</span>
        <span class="v num">${run.rate.unitsPerSwing.toFixed(2)}</span></div>
      ${part('Gatherer set', yld.gear, yld.ramped ? '' : 'still ramping')}
      ${part('Avalonian tool', yld.tool)}
      ${part(G.food[kit.food]?.name || 'Pie', yld.food)}
      ${part(G.potions[kit.potion]?.name || 'Potion', yld.potion)}
      ${part('Destiny board', yld.spec)}
      ${part('Premium', yld.premium, kit.premiumMode === 'multiply' ? 'multiplied' : 'added')}
      ${speed.total > 0 ? `
        <div class="bar-row"><span class="n">Swing speed${speed.capped ? ' <small>capped</small>' : ''}</span>
          <span class="v num good">+${pct(speed.total, 0)}</span></div>` : ''}
      <div class="bar-row total"><span class="n">999 ${esc(nameOf(peekId))}</span>
        <span class="v num">${gMin(run.swingSeconds)} swinging</span></div>
      <div class="bar-row"><span class="n">${measured
  ? `At your measured ${short(run.perHour)} an hour` : 'In real hours'}</span>
        <span class="v num ${measured ? '' : 'flat'}">${run.hours
  ? hours(run.hours) : 'not until you time a run'}</span></div>
      <div class="bar-row"><span class="n">Off</span>
        <span class="v num">${short(Math.ceil(run.nodes))} nodes${
  run.rate.node.respawn ? ` <small>${Math.round(run.rate.node.respawn / 60)} min respawn</small>` : ''}</span></div>
    </div>` : '<div class="hint">No node of that sort at that tier.</div>';

  const measuredRows = Object.entries(kit.measured).map(([k, v]) => {
    const [fam, t, kind, zone] = k.split(':');
    return `
      <div class="stock-line">
        <span class="body"><span class="title">${esc(FAMILY_LABEL[fam] || fam)} T${esc(t)}</span>
          <span class="meta">${esc(G.kindLabels[kind] || kind)} · ${esc(
  (ZONES.find(([z]) => z === zone) || [, zone])[1])} · ${short(v.per10min * 6)} an hour</span></span>
        <input type="number" inputmode="numeric" min="0" step="1" data-measured="${esc(k)}"
          value="${v.per10min}" aria-label="Per ten minutes">
      </div>`;
  }).join('');

  openSheet(`
    <h2>Your gathering kit</h2>
    <p class="muted">Two levers, and they are not the same one. Your <b>tool</b>
      decides how long a swing takes. Everything else — the set, the Avalonian
      tool's own bonus, the pie, the board, premium — decides how much a swing
      gives, which means needing fewer swings rather than swinging faster.</p>

    <div class="section-head"><h2>What it comes to</h2>
      <span class="right num">${esc(FAMILY_LABEL[family])} T${tier}</span></div>
    <div class="seg small" style="margin-bottom:8px">
      ${(G.families || []).map((f) => `
        <button data-peek-family="${esc(f)}" aria-pressed="${f === family}">${
  FAMILY_ICON[f] || ''} ${esc(FAMILY_LABEL[f] || f)}</button>`).join('')}
    </div>
    ${tiers('peek-tier', tier, { min: 1, none: false })}
    <div style="height:8px"></div>
    ${preview}

    <div class="section-head" style="margin-top:16px"><h2>Tool</h2></div>
    ${tiers('tool-tier', kit.toolTier)}
    <div class="card tight" style="margin-top:8px">
      ${kitToggle('toolAvalon', 'Avalonian tool',
    'Only an Avalonian tool carries a gathering bonus of its own.', kit.toolAvalon)}
    </div>
    <div class="hint">A plain tool has no passive slot and gives no yield at all,
      however good it is — it only decides the swing. A tool two tiers under the
      node and the game will not let you harvest it.</div>

    <div class="section-head" style="margin-top:16px"><h2>Gatherer set</h2></div>
    <div class="card">
      ${GATHER_SLOTS.map(([slot, label]) => `
        <div class="field" style="margin-bottom:10px">
          <label>${esc(label)}</label>
          ${tiers(`gear-${slot}`, kit.gear[slot])}
        </div>`).join('')}
    </div>
    <div class="hint">Every piece is hard tier-gated: a T5 set on a T6 node is
      worth exactly nothing. It also ramps — a little every 30 seconds up to ten
      stacks, so the number on the tooltip is what you have after five minutes.
      The gatherer backpack is weight only and carries no yield, so it changes
      how many trips you make and not how much you come back with.</div>

    <div class="section-head" style="margin-top:16px"><h2>Where you swing</h2></div>
    <div class="field">
      <label for="gatherKind">Sort of node</label>
      <select id="gatherKind">${Object.entries(G.kindLabels)
    .filter(([k]) => G.nodes[family]?.[k])
    .map(([k, label]) => `<option value="${esc(k)}" ${k === kit.kind ? 'selected' : ''}>${
  esc(label)}</option>`).join('')}</select>
    </div>
    <div class="field">
      <label>Cluster quality — this is what sets the grade odds</label>
      ${seg('zone', ZONES.map(([v, label, title]) => [v, label, title]), kit.zone, 'zone')}
      <div class="hint">${(G.rareOdds[kit.zone] || []).slice(1, 4)
    .map((o, i) => `.${i + 1} ${pct(o, o < 0.01 ? 2 : 1)}`).join(' · ')} of harvests.</div>
    </div>
    <div class="field">
      <label>Zone colour — fame only, never yield</label>
      ${seg('danger', DANGERS, kit.danger, 'danger')}
    </div>

    <div class="section-head" style="margin-top:16px"><h2>Pie and potion</h2></div>
    <div class="field">
      <label for="gatherFood">Pie</label>
      <select id="gatherFood">
        <option value="" ${kit.food ? '' : 'selected'}>None</option>
        ${Object.entries(G.food).map(([id, f]) => `
          <option value="${esc(id)}" ${id === kit.food ? 'selected' : ''}>T${f.tier} ${
  esc(f.name)} · +${pct(f.grades['0'].gatheringyield, 0)}</option>`).join('')}
      </select>
      ${kit.food ? seg('food-enchant', GRADES, kit.foodEnchant, 'food-enchant') : ''}
    </div>
    <div class="field">
      <label for="gatherPotion">Potion</label>
      <select id="gatherPotion">
        <option value="" ${kit.potion ? '' : 'selected'}>None</option>
        ${Object.entries(G.potions).map(([id, f]) => `
          <option value="${esc(id)}" ${id === kit.potion ? 'selected' : ''}>T${f.tier} ${
  esc(f.name)} · +${pct(f.grades['0'].gatheringspeed, 0)} speed</option>`).join('')}
      </select>
      ${kit.potion ? seg('potion-enchant', GRADES, kit.potionEnchant, 'potion-enchant') : ''}
    </div>
    <div class="hint">A pie has no resource filter of any kind — it covers every
      family and every grade. A gathering potion lasts half a minute and is the
      only thing besides the board that makes you swing faster; the two together
      are capped at +${pct(G.speedCap, 0)}.</div>

    <div class="section-head" style="margin-top:16px"><h2>Destiny board</h2></div>
    ${rowHTML({
    act: 'gather-board', icon: ICON.board, title: 'Gathering nodes',
    meta: `${(G.board || []).filter((n) => state.nodeLevels[n.id]).length} of ${
      (G.board || []).length} set · +${pct(0.005, 1)} yield and speed a level`,
    right: go(),
  })}

    <div class="section-head" style="margin-top:16px"><h2>Your real rate</h2></div>
    <div class="field">
      <label for="gatherMeasured">${esc(FAMILY_LABEL[family])} T${tier}, in ten minutes</label>
      <input type="number" id="gatherMeasured" inputmode="numeric" min="0" step="1"
        placeholder="0" value="${measured?.per10min || ''}">
      <div class="hint">Stand where you would really farm, gather for ten minutes
        by the clock, and type how many resources you came home with — every
        grade together. That is the one number no game file can give: node
        density, travel, competition and live respawn are in no dump. Until you
        fill one in the app quotes the swing floor and says the hours are
        unknown, rather than inventing a number.</div>
    </div>
    ${measuredRows ? `<div class="card">${measuredRows}</div>` : ''}

    <div class="section-head" style="margin-top:16px"><h2>The two guesses</h2></div>
    <div class="field">
      <label>Premium's +${pct(G.premiumYield, 0)} gathering yield</label>
      ${seg('premium-mode', [['add', 'Adds to the pool'], ['multiply', 'Multiplies the total']],
    kit.premiumMode, 'premium-mode')}
      <div class="hint">The store page advertises it and no table in the game
        files implements it, so which of the two it means is genuinely unknown.
        Adding is the conservative reading and the default.</div>
    </div>
    <div class="field">
      <label>Does the set pay on an enchanted node?</label>
      ${seg('covers', [['yes', 'Yes'], ['no', 'No']], kit.gearCoversEnchanted ? 'yes' : 'no', 'covers')}
      <div class="hint">The set and the Avalonian tool name the plain resource
        type exactly, and an enchanted log is a different resource type. The
        files do not settle it. The pie and the board reach it either way.</div>
    </div>

    <div class="sheet-actions">
      <button class="btn primary" id="done">Done</button>
    </div>
  `, {
    onMount(root) {
      const again = () => openGatherSetup(forId);
      const wireSeg = (attr, fn) => {
        for (const b of $$(`[data-${attr}]`, root)) {
          b.onclick = () => { fn(b.dataset[camel(attr)]); again(); };
        }
      };
      wireSeg('peek-family', (v) => { gatherPeek = { ...gatherPeek, family: v }; });
      wireSeg('peek-tier', (v) => { gatherPeek = { ...gatherPeek, tier: Number(v) }; });
      wireSeg('tool-tier', (v) => setGather({ toolTier: Number(v) }));
      for (const [slot] of GATHER_SLOTS) {
        wireSeg(`gear-${slot}`, (v) => setGather({
          gear: { ...state.settings.gather.gear, [slot]: Number(v) },
        }));
      }
      wireSeg('zone', (v) => setGather({ zone: v }));
      wireSeg('danger', (v) => setGather({ danger: v }));
      wireSeg('food-enchant', (v) => setGather({ foodEnchant: Number(v) }));
      wireSeg('potion-enchant', (v) => setGather({ potionEnchant: Number(v) }));
      wireSeg('premium-mode', (v) => setGather({ premiumMode: v }));
      wireSeg('covers', (v) => setGather({ gearCoversEnchanted: v === 'yes' }));

      for (const t of $$('[data-kit-toggle]', root)) {
        t.onclick = () => {
          setGather({ [t.dataset.kitToggle]: !state.settings.gather[t.dataset.kitToggle] });
          again();
        };
      }
      $('#gatherKind', root).onchange = (e) => { setGather({ kind: e.target.value }); again(); };
      $('#gatherFood', root).onchange = (e) => { setGather({ food: e.target.value }); again(); };
      $('#gatherPotion', root).onchange = (e) => { setGather({ potion: e.target.value }); again(); };
      $('#gatherMeasured', root).onchange = (e) => { setMeasured(key, e.target.value); again(); };
      for (const box of $$('[data-measured]', root)) {
        box.onchange = () => { setMeasured(box.dataset.measured, box.value); again(); };
      }
      /* A data-act inside a sheet reaches no delegate, so the one row that
       * leaves for another sheet is wired by hand. */
      const board = $('[data-act="gather-board"]', root);
      if (board) board.onclick = () => openBoard(GATHER_BRANCH);
      $('#done', root).onclick = () => { closeSheet(); toast('Kit saved'); };
    },
  });
}

const GRADES = [[0, 'plain'], [1, '.1'], [2, '.2'], [3, '.3']];

/** "gear-head" -> "gearHead", to read the dataset the browser built. */
const camel = (attr) => attr.replace(/-(\w)/g, (_, c) => c.toUpperCase());

/** Minutes, or hours once minutes stop being readable. */
const gMin = (seconds) => (seconds < 5400
  ? `${(seconds / 60).toFixed(seconds < 600 ? 1 : 0)}m` : hours(seconds / 3600));

/** A switch inside the kit sheet, which writes to settings.gather and not to settings. */
const kitToggle = (key, title, desc, on) => `
  <button class="toggle" type="button" role="switch" aria-checked="${on}"
    data-kit-toggle="${esc(key)}" aria-label="${esc(title)}">
    <span class="body"><span class="t">${esc(title)}</span>
      <span class="d">${esc(desc)}</span></span>
    <span class="switch" aria-pressed="${on}"></span>
  </button>`;

/**
 * One pile of one resource, and every way out of it.
 *
 * The question this whole half of the app exists to answer. Sell the logs,
 * refine them into planks, transmute them a grade up, transmute them a tier up,
 * or transmute and then refine — five completely different businesses off the
 * same tree, all costed off the same swings, the same city, the same focus and
 * the same tax. Which one wins moves with the market week to week, which is why
 * it is a screen and not a rule of thumb.
 */
export function openResourceExits(id, qty = 999) {
  const s = state.settings;
  const ctxNow = {
    recipeOf, priceOf, costOf, sellPriceOf: priceOf,
    settings: s, cityId: s.craftCity,
  };
  const rows = resourceExits(id, ctxNow, { qty });
  const ready = rows.filter((r) => !r.missing.length);
  const best = ready[0] || null;
  const blocked = rows[0]?.pnl?.gathered?.[id];
  const city = cityFor(s);

  const routeRow = (r, i) => {
    const gap = best && r !== best && r.silverPerSwingSecond != null
      ? r.silverPerSwingSecond - best.silverPerSwingSecond : 0;
    return rowHTML({
      attrs: r.pnl.recipe ? `data-route="${esc(r.pnl.recipe.id)}" data-route-key="${esc(r.key)}"` : '',
      tagName: r.pnl.recipe ? 'button' : 'div',
      icon: i === 0 && r === best ? '\u{1F947}' : ICON.raw,
      cls: r.missing.length ? 'warn' : '',
      title: `${esc(r.label)} → ${short(r.made)} ${esc(nameOf(r.pnl.recipe
        ? (r.pnl.recipe.out || r.pnl.recipe.id) : id))}`,
      meta: esc(r.missing.length
        ? `needs a price for ${r.missing.slice(0, 2).map(nameOf).join(', ')}`
        : [
          `${short(r.profit)} profit`,
          r.focus > 0 ? `${short(r.focus)} focus` : 'no focus',
          r.byproductRevenue > 0.5 ? `${short(r.byproductRevenue)} on the side` : '',
          gap < -0.5 ? `${short(-gap)}/swing-s behind` : '',
        ].filter(Boolean).join(' · ')),
      right: r.missing.length ? tag('Set prices')
        : amt(r.silverPerSwingSecond, { unit: '/swing-s' }),
    });
  };

  openSheet(`
    <h2>${esc(nameOf(id))}</h2>
    <p class="muted">What ${short(qty)} of them are worth, by what you do next.
      Every row is the same pile off the same swings, refined in
      ${esc(city?.name || 'your crafting city')} and taxed the same way, so the
      difference between two rows is the route and nothing else.</p>

    ${blocked?.impossible ? `<div class="warn-note bad">${esc(blocked.why)}.</div>` : `
      <div class="card">
        <div class="bar-row"><span class="n">Swinging, at the game's own floor</span>
          <span class="v num">${gMin(blocked?.swingSeconds || 0)}</span></div>
        <div class="bar-row"><span class="n">Harvests, off ${short(Math.ceil(blocked?.nodes || 0))} nodes</span>
          <span class="v num">${short(blocked?.harvests || 0)}</span></div>
        ${blocked?.hours ? `
          <div class="bar-row"><span class="n">At your measured pace</span>
            <span class="v num">${hours(blocked.hours)}</span></div>` : ''}
        ${best ? `
          <div class="bar-row total"><span class="n">Best route</span>
            <span class="v num good">${short(best.profit)} · ${esc(best.label.toLowerCase())}</span></div>` : ''}
      </div>`}

    <div class="section-head" style="margin-top:14px"><h2>Every way out</h2></div>
    ${rows.map(routeRow).join('') || '<div class="hint">Nothing this can become.</div>'}

    ${(blocked?.assumed || []).length ? note(`Yours rather than the game's: ${
      esc(blocked.assumed.join('; '))}.`) : ''}
    ${note('Tap a route to open it in Craft, where you can change the city, the'
      + ' focus and how deep you refine.')}

    <div class="sheet-actions">
      <button class="btn" id="kit">Change the kit</button>
      <button class="btn primary" id="done">Done</button>
    </div>
  `, {
    onMount(root) {
      for (const b of $$('[data-route]', root)) {
        b.onclick = () => {
          const key = b.dataset.routeKey;
          /* The two-step route has to say it is two steps, or Craft would buy
           * the enchanted logs it was supposed to transmute. */
          setCraftRoute(b.dataset.route, {
            make: key === 'enchantRefine' ? [enchantUp(id)] : [],
            gather: [id],
            qty: rows.find((r) => r.key === key)?.made || 0,
          });
          closeSheet();
          navigate('craft');
        };
      }
      $('#kit', root).onclick = () => openGatherSetup(id);
      $('#done', root).onclick = closeSheet;
    },
  });
}

/* ----------------------------------------------- pick a thing to craft - */

/**
 * The Craft tab's picker. Every recipe the app knows in one list — potions,
 * food, butchering, refining, weapons, armour and gear — because the tab
 * costs all of them the same way and the split into separate screens was
 * never a difference the game makes.
 */
export function openCraftPick() {
  ensureGear();
  let query = '';
  let group = craftTarget() ? craftGroupOf(recipeOf(craftTarget()) || {}) : 'weapon';

  const render = (root) => {
    const all = allRecipes();
    const hits = all.filter((r) => {
      if (query) {
        const q = query.toLowerCase();
        return r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q);
      }
      return craftGroupOf(r) === group;
    });
    // A search runs across every group; a browse stays inside one. Either
    // way the list is capped, because six thousand rows in a phone sheet is
    // a scroll nobody finishes.
    const shown = hits
      .sort((a, b) => a.tier - b.tier || (a.enchant || 0) - (b.enchant || 0)
        || a.name.localeCompare(b.name))
      .slice(0, 200);

    $('#craftList', root).innerHTML = `
      ${shown.map((r) => recipeRow(r, craftTarget(), groupIcon(craftGroupOf(r)), 'data-pick')).join('')}
      ${hits.length > shown.length
        ? `<div class="hint centered">${hits.length - shown.length} more — type to narrow it down.</div>`
        : ''}
      ${!hits.length ? `<div class="empty"><span class="e">\u{1F50D}</span>${
        gearReady() || query ? 'Nothing matches that.'
          : 'Still loading the weapon and armour list…'}</div>` : ''}`;

    for (const b of $$('[data-pick]', root)) {
      b.onclick = () => { setCraftTarget(b.dataset.pick); closeSheet(); };
    }
  };

  openSheet(`
    <h2>What are you making?</h2>
    <div class="field">
      <input type="search" id="craftSearch" placeholder="Search every recipe…"
        autocomplete="off">
    </div>
    <div class="seg" style="flex-wrap:wrap" id="craftGroups">
      ${GROUPS.map(([k, label]) => `
        <button data-group="${esc(k)}" aria-pressed="${k === group}">${esc(label)}</button>`).join('')}
    </div>
    <div id="craftList" style="margin-top:10px"></div>
  `, {
    onMount(root) {
      render(root);
      const search = $('#craftSearch', root);
      search.oninput = () => { query = search.value.trim(); render(root); };
      for (const b of $$('[data-group]', root)) {
        b.onclick = () => {
          group = b.dataset.group;
          query = '';
          search.value = '';
          for (const o of $$('[data-group]', root)) {
            o.setAttribute('aria-pressed', String(o.dataset.group === group));
          }
          render(root);
        };
      }
    },
  });
}

/**
 * Prices for exactly what the Craft tab is looking at.
 *
 * The whole-app fetch walks 500 farming items; the equipment list is 7,500
 * and nobody wants all of them. A run touches a dozen, so this asks for those
 * and nothing else, and it asks the Black Market separately because the Black
 * Market is quoted on its buy orders rather than on a shelf price.
 */
export async function runCraftPriceFetch() {
  const run = currentRun();
  if (!run) { toast('Pick something to make first'); return; }
  const ids = [...new Set([
    run.recipe.id,
    ...run.buys.map((b) => b.id),
    ...run.steps.map((s) => s.recipe.id),
  ])];
  // Only equipment is tradable on the Black Market, so only equipment is
  // worth asking it about.
  const gearGroups = new Set(['weapon', 'armor', 'gear']);
  const bmIds = [run.recipe.id, ...run.steps.map((s) => s.recipe.id)]
    .filter((id) => gearGroups.has(craftGroupOf(recipeOf(id) || {})));

  const sheet = openSheet(`
    <h2>Fetching prices</h2>
    <p class="muted">${ids.length} items from ${esc(state.settings.server)} ·
      ${esc(state.settings.priceCity)}${bmIds.length
        ? `, and ${bmIds.length} from the Black Market` : ''}</p>
    <div class="meter big"><i class="spent" id="bar" style="width:6%"></i></div>
    <p class="muted" id="status">Contacting the Albion Online Data Project…</p>
    <div class="sheet-actions"><button class="btn ghost" id="cancel">Cancel</button></div>
  `);
  const controller = new AbortController();
  $('#cancel', sheet).onclick = () => { controller.abort(); closeSheet(); };

  try {
    const out = await fetchPrices(ids, {
      server: state.settings.server,
      city: state.settings.priceCity,
      // Every quality, because on equipment that is most of the answer: a
      // masterpiece and a plain one are two different goods.
      qualities: QUALITIES,
      signal: controller.signal,
    });
    setQualityPrices(out.prices);

    let bmFound = 0;
    if (bmIds.length) {
      const st = $('#status', sheet);
      if (st) st.textContent = 'Asking the Black Market…';
      const bm = await fetchPrices(bmIds, {
        server: state.settings.server,
        city: BLACK_MARKET,
        field: 'buy',
        qualities: QUALITIES,
        signal: controller.signal,
      });
      setQualityPrices(bm.prices, true);
      bmFound = bm.found.length;
    }
    closeSheet();
    toast(`${out.found.length} prices updated${bmFound ? `, ${bmFound} from the Black Market` : ''}`);
  } catch (err) {
    if (controller.signal.aborted) return;
    closeSheet();
    openSheet(`
      <h2>Could not fetch prices</h2>
      <p class="muted">${esc(explain(err))}</p>
      <div class="sheet-actions">
        <button class="btn primary" id="ok">Enter them by hand</button>
      </div>
    `, { onMount: (r) => { $('#ok', r).onclick = closeSheet; } });
  }
}

/**
 * Prices for one slice of the equipment list, so the Best tab can rank it.
 *
 * A slice is one group at one tier — twenty to two hundred rows — which is a
 * couple of requests. Pricing all 6,671 would be 134 of them, and a ranked
 * list of things you cannot make at a tier you are not is not worth the wait.
 */
export async function runScanPriceFetch() {
  const ids = scanIds();
  const bmIds = scanBlackIds();
  if (!ids.length) { toast('Nothing to price in this slice'); return; }

  const sheet = openSheet(`
    <h2>Fetching prices</h2>
    <p class="muted">${ids.length} items from ${esc(state.settings.server)} ·
      ${esc(state.settings.priceCity)}${bmIds.length
        ? `, and ${bmIds.length} from the Black Market` : ''}</p>
    <div class="meter big"><i class="spent" id="bar" style="width:6%"></i></div>
    <p class="muted" id="status">Contacting the Albion Online Data Project…</p>
    <div class="sheet-actions"><button class="btn ghost" id="cancel">Cancel</button></div>
  `);
  const controller = new AbortController();
  $('#cancel', sheet).onclick = () => { controller.abort(); closeSheet(); };

  try {
    const out = await fetchPrices(ids, {
      server: state.settings.server,
      city: state.settings.priceCity,
      qualities: QUALITIES,
      signal: controller.signal,
      onProgress: (done, total) => {
        const bar = $('#bar', sheet);
        if (bar) bar.style.width = `${Math.max(6, (done / total) * 70)}%`;
        const st = $('#status', sheet);
        if (st) st.textContent = `Market batch ${done} of ${total}…`;
      },
    });
    setQualityPrices(out.prices);

    let bmFound = 0;
    if (bmIds.length) {
      const st = $('#status', sheet);
      if (st) st.textContent = 'Asking the Black Market…';
      const bm = await fetchPrices(bmIds, {
        server: state.settings.server,
        city: BLACK_MARKET,
        field: 'buy',
        qualities: QUALITIES,
        signal: controller.signal,
        onProgress: (done, total) => {
          const bar = $('#bar', sheet);
          if (bar) bar.style.width = `${70 + (done / total) * 30}%`;
        },
      });
      setQualityPrices(bm.prices, true);
      bmFound = bm.found.length;
    }
    closeSheet();
    toast(`${out.found.length} prices updated${
      bmFound ? `, ${bmFound} from the Black Market` : ''}`);
  } catch (err) {
    if (controller.signal.aborted) return;
    closeSheet();
    openSheet(`
      <h2>Could not fetch prices</h2>
      <p class="muted">${esc(explain(err))}</p>
      <div class="sheet-actions">
        <button class="btn primary" id="ok">Enter them by hand</button>
      </div>
    `, { onMount: (r) => { $('#ok', r).onclick = closeSheet; } });
  }
}

/* --------------------------------------------------------- quality ----- */

/**
 * What comes off your bench, and what each level of it is worth.
 *
 * This is where the money is on equipment: a masterpiece sells for a multiple
 * of a plain one, and pricing a whole run as plain quietly throws that away.
 *
 * The honest part is saying what is known and what is not. gamedata.xml
 * publishes the table a craft rolls on and the points that focus and the
 * destiny board add to it. It does not publish how the points move the table.
 * So the mix below is a reading, it says so, and you can replace it with what
 * your own station actually tells you.
 */
export function openQuality() {
  const s = state.settings;
  const sample = craftTarget() && recipeOf(craftTarget())
    ? craftTarget() : 'T4_MAIN_SWORD';
  const { mix, source, points } = mixFor(sample, s);
  const modelled = qualityMix(qualityPoints(sample, s).total, s);
  const names = s.quality?.names || {};
  const own = s.qualityMix || {};

  const row = (q) => `
    <div class="row" style="gap:8px">
      <span class="ico">${['', '○', '◔', '◑', '◕', '●'][q]}</span>
      <span class="body">
        <span class="title">${esc(names[q] || `Quality ${q}`)}</span>
        <span class="meta">the model says ${pct(modelled[q], 1)}${
          q > 1 && s.quality?.itemPowerBonus?.[q]
            ? ` · +${s.quality.itemPowerBonus[q]} item power` : ''}</span>
      </span>
      <input type="number" class="spec-input" data-mix="${q}" inputmode="decimal"
        min="0" max="100" step="0.1" placeholder="${(modelled[q] * 100).toFixed(1)}"
        value="${own[q] ?? ''}" aria-label="Share of ${esc(names[q] || q)}">
    </div>`;

  openSheet(`
    <h2>Quality of what you make</h2>
    ${note(`Crafting rolls on a table, and your destiny board and your focus tip it towards the better end. On ${esc(nameOf(sample))} you are carrying <b>${Math.round(points)}</b> quality points right now. The game publishes the table and the points but not how the points move the table; the percentages below are this app's reading. If your station says otherwise, type it in.`)}

    ${QUALITY_LEVELS.map(row).join('')}

    <div class="hint">Leave them blank to use the model. Put anything in and
      the whole column becomes yours — they are treated as shares and scaled
      to add up to a hundred, so you can enter counts off your own crafting
      log if that is easier than percentages.</div>

    <div class="section-head" style="margin-top:16px"><h2>Right now that means</h2></div>
    <div class="card">
      <div class="bar-row"><span class="n">Using</span>
        <span class="v">${source === 'yours' ? 'your own numbers' : "the app's reading"}</span></div>
      <div class="bar-row"><span class="n">Plain</span>
        <span class="v num">${pct(mix[1], 1)}</span></div>
      <div class="bar-row"><span class="n">Better than plain</span>
        <span class="v num good">${pct(1 - mix[1], 1)}</span></div>
    </div>

    <div class="sheet-actions">
      <button class="btn ghost" id="reset">Use the model</button>
      <button class="btn primary" id="save">Save</button>
    </div>
  `, {
    onMount(root) {
      $('#save', root).onclick = () => {
        const out = {};
        let any = false;
        for (const box of $$('[data-mix]', root)) {
          const v = Number(box.value);
          if (Number.isFinite(v) && v > 0) { out[box.dataset.mix] = v; any = true; }
        }
        setSettings({ qualityMix: any ? out : null });
        closeSheet();
        toast(any ? 'Using your quality mix' : 'Using the model');
      };
      $('#reset', root).onclick = () => {
        setSettings({ qualityMix: null });
        closeSheet();
        toast('Using the model');
      };
    },
  });
}
