// Bottom sheets: pickers, editors, settings.

import {
  QUALITY_LEVELS, TILES_PER_PLOT, cityBonus, cityFor, craftBatch, farmBonus,
  farmCityFor, focusCostAt, focusEfficiency, mixFor, perPeriod, qualityMix,
  qualityPoints, simulateCycle, specFor,
} from './calc.js';
import {
  explain, fetchItem, fetchPrices, serverName, BLACK_MARKET, CITIES, SERVERS,
} from './prices.js';
import {
  addCraft, addPlot, addSpare, applySolution, DATA, exportJSON, importJSON,
  priceOf, pricedItemIds, clearLand, commit, landSummary, plotsOwned,
  removeCraft, removePlot, setBuyPrice, setGoal, setHolding, setNodeLevel,
  setPrice, setPrices, setSettings, setSpec, state, updateCraft, updatePlot, wipe,
  bmPriceOf, itemMeta, qBmPriceOf, qPriceOf, setBmPrice, setQualityPrice,
  setQualityPrices,
} from './store.js';
import { solve } from './solve.js';
import { $, $$, closeSheet, esc, openSheet, toast } from './ui.js';
import { ago, hours, pct, short, silver, tierText } from './util.js';
import {
  cycleFor, ctx, detailHTML, setSolution, solution, solveStamp,
} from './views.js';
import {
  GROUPS, allRecipes, craftTarget, currentRun, ensureGear, gearReady, groupIcon,
  groupOf as craftGroupOf, nameOf as craftNameOf, recipeOf, scanBlackIds,
  scanIds, setCraftTarget,
} from './craft.js';

/* Whichever file knows this item. Once the Craft tab has loaded the weapon
 * and armour list, a steel bar has a name here too; before that it does not,
 * and showing the raw id is better than pretending. */
const nameOf = (id) => itemMeta(id)?.name || id;

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

/** What you are making, and how much land you have to make it with. */
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

  const chips = (r) => {
    const variants = enchantsOf.get(r.id) || [];
    if (!variants.length) return '';
    return `
      <div class="seg" style="margin:6px 0 10px 44px">
        ${[r, ...variants].map((v) => `
          <button type="button" class="mini" data-recipe="${esc(v.id)}"
            aria-pressed="${v.id === goal.recipeId}">
            ${tierText(v.tier, v.enchant)}${priceOf(v.id) ? '' : ' ?'}</button>`).join('')}
      </div>`;
  };

  const list = (rs) => rs
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name))
    .map((r) => `
      <button class="row" data-recipe="${esc(r.id)}"
        ${r.id === goal.recipeId ? 'style="border-color:var(--gold)"' : ''}>
        <span class="ico">${GROUP_ICON[groupOf(r)]}</span>
        <span class="body"><span class="title">${tierText(r.tier, r.enchant)} ${esc(r.name)}</span>
          <span class="meta">${r.inputs.map((i) => `${i.count}\u00d7 ${nameOf(i.id)}`).join(', ')}
            \u2192 ${r.amount}${priceOf(r.id) ? '' : ' \u00b7 no price yet'}</span></span>
        <span class="amt">${r.id === goal.recipeId ? '\u2713' : '+'}</span>
      </button>
      ${chips(r)}`).join('');

  openSheet(`
    <h2>What are you making?</h2>
    <p class="muted">Pick the thing you want to end up with and say how much land
      you have. Everything else — what to plant, how often to go out, how much
      to brew and when — gets worked out from there. The .1, .2 and .3 under a
      potion are its enchanted versions: same ingredients plus alchemy extract,
      much more focus, much more money.</p>

    ${state.farm.length ? `
    <div class="field">
      <label>Your land</label>
      <button class="row" data-act="land" style="width:100%">
        <span class="body"><span class="title">${landSummary().farm} Farms ·
          ${landSummary().pasture} Pastures</span>
          <span class="meta">Across ${landSummary().cities.size} ${
            landSummary().cities.size === 1 ? 'city' : 'cities'} · tap to change</span></span>
        <span class="amt">\u203A</span>
      </button>
      <input type="hidden" id="plots" value="${plotsOwned()}">
    </div>` : `
    <div class="field"><label>Plots you can farm on</label>
      <input type="number" id="plots" inputmode="numeric" min="0" max="999"
        value="${goal.plots}">
      <div class="hint">Whole 3×3 plots and pastures, not tiles. An island counts
        its plots; a guild island counts all of them.
        <button class="linkish" data-act="land">Say which are Farms and which
        are Pastures</button>, and the plan will stop assuming you own both.</div></div>`}

    <div class="field">
      <label>How long one cycle runs</label>
      <div class="seg" id="cycleSeg" style="margin-bottom:8px">
        ${[0, 3, 7, 14].map((n) => `
          <button type="button" data-cycle="${n}" aria-pressed="${goal.cycleDays === n}">
            ${n === 0 ? 'You decide' : `${n} days`}</button>`).join('')}
      </div>
      <input type="number" id="cycleDays" inputmode="numeric" min="0" max="60"
        value="${goal.cycleDays || ''}" placeholder="0 \u2014 let it choose">
      <div class="hint">Farm, then bank focus, then craft the lot. Pin this to the
        rhythm you actually play to and everything else gets solved inside it:
        which days you go out, how often, and where the land goes. Focus stops at
        ${Math.round(state.settings.focusCap).toLocaleString()} and comes back at
        ${Math.round(state.settings.focusPerDay).toLocaleString()} a day, so a long
        cycle throws away the regeneration it cannot hold \u2014 the app will say so
        rather than hide it.</div>
    </div>

    <div class="section-head"><h2>Potions</h2></div>${list(byCat.potion)}
    <div class="section-head"><h2>Food</h2></div>${list(byCat.food)}
    ${byCat.meat.length ? `<div class="section-head"><h2>Butchering</h2></div>
      <p class="muted" style="margin:0 0 8px">One grown animal, 38 focus, 18 cuts
        of meat. The animal does not come back.</p>${list(byCat.meat)}` : ''}
  `, {
    onMount(root) {
      const save = () => setGoal({
        plots: Number($('#plots', root).value) || plotsOwned(),
        cycleDays: Number($('#cycleDays', root).value),
      });
      $('#plots', root).onchange = save;
      $('#cycleDays', root).onchange = () => { save(); openGoal(); };
      for (const b of $$('[data-cycle]', root)) {
        b.onclick = () => {
          setGoal({ plots: Number($('#plots', root).value) });
          setGoal({ cycleDays: Number(b.dataset.cycle) });
          openGoal();
        };
      }
      root.onclick = (e) => {
        if (e.target.closest('[data-act="land"]')) { save(); openFarm(); return; }
        const btn = e.target.closest('[data-recipe]');
        if (!btn) return;
        save();
        setGoal({ recipeId: btn.dataset.recipe });
        closeSheet();
        runSolve();
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
      result = solve(goal.recipeId, plotsOwned(), DATA, ctx(), {
        ...(goal.cycleDays ? { cycleDays: goal.cycleDays } : {}),
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
        toast(`No market price for ${recipe.name}`,
          { label: 'Fetch live', run: () => runPriceFetch().then(runSolve) });
      } else {
        toast('No plan makes that at these prices');
      }
      return;
    }
    // Remember what this answer was worked out against, so the screen can say
    // when the board, the prices or the question have moved on since.
    const stamp = solveStamp();
    setSolution({ ...result, stamp });
    applySolution(result, stamp);
    const stale = result.steps.filter((x) => !priceOf(x.itemId)).length;
    if (stale) {
      toast(`${stale} ingredient${stale === 1 ? ' has' : 's have'} no price`,
        { label: 'Fetch live', run: () => runPriceFetch().then(runSolve) });
    } else {
      toast(`${short(result.perDay)} a day · ${Math.round(result.made)} ${recipe.name}`);
    }
  }, 30);
}

/** Take the solver up on its suggestion for the land the chain did not need. */
export function acceptSpare() {
  const spare = solution?.spare;
  if (!spare) return;
  addSpare(spare);
  toast(`${spare.plots} ${spare.plots === 1 ? 'plot' : 'plots'} added`);
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
export function openFarm() {
  // Every island is bound to a city and farms with that city's bonus, so
  // there is nowhere to put land that is not a city. The island entry exists
  // for crafting, where the bonus really is zero, and has no place here.
  const cities = (state.settings.cities || []).filter((c) => !c.craftOnly);
  const mine = new Map();
  for (const h of state.farm) mine.set(`${h.cityId}:${h.kind}`, h.count);
  const owned = [...new Set(state.farm.map((h) => h.cityId))];
  const listed = [...new Set([...owned, ...cities.map((c) => c.id)])];
  const sum = landSummary();

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
    <div class="card" style="padding:10px 12px;margin-bottom:10px">
      <div style="margin-bottom:8px">
        <div style="font-size:14px;font-weight:600">${esc(nameOfCity(id))}</div>
        <div class="muted small">${esc(bonusHere(id))}</div>
      </div>
      <div class="two">${box(id, 'farm', 'Farms')}${box(id, 'herbgarden', 'Herb Gardens')}</div>
      <div class="two" style="margin-top:8px">${box(id, 'pasture', 'Pastures')}${
        box(id, 'kennel', 'Kennels')}</div>
      ${loose ? `<div class="warn-note" style="margin-top:8px">
        ${loose} ${loose === 1 ? 'plot' : 'plots'} here were saved before the app
        told the buildings apart. Put the real numbers in above and
        <button class="linkish" data-drop="${esc(id)}">clear the old ones</button>.
        </div>` : ''}
    </div>`;
  };

  openSheet(`
    <h2>Your land</h2>
    <p class="muted">Count whole 3\u00d73 plots, not tiles. The game keeps these four
      apart and so does the plan: crops only grow in a Farm, herbs only in a
      Herb Garden, livestock only in a Pasture and the exotic mounts only in a
      Kennel. Five plots of carrots and seven of agaric are not twelve
      interchangeable plots.</p>
    <p class="muted small">Every island is bound to a city and farms with that
      city's full bonus, so put your island's plots under the city it sits in.
      There is no such thing as a farm with no city behind it \u2014 crafting is the
      one that loses the bonus on your own island.</p>

    ${state.farm.length ? `
      <div class="card" style="margin-bottom:12px">
        ${[['farm', 'Farms', 'crops'], ['herbgarden', 'Herb Gardens', 'herbs'],
          ['pasture', 'Pastures', 'livestock'], ['kennel', 'Kennels', 'mounts']]
          .filter(([k]) => sum[k] > 0)
          .map(([k, label, what]) => `
            <div class="bar-row"><span class="n">${label} <small>${what}</small></span>
              <span class="v num">${sum[k]}</span></div>`).join('')}
        ${sum.vague ? `<div class="bar-row"><span class="n">Not yet sorted</span>
          <span class="v num bad">${sum.vague}</span></div>` : ''}
        <div class="bar-row total"><span class="n">Across</span>
          <span class="v num">${sum.cities.size} ${
            sum.cities.size === 1 ? 'city' : 'cities'}</span></div>
      </div>`
    : `<div class="warn-note" style="margin-bottom:12px">Nothing described yet, so
        the plan is working from ${state.goal.plots} plots that can grow anything,
        anywhere. Fill this in and it will stop telling you to grow herbs
        somewhere herbs cannot go.</div>`}

    ${listed.map(cityBlock).join('')}

    ${state.farm.length ? `
      <button class="btn danger" id="clear">Forget all this</button>` : ''}

    <div class="sheet-actions">
      <button class="btn primary" id="save">Save</button>
    </div>
  `, {
    onMount(root) {
      for (const input of $$('[data-land]', root)) {
        input.onchange = () => {
          setHolding(input.dataset.land, input.dataset.kind, input.value);
          openFarm();
        };
      }
      for (const btn of $$('[data-drop]', root)) {
        btn.onclick = () => {
          for (const kind of ['plant', 'animal']) setHolding(btn.dataset.drop, kind, 0);
          openFarm();
        };
      }
      $('#clear', root)?.addEventListener('click', () => { clearLand(); openFarm(); });
      $('#save', root).onclick = () => {
        closeSheet();
        // Describing your land is a change to the question, so answer it again.
        if (state.goal.recipeId) runSolve();
      };
    },
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
        <span class="amt">+</span>
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
        <button class="row" data-farm-city="${esc(c.id)}"
          ${c.id === s.farmCity ? 'style="border-color:var(--gold)"' : ''}>
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
    .map((r) => `
      <button class="row" data-recipe="${esc(r.id)}">
        <span class="ico">${GROUP_ICON[groupOf(r)]}</span>
        <span class="body"><span class="title">${tierText(r.tier, r.enchant)} ${esc(r.name)}</span>
          <span class="meta">${r.inputs.map((i) => `${i.count}× ${nameOf(i.id)}`).join(', ')}
            → ${r.amount}</span></span>
        <span class="amt">+</span>
      </button>`).join('');

  openSheet(`
    <h2>What are you crafting?</h2>
    <div class="section-head"><h2>Potions</h2></div>${list(byCat.potion)}
    <div class="section-head"><h2>Food</h2></div>${list(byCat.food)}
    ${byCat.meat.length ? `<div class="section-head"><h2>Butchering</h2></div>
      <p class="muted" style="margin:0 0 8px">One grown animal, 38 focus, 18 cuts
        of meat. The animal does not come back.</p>${list(byCat.meat)}` : ''}
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
export function openCraftCity() {
  const s = state.settings;
  openSheet(`
    <h2>Where do you craft?</h2>
    <p class="muted">This sets the default. Each job on your plan can override it.</p>
    ${(s.cities || []).map((c) => {
      const spec = c.craftSpecialties || {};
      const tags = [
        spec.potion && `+${spec.potion} for potions`,
        spec.food && `+${spec.food} for cooked food`,
      ].filter(Boolean).join(', ');
      // The island is the one place with no city behind it, which is the
      // whole point of listing it: your own station gets nothing back.
      const meta = c.craftOnly
        ? 'No city bonus at all \u2014 your own station, away from any city'
        : `+${c.craftBase} base${tags ? `, ${tags}` : ', no specialty here'}`;
      return `
        <button class="row" data-city="${esc(c.id)}"
          ${c.id === s.craftCity ? 'style="border-color:var(--gold)"' : ''}>
          <span class="ico">${c.craftOnly ? '\u{1F3E1}' : '\u{1F3EF}'}</span>
          <span class="body"><span class="title">${esc(c.name)}</span>
            <span class="meta">${esc(meta)}</span></span>
          <span class="amt">${c.id === s.craftCity ? '\u2713' : ''}</span>
        </button>`;
    }).join('')}
    <p class="muted small" style="margin-top:12px">
      Only Brecilien boosts potions and only Caerleon boosts cooked food. The
      royal cities specialise in weapons and armour, so for these they give the
      base and nothing more. Your station shows its real bonus on the city map
      \u2014 if it differs, change the numbers under Setup.</p>
  `, {
    onMount(root) {
      root.onclick = (e) => {
        const id = e.target.closest('[data-city]')?.dataset.city;
        if (!id) return;
        setSettings({ craftCity: id });
        closeSheet();
        toast(`Crafting in ${cityFor(state.settings, id)?.name}`);
      };
    },
  });
}

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
  const black = bmPriceOf(id);

  const quotes = (rows, key, best, target) => rows.map((r, n) => {
    const v = r[key];
    const when = key === 'sellMin' ? r.sellAt : r.buyAt;
    const rank = n === 0 ? best : n === rows.length - 1 && rows.length > 2 ? 'worst' : '';
    // A day-old quote sitting next to an hour-old one is not the same
    // information, and ranking them together quietly pretends it is.
    const stale = Number.isFinite(when) && Date.now() - when > 24 * 3600e3;
    return `
      <button class="row price ${stale ? 'warn' : ''}"
        data-city="${esc(r.city)}" data-target="${target}"
        data-value="${v}" ${n === 0 ? 'style="border-color:var(--gold)"' : ''}>
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
    <p class="muted">${esc(id)}</p>

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
              <input type="number" inputmode="numeric" min="0" step="1"
                data-qb="${q}" placeholder="black market" style="margin-top:4px"
                value="${qBmPriceOf(id, q) || ''}"></div>`).join('')}
        </div>
        <div class="hint">The market prices these separately and so does the
          Black Market, and the gap is the whole reason quality is worth
          having. Top box is the open market, bottom is the Black Market.
          Anything left blank is counted at the plain price, which understates
          what a run is worth rather than overstating it.</div>
      </div>` : ''}
    <div class="hint" style="margin:-4px 0 12px">Leave "you pay" blank and it
      costs the same as it sells for. Set it when you buy this in cheaper than
      you would list it \u2014 materials off another city's market, say.</div>

    <button class="btn ${market ? '' : 'primary'}" id="look" ${busy ? 'disabled' : ''}>
      ${busy ? 'Asking every city' + '…' : market ? 'Check again' : 'Where is it cheapest?'}</button>
    <div class="hint centered">Live from the Albion Online Data Project ·
      ${esc(server)} · <button class="linkish" data-act="price-source">change server</button></div>

    ${err ? `<div class="warn-note" style="margin-top:12px">${esc(err)}</div>` : ''}

    ${market && !market.length ? `<div class="warn-note" style="margin-top:12px">
      No city has a quote for this. Nobody running the data project's client has
      stood in a market with it open lately \u2014 type a price in instead.</div>` : ''}

    ${buyable.length ? `
      <div class="section-head" style="margin-top:18px"><h2>\u{1F53D} Cheapest to buy</h2>
        <span class="right num" style="color:var(--dim)">tap to use</span></div>
      ${quotes(buyable, 'sellMin', 'cheapest', 'buy')}` : ''}

    ${sellable.length ? `
      <div class="section-head" style="margin-top:18px"><h2>\u{1F53C} Best place to sell</h2>
        <span class="right num" style="color:var(--dim)">tap to use</span></div>
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

export async function runPriceFetch() {
  const ids = pricedItemIds();
  const sheet = openSheet(`
    <h2>Fetching prices</h2>
    <p class="muted">${ids.length} items from ${esc(state.settings.server)} ·
      ${esc(state.settings.priceCity)}</p>
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
    <p class="muted">Your prices, your plan and your settings are stored on this
      phone only. Nothing is sent anywhere except the price lookups, which ask
      the Albion Online Data Project about item ids and tell it nothing about
      you.</p>
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
 * The shape of one batch cycle. Farming and crafting are separate phases
 * because focus banks up to a cap while you farm and is then spent in one go.
 */
export function openCycle() {
  const s = state.settings;
  const sim = simulateCycle(state.plan, DATA, ctx());
  const l = sim.ledger;

  openSheet(`
    <h2>Your cycle</h2>
    <p class="muted">Farm for a stretch, let focus bank up, then spend it all
      crafting. Everything on the Plan screen is worked out over one of these.</p>

    <div class="two">
      <div class="field"><label>Cycle length (days)</label>
        <input type="number" id="cycleDays" inputmode="numeric" min="1" max="60"
          value="${s.cycleDays}"></div>
      <div class="field"><label>Of which farming</label>
        <input type="number" id="farmDays" inputmode="numeric" min="0" max="60"
          value="${s.farmDays}"></div>
    </div>
    <div class="field">
      <label>Farm how often</label>
      <div class="seg" id="everySeg">
        ${[1, 2, 3].map((n) => `
          <button type="button" data-every="${n}" aria-pressed="${(s.farmEvery || 1) === n}">
            ${n === 1 ? 'Every day' : n === 2 ? 'Every other day' : `Every ${n} days`}</button>`).join('')}
      </div>
      <div class="hint">Watering costs focus, so skipping a day banks another
        ${Math.round(s.focusPerDay).toLocaleString()} for the next one \u2014 at the
        cost of that day's harvest. ${sim.farmingDays} ${sim.farmingDays === 1 ? 'harvest' : 'harvests'}
        over ${sim.farmDays} days.</div>
    </div>

    <div class="field"><label>Focus in hand at the start</label>
      <input type="number" id="startFocus" inputmode="numeric" min="0" max="${s.focusCap}"
        value="${s.startFocus || 0}">
      <div class="hint">Zero if you emptied it on the last batch.</div></div>

    <div class="card" style="margin-bottom:12px">
      <div class="bar-row"><span class="n">Focus banked by craft day</span>
        <span class="v num">${Math.round(sim.focusAtCraft).toLocaleString()}</span></div>
      <div class="bar-row"><span class="n">Regeneration wasted at the cap</span>
        <span class="v num ${l.wasted ? 'bad' : ''}">${Math.round(l.wasted).toLocaleString()}</span></div>
      ${l.cappedOn ? `<div class="bar-row"><span class="n">Hits the cap on</span>
        <span class="v num">day ${l.cappedOn}</span></div>` : ''}
      <div class="bar-row"><span class="n">Watering costs</span>
        <span class="v num">${Math.round(sim.wateringPerDay).toLocaleString()} per farming day</span></div>
      ${sim.ledger.shortfall > 0 ? `<div class="bar-row">
        <span class="n">Watering you cannot pay for</span>
        <span class="v num bad">${Math.round(sim.ledger.shortfall).toLocaleString()}</span></div>` : ''}
    </div>

    ${l.wasted > 0 ? `<div class="warn-note" style="margin-bottom:12px">
      Focus caps on day ${l.cappedOn}. Every day after that throws away
      ${Math.round(s.focusPerDay).toLocaleString()} focus. Shortening the cycle to
      ${l.cappedOn} days would waste none.</div>` : ''}

    <div class="sheet-actions">
      <button class="btn primary" id="save">Save</button>
    </div>
  `, {
    onMount(root) {
      const refresh = () => {
        setSettings({
          cycleDays: Math.max(1, Number($('#cycleDays', root).value) || 14),
          farmDays: Math.max(0, Number($('#farmDays', root).value) || 0),
          startFocus: Math.max(0, Number($('#startFocus', root).value) || 0),
        });
        openCycle();
      };
      for (const id of ['#cycleDays', '#farmDays', '#startFocus']) {
        $(id, root).onchange = () => refresh();
      }
      for (const b of $$('[data-every]', root)) {
        b.onclick = () => { setSettings({ farmEvery: Number(b.dataset.every) }); openCycle(); };
      }
      $('#save', root).onclick = () => {
        setSettings({
          cycleDays: Math.max(1, Number($('#cycleDays', root).value) || 14),
          farmDays: Math.max(0, Number($('#farmDays', root).value) || 0),
          startFocus: Math.max(0, Number($('#startFocus', root).value) || 0),
        });
        closeSheet();
        toast('Cycle saved');
      };
    },
  });
}

/* ------------------------------------------------------ destiny board -- */

/**
 * Your destiny board levels, which is where every focus cost really comes from.
 *
 * Both halves matter and the mastery half is easy to forget: the branch node
 * covers everything under it, and each specialisation also quietly cheapens its
 * siblings. Levels are shown against the things you actually farm and brew.
 */
export function openBoard(branch = null) {
  rememberMastery();
  const s = state.settings;
  const nodes = s.focusNodes || [];
  /* Group by the name the game gives the top of each tree. With weapons and
   * armour loaded that is forty-odd branches rather than five, so they are
   * sorted and the whole strip wraps. */
  const labelOf = (n) => n.branchLabel || n.branch;
  const branches = [...new Set(nodes.map(labelOf))].sort();
  const open = branches.includes(branch) ? branch : branches[0];
  const mine = nodes.filter((n) => labelOf(n) === open);

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

  openSheet(`
    <h2>Destiny board</h2>
    <p class="muted">Focus cost comes from these. The branch node counts for
      everything under it, and every specialisation also cheapens its siblings
      a little \u2014 so levelling Potato Schnapps makes healing potions cheaper too.</p>

    <div class="seg" style="margin-bottom:12px;flex-wrap:wrap">
      ${branches.map((b) => `
        <button type="button" data-branch="${esc(b)}" aria-pressed="${b === open}">
          ${esc(b)}</button>`).join('')}
    </div>

    ${mine.filter((n) => n.kind === 'mastery').map(nodeRow).join('')}
    ${mine.some((n) => n.kind === 'spec')
      ? `<div class="section-head" style="margin-top:14px"><h2>Specialisations</h2></div>` : ''}
    ${mine.filter((n) => n.kind === 'spec').map(nodeRow).join('')}

    ${examples.length ? `
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

    <div class="sheet-actions">
      <button class="btn primary" id="done">Done</button>
    </div>
  `, {
    onMount(root) {
      for (const b of $$('[data-branch]', root)) {
        b.onclick = () => openBoard(b.dataset.branch);
      }
      for (const input of $$('[data-node]', root)) {
        input.onchange = () => { setNodeLevel(input.dataset.node, input.value); openBoard(open); };
      }
      $('#done', root).onclick = () => { leaveMastery(); closeSheet(); };
    },
    onDismiss: leaveMastery,
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
      ${shown.map((r) => `
        <button class="row" data-pick="${esc(r.id)}"
          ${r.id === craftTarget() ? 'style="border-color:var(--gold)"' : ''}>
          <span class="ico">${groupIcon(craftGroupOf(r))}</span>
          <span class="body">
            <span class="title">${tierText(r.tier, r.enchant)} ${esc(r.name)}</span>
            <span class="meta">${r.inputs.map((i) => `${i.count}× ${esc(craftNameOf(i.id))}`).join(', ')}${
              priceOf(r.id) || bmPriceOf(r.id) ? '' : ' · no price yet'}</span>
          </span>
          <span class="amt">${r.id === craftTarget() ? '✓' : '+'}</span>
        </button>`).join('')}
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
    <p class="muted">Crafting rolls on a table, and your destiny board and your
      focus tip it towards the better end. On ${esc(nameOf(sample))} you are
      carrying <b>${Math.round(points)}</b> quality points right now.</p>

    <div class="warn-note" style="margin-bottom:12px">The game publishes the
      table — 689 plain, 250 good, 50 outstanding, 10 excellent, 1
      masterpiece out of a thousand — and it publishes the points. It does not
      publish how the points move the table. The percentages below are this
      app's reading of that, not the game's own number, so if your crafting
      station tells you something different, type it in and it will be used
      instead.</p>

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
