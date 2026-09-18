// Bottom sheets: pickers, editors, settings.

import {
  cityBonus, cityFor, craftBatch, farmBonus, farmCityFor, focusCostAt,
  focusEfficiency, perPeriod, simulateCycle, specFor,
} from './calc.js';
import { explain, fetchPrices, serverName, CITIES, SERVERS } from './prices.js';
import {
  addCraft, addPlot, addSpare, applySolution, DATA, exportJSON, importJSON,
  priceOf, pricedItemIds, commit, removeCraft, removePlot, setGoal, setNodeLevel,
  setPrice, setPrices, setSettings, setSpec, state, updateCraft, updatePlot, wipe,
} from './store.js';
import { solve } from './solve.js';
import { $, $$, closeSheet, esc, openSheet, toast } from './ui.js';
import { hours, short, silver } from './util.js';
import { cycleFor, ctx, detailHTML, setSolution, solution } from './views.js';

const nameOf = (id) => DATA.items[id]?.name || id;

/* ------------------------------------------------------------- goal --- */

/** What you are making, and how much land you have to make it with. */
export function openGoal() {
  const goal = state.goal;
  const byCat = { potion: [], food: [] };
  for (const r of DATA.recipes) (byCat[r.category] || byCat.potion).push(r);

  const list = (rs) => rs
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name))
    .map((r) => `
      <button class="row" data-recipe="${esc(r.id)}"
        ${r.id === goal.recipeId ? 'style="border-color:var(--gold)"' : ''}>
        <span class="ico">${r.category === 'food' ? '\u{1F35E}' : '\u{1F9EA}'}</span>
        <span class="body"><span class="title">T${r.tier} ${esc(r.name)}</span>
          <span class="meta">${r.inputs.map((i) => `${i.count}× ${nameOf(i.id)}`).join(', ')}
            → ${r.amount}${priceOf(r.id) ? '' : ' · no price yet'}</span></span>
        <span class="amt">${r.id === goal.recipeId ? '✓' : '+'}</span>
      </button>`).join('');

  openSheet(`
    <h2>What are you making?</h2>
    <p class="muted">Pick the thing you want to end up with and say how much land
      you have. Everything else — what to plant, how often to go out, when to
      stop and bank focus, how much to brew — gets worked out from there.</p>

    <div class="field"><label>Plots you can farm on</label>
      <input type="number" id="plots" inputmode="numeric" min="0" max="999"
        value="${goal.plots}">
      <div class="hint">Whole 3×3 plots and pastures, not tiles. An island counts
        its plots; a guild island counts all of them.</div></div>

    <div class="section-head"><h2>Potions</h2></div>${list(byCat.potion)}
    <div class="section-head"><h2>Food</h2></div>${list(byCat.food)}
  `, {
    onMount(root) {
      const save = () => setGoal({ plots: Number($('#plots', root).value) });
      $('#plots', root).onchange = save;
      root.onclick = (e) => {
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
  if (!goal.plots) { toast('Say how many plots you have first'); openGoal(); return; }

  toast(`Working out ${recipe.name}…`);
  setTimeout(() => {
    let result;
    try {
      result = solve(goal.recipeId, goal.plots, DATA, ctx());
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
    setSolution(result);
    applySolution(result);
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
  const rate = perPeriod(cycle, { count: row.count, cadenceHours: state.settings.cadenceHours });
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
    .filter((c) => c.id !== 'island')      // an island carries its city's bonus
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
    ${(s.cities || []).filter((c) => c.id !== 'island').map((c) => {
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
  const byCat = { potion: [], food: [] };
  for (const r of DATA.recipes) (byCat[r.category] || byCat.potion).push(r);

  const list = (rs) => rs
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name))
    .map((r) => `
      <button class="row" data-recipe="${esc(r.id)}">
        <span class="ico">${r.category === 'food' ? '\u{1F35E}' : '\u{1F9EA}'}</span>
        <span class="body"><span class="title">T${r.tier} ${esc(r.name)}</span>
          <span class="meta">${r.inputs.map((i) => `${i.count}× ${nameOf(i.id)}`).join(', ')}
            → ${r.amount}</span></span>
        <span class="amt">+</span>
      </button>`).join('');

  openSheet(`
    <h2>What are you crafting?</h2>
    <div class="section-head"><h2>Potions</h2></div>${list(byCat.potion)}
    <div class="section-head"><h2>Food</h2></div>${list(byCat.food)}
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
    <h2>T${recipe.tier} ${esc(recipe.name)}</h2>

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
  const what = category === 'potion' ? 'Potions' : 'Cooked food';
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
      const pot = c.specialties?.includes('potion');
      const food = c.specialties?.includes('food');
      const tags = [pot && 'potions', food && 'cooked food'].filter(Boolean).join(', ');
      return `
        <button class="row" data-city="${esc(c.id)}"
          ${c.id === s.craftCity ? 'style="border-color:var(--gold)"' : ''}>
          <span class="ico">\u{1F3EF}</span>
          <span class="body"><span class="title">${esc(c.name)}</span>
            <span class="meta">+${c.base} base${tags ? `, +${s.craftSpecialtyBonus} for ${tags}` : ', no specialty here'}</span></span>
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

export function openPrice(id) {
  openSheet(`
    <h2>${esc(DATA.items[id]?.name || id)}</h2>
    <div class="field">
      <label>Price per unit (silver)</label>
      <input type="number" id="price" inputmode="numeric" min="0" step="1"
        value="${priceOf(id) || ''}" placeholder="0" autofocus>
      <div class="hint">${esc(id)}</div>
    </div>
    <div class="sheet-actions">
      <button class="btn primary" id="save">Save</button>
    </div>
  `, {
    onMount(root) {
      const input = $('#price', root);
      input.focus();
      input.select();
      const save = () => { setPrice(id, input.value); closeSheet(); };
      $('#save', root).onclick = save;
      input.onkeydown = (e) => { if (e.key === 'Enter') save(); };
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
    setPrices(out.prices);
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

export function openSettings() {
  const s = state.settings;
  const toggle = (key, title, desc) => `
    <div class="toggle">
      <div class="body"><div class="t">${esc(title)}</div>
        <div class="d">${esc(desc)}</div></div>
      <button class="switch" data-set="${key}" aria-pressed="${!!s[key]}"></button>
    </div>`;

  openSheet(`
    <h2>Setup</h2>

    <div class="section-head"><h2>You</h2></div>
    ${toggle('premium', 'Premium', 'Doubles farm yield and lowers market tax.')}
    ${toggle('watered', 'Water plots with focus', 'More seeds and babies back, at 1000 focus each.')}
    ${toggle('favouriteFood', 'Feed animals their favourite', 'Their favourite plant is worth double nutrition.')}
    ${toggle('useFocus', 'Craft with focus', `Adds +${s.focusCraftBonus}% to the return rate.`)}
    ${toggle('ownInputsAtCost', 'Value inputs at my farm cost', 'Instead of what they would sell for.')}
    ${toggle('sellSurplus', 'Sell leftover ingredients',
      'Off by default: ingredients your crafting uses are kept for the next batch, not sold.')}
    ${toggle('hideMounts', 'Hide mounts', 'Only show livestock and plants.')}

    <div class="section-head"><h2>Your cycle</h2></div>
    <button class="row" data-act="open-cycle" style="margin-bottom:12px">
      <span class="ico">\u{1F504}</span>
      <span class="body"><span class="title">${s.cycleDays}-day cycle</span>
        <span class="meta">${s.farmDays} farming, ${s.cycleDays - s.farmDays} idle, then craft</span></span>
      <span class="amt">\u203A</span>
    </button>

    <div class="section-head"><h2>Farming</h2></div>
    <button class="row" data-act="open-farm-city" style="margin-bottom:12px">
      <span class="ico">\u{1F33E}</span>
      <span class="body"><span class="title">Farm in ${esc(farmCityFor(s)?.name || 'a city')}</span>
        <span class="meta">+10% yield on that city's crops, herbs and produce</span></span>
      <span class="amt">\u203A</span>
    </button>

    <div class="section-head"><h2>Crafting</h2></div>
    <button class="row" data-act="open-city" style="margin-bottom:8px">
      <span class="ico">\u{1F3EF}</span>
      <span class="body"><span class="title">Craft in ${esc(cityFor(s)?.name || 'a city')}</span>
        <span class="meta">Only Brecilien boosts potions, only Caerleon boosts cooked food</span></span>
      <span class="amt">\u203A</span>
    </button>
    <button class="row" data-act="open-board" style="margin-bottom:12px">
      <span class="ico">\u{1F31F}</span>
      <span class="body"><span class="title">Destiny board</span>
        <span class="meta">${Object.keys(state.nodeLevels || {}).length || 'no'}
          ${Object.keys(state.nodeLevels || {}).length === 1 ? 'node' : 'nodes'} set
          \u00b7 drives every focus cost</span></span>
      <span class="amt">\u203A</span>
    </button>
    <button class="row" data-act="open-mastery" style="margin-bottom:12px">
      <span class="ico">\u{1F4DA}</span>
      <span class="body"><span class="title">Per-recipe overrides</span>
        <span class="meta">${Object.keys(state.spec || {}).length || 'none'} set
          \u00b7 only if you would rather type the number yourself</span></span>
      <span class="amt">\u203A</span>
    </button>

    <div class="two">
      <div class="field"><label>Default mastery</label>
        <input type="number" id="specLevel" inputmode="numeric" min="0" max="120" value="${s.specLevel}">
        <div class="hint">Halves focus cost at 100.</div></div>
      <div class="field"><label>Harvest every (hours)</label>
        <input type="number" id="cadenceHours" inputmode="numeric" min="1" max="72" value="${s.cadenceHours}">
        <div class="hint">Crops ripen in 22h; 24 means once a day.</div></div>
    </div>
    <div class="field"><label>Spare stock you will sit on</label>
      <input type="number" id="stockCap" inputmode="numeric" min="0" step="500"
        value="${s.stockCap}">
      <div class="hint">Past this many spare units of an ingredient you would
        stop farming it and let the pile drain. Used to warn you how many cycles
        that is away.</div></div>

    <div class="field"><label>Station fee per craft (silver)</label>
      <input type="number" id="stationFeePerCraft" inputmode="numeric" min="0" value="${s.stationFeePerCraft}">
      <div class="hint">The usage fee the station owner charges. 0 on your own island.</div></div>

    <div class="section-head"><h2>Game numbers</h2></div>
    <p class="muted small">Straight from the game files, except focus regeneration
      and the premium yield, which are not published. City bonuses are read from
      the game's own tables, so they are not listed here.</p>
    <div class="two">
      <div class="field"><label>Focus craft bonus (%)</label>
        <input type="number" id="focusCraftBonus" inputmode="decimal" value="${s.focusCraftBonus}"></div>
      <div class="field"><label>Premium yield ×</label>
        <input type="number" id="premiumYieldMultiplier" inputmode="decimal" step="0.1" value="${s.premiumYieldMultiplier}"></div>
      <div class="field"><label>Focus per day</label>
        <input type="number" id="focusPerDay" inputmode="numeric" value="${s.focusPerDay}"></div>
      <div class="field"><label>Market setup fee (%)</label>
        <input type="number" id="marketSetupFee" inputmode="decimal" step="0.1" value="${s.marketSetupFee}"></div>
      <div class="field"><label>Transaction tax (%)</label>
        <input type="number" id="marketTransactionTax" inputmode="decimal" step="0.1" value="${s.marketTransactionTax}">
        <div class="hint">Premium halves this.</div></div>
    </div>

    <div class="section-head"><h2>Your data</h2></div>
    <p class="muted small">Stored on this phone only.</p>
    <div class="btn-row">
      <button class="btn" id="export">Export backup</button>
      <button class="btn" id="import">Restore</button>
    </div>
    <button class="btn ghost danger" id="wipe" style="margin-top:10px">Erase everything</button>
    <input type="file" id="file" accept="application/json,.json" class="hide">

    <div class="sheet-actions">
      <button class="btn primary" id="save">Save</button>
    </div>
  `, {
    onMount(root) {
      const flags = {};
      for (const btn of $$('[data-set]', root)) {
        btn.onclick = () => {
          const key = btn.dataset.set;
          flags[key] = !(flags[key] ?? s[key]);
          btn.setAttribute('aria-pressed', String(flags[key]));
        };
      }
      const NUM = ['specLevel', 'cadenceHours', 'stationFeePerCraft', 'focusCraftBonus',
        'premiumYieldMultiplier', 'focusPerDay', 'marketSetupFee',
        'marketTransactionTax', 'stockCap'];

      $('#save', root).onclick = () => {
        const patch = { ...flags };
        for (const k of NUM) {
          const v = Number($(`#${k}`, root).value);
          if (Number.isFinite(v)) patch[k] = v;
        }
        setSettings(patch);
        closeSheet();
        toast('Saved');
      };
      $('[data-act="open-cycle"]', root).onclick = openCycle;
      $('[data-act="open-farm-city"]', root).onclick = openFarmCity;
      $('[data-act="open-city"]', root).onclick = openCraftCity;
      $('[data-act="open-board"]', root).onclick = () => openBoard();
      $('[data-act="open-mastery"]', root).onclick = () => openMastery();
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
 * Mastery is per item line in Albion, not one global number, so this lists
 * recipes individually. Anything left blank falls back to your default level.
 */
export function openMastery(filter = '') {
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
        <span class="ico">${r.category === 'food' ? '\u{1F35E}' : '\u{1F9EA}'}</span>
        <span class="body"><span class="title">T${r.tier} ${esc(r.name)}</span>
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
      $('#done', root).onclick = () => openSettings();
    },
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

const BRANCH_LABEL = {
  CROPS: 'Crops', HERBS: 'Herbs', ANIMALS: 'Animals',
  ALCHEMIST: 'Alchemist', COOK: 'Cook',
};

/**
 * Your destiny board levels, which is where every focus cost really comes from.
 *
 * Both halves matter and the mastery half is easy to forget: the branch node
 * covers everything under it, and each specialisation also quietly cheapens its
 * siblings. Levels are shown against the things you actually farm and brew.
 */
export function openBoard(branch = null) {
  const s = state.settings;
  const nodes = s.focusNodes || [];
  const branches = [...new Set(nodes.map((n) => n.branch))];
  const open = branch || branches[0];
  const mine = nodes.filter((n) => n.branch === open);

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

    <div class="seg" style="margin-bottom:12px">
      ${branches.map((b) => `
        <button type="button" data-branch="${esc(b)}" aria-pressed="${b === open}">
          ${esc(BRANCH_LABEL[b] || b)}</button>`).join('')}
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
      $('#done', root).onclick = () => openSettings();
    },
  });
}
