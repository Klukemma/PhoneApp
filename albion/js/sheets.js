// Bottom sheets: pickers, editors, settings.

import { craftBatch, perPeriod } from './calc.js';
import { explain, fetchPrices, CITIES, SERVERS } from './prices.js';
import {
  addCraft, addPlot, DATA, exportJSON, importJSON, priceOf, pricedItemIds,
  commit, removeCraft, removePlot, setPrice, setPrices, setSettings, state,
  updateCraft, updatePlot, wipe,
} from './store.js';
import { $, $$, closeSheet, esc, openSheet, toast } from './ui.js';
import { hours, short, silver } from './util.js';
import { cycleFor, ctx, detailHTML } from './views.js';

const nameOf = (id) => DATA.items[id]?.name || id;

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
  const cycle = cycleFor(row.itemId, row.mode);
  if (!cycle) return;
  const rate = perPeriod(cycle, { count: row.count, cadenceHours: state.settings.cadenceHours });
  const ref = cycle.ref;
  const heading = cycle.kind === 'product'
    ? `${nameOf(ref.product.itemId)} from ${ref.name}` : ref.name;

  openSheet(`
    <h2>T${ref.tier} ${esc(heading)}</h2>
    <div class="field">
      <label>How many plots or pens</label>
      <input type="number" id="count" inputmode="numeric" min="1" max="999" value="${row.count}">
      <div class="hint">An island farm plot holds 9. A pasture holds 9 animals.</div>
    </div>
    ${detailHTML(cycle, rate)}
    <div class="sheet-actions">
      <button class="btn primary" id="save">Save</button>
      <button class="btn ghost danger" id="del">Remove</button>
    </div>
  `, {
    onMount(root) {
      $('#save', root).onclick = () => {
        updatePlot(row.id, { count: Math.max(1, Number($('#count', root).value) || 1) });
        closeSheet();
      };
      $('#del', root).onclick = () => {
        const gone = removePlot(row.id);
        closeSheet();
        toast('Removed', { label: 'Undo', run: () => { addPlotBack(gone); } });
      };
    },
  });
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
  const batch = craftBatch(recipe, ctx());
  const rate = {
    perMonth: batch.profit * job.craftsPerDay * 30,
    focusPerDay: batch.focus * job.craftsPerDay,
  };

  openSheet(`
    <h2>T${recipe.tier} ${esc(recipe.name)}</h2>
    <div class="field">
      <label>Crafts per day</label>
      <input type="number" id="perDay" inputmode="numeric" min="0" max="9999"
        value="${job.craftsPerDay}">
      <div class="hint">${batch.focus
        ? `At ${Math.round(batch.focus)} focus each, ${Math.floor(state.settings.focusPerDay / batch.focus)} a day fits your focus budget.`
        : 'No focus used, so only materials limit you.'}</div>
    </div>
    ${detailHTML(batch, rate)}
    <div class="sheet-actions">
      <button class="btn primary" id="save">Save</button>
      <button class="btn ghost danger" id="del">Remove</button>
    </div>
  `, {
    onMount(root) {
      $('#save', root).onclick = () => {
        updateCraft(job.id, { craftsPerDay: Math.max(0, Number($('#perDay', root).value) || 0) });
        closeSheet();
      };
      $('#del', root).onclick = () => { removeCraft(job.id); closeSheet(); toast('Removed'); };
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
    <div class="field"><label>Server</label>
      <select id="server">${SERVERS.map((s) =>
        `<option value="${s}" ${s === state.settings.server ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
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
    ${toggle('citySpecialty', 'Crafting in a bonus city', `Adds +${s.craftSpecialtyBonus}% for that city's specialty.`)}
    ${toggle('ownInputsAtCost', 'Value inputs at my farm cost', 'Instead of what they would sell for.')}
    ${toggle('hideMounts', 'Hide mounts', 'Only show livestock and plants.')}

    <div class="two">
      <div class="field"><label>Specialisation level</label>
        <input type="number" id="specLevel" inputmode="numeric" min="0" max="120" value="${s.specLevel}">
        <div class="hint">Halves focus cost at 100.</div></div>
      <div class="field"><label>Harvest every (hours)</label>
        <input type="number" id="cadenceHours" inputmode="numeric" min="1" max="72" value="${s.cadenceHours}">
        <div class="hint">Crops ripen in 22h.</div></div>
    </div>
    <div class="field"><label>Station fee per craft (silver)</label>
      <input type="number" id="stationFeePerCraft" inputmode="numeric" min="0" value="${s.stationFeePerCraft}">
      <div class="hint">The usage fee the station owner charges. 0 on your own island.</div></div>

    <div class="section-head"><h2>Game numbers</h2></div>
    <p class="muted small">Straight from the game files, except where noted.
      Change them if a patch changes them.</p>
    <div class="two">
      <div class="field"><label>Focus craft bonus (%)</label>
        <input type="number" id="focusCraftBonus" inputmode="decimal" value="${s.focusCraftBonus}"></div>
      <div class="field"><label>City base bonus (%)</label>
        <input type="number" id="cityBaseBonus" inputmode="decimal" value="${s.cityBaseBonus}"></div>
      <div class="field"><label>Craft specialty (%)</label>
        <input type="number" id="craftSpecialtyBonus" inputmode="decimal" value="${s.craftSpecialtyBonus}"></div>
      <div class="field"><label>Premium yield ×</label>
        <input type="number" id="premiumYieldMultiplier" inputmode="decimal" step="0.1" value="${s.premiumYieldMultiplier}"></div>
      <div class="field"><label>Focus per day</label>
        <input type="number" id="focusPerDay" inputmode="numeric" value="${s.focusPerDay}"></div>
      <div class="field"><label>Market tax, premium (%)</label>
        <input type="number" id="marketTaxPremium" inputmode="decimal" step="0.1" value="${s.marketTaxPremium}"></div>
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
        'cityBaseBonus', 'craftSpecialtyBonus', 'premiumYieldMultiplier',
        'focusPerDay', 'marketTaxPremium'];

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
