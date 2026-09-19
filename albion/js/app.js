// Boot, routing, event wiring.

import { loadGameData, hydrate, state, subscribe } from './store.js';
import {
  acceptSpare, openAddCraft, openAddPlot, openBoard, openCraft, openCraftCity,
  openAdvanced, openCraftPick, openCycle, openData, openFarm, openFarmCity,
  openGoal, openMastery, openPlot, openPrice, openPriceSource, openQuality,
  runCraftPriceFetch, runPriceFetch, runScanPriceFetch, runSolve,
} from './sheets.js';
import {
  ensureGear, setCraftQty, setCraftRerender, setCraftSellTo, setCraftTarget,
  setScan, toggleMake,
} from './craft.js';
import { $, closeSheet, sheetIsOpen } from './ui.js';
import {
  setEarnMode, setPriceFilter, setRankTab, views,
} from './views.js';
import { addPlot, addCraft, setSettings } from './store.js';

let current = 'earn';

function render() {
  const view = views[current]();
  $('#viewTitle').textContent = view.title;
  $('#viewSub').textContent = view.sub || '';
  $('#view').innerHTML = view.html;
  // A screen with real inputs on it, rather than only taps, wires them here.
  view.mount?.($('#view'));
}

/** Switch the Earn tab to one of its three questions and show it. */
function goEarn(mode) {
  setEarnMode(mode);
  go('earn');
}

function go(name) {
  if (!views[name]) return;
  // The weapon and armour file is two megabytes, so it is fetched the first
  // time you ask for it and not before.
  // The weapon and armour file is two megabytes, so it is fetched the first
  // time something needs it and not before.
  if (name === 'earn') ensureGear();
  current = name;
  for (const b of document.querySelectorAll('#nav button')) {
    b.removeAttribute('aria-current');
    if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
  }
  render();
  window.scrollTo({ top: 0 });
}

function wire() {
  document.querySelector('#nav').addEventListener('click', (e) => {
    const name = e.target.closest('button')?.dataset.view;
    if (name) go(name);
  });

  $('#scrim').addEventListener('click', closeSheet);
  $('#sheet').addEventListener('click', (e) => {
    if (e.target.closest('[data-close-sheet]')) closeSheet();
  });

  $('#view').addEventListener('click', (e) => {
    const el = e.target.closest(
      '[data-act],[data-plot],[data-craft],[data-price],[data-rank],' +
      '[data-price-filter],[data-toggle],[data-add-plot],[data-add-craft],' +
      '[data-add-step],[data-add-spare],[data-craft-sell],[data-make],' +
      '[data-craft-city],[data-scan-group],[data-scan-tier],[data-scan-enchant],' +
      '[data-craft-rank],[data-earn]');
    if (!el) return;
    const d = el.dataset;

    if (d.earn) { setEarnMode(d.earn); render(); return; }

    if (d.craftSell) { setCraftSellTo(d.craftSell); return; }
    if (d.make) { toggleMake(d.make); return; }
    if (d.craftCity) { setSettings({ craftCity: d.craftCity }); return; }
    if (d.scanGroup) { setScan({ group: d.scanGroup }); return; }
    if (d.scanTier) { setScan({ tier: Number(d.scanTier) }); return; }
    if (d.scanEnchant) { setScan({ enchant: Number(d.scanEnchant) }); return; }
    if (d.scanEnchant === '0') { setScan({ enchant: 0 }); return; }
    // A ranked row is a shortcut into the tab that can actually answer it.
    if (d.craftRank) { setCraftTarget(d.craftRank); goEarn('craft'); return; }

    if (d.plot) {
      const row = state.plan.plots.find((p) => p.id === d.plot);
      if (row) openPlot(row);
    } else if (d.craft) {
      const job = state.plan.crafts.find((c) => c.id === d.craft);
      if (job) openCraft(job);
    } else if (d.price) {
      openPrice(d.price);
    } else if (d.addPlot) {
      addPlot(d.addPlot, 9, d.mode || 'grow');
      goEarn('plan');
    } else if (d.addCraft) {
      addCraft(d.addCraft);
      goEarn('plan');
    } else if (d.addSpare) {
      acceptSpare();
    } else if (d.addStep) {
      // The missing intermediate is usually a cheap one, so keep focus for
      // whatever it feeds rather than burning it here.
      addCraft(d.addStep, { useFocus: false });
      goEarn('plan');
    } else if (d.rank) {
      setRankTab(d.rank);
      render();
    } else if (d.priceFilter) {
      setPriceFilter(d.priceFilter);
      render();
    } else if (d.toggle) {
      setSettings({ [d.toggle]: !state.settings[d.toggle] });
    } else if (d.act === 'land') {
      openFarm();
    } else if (d.act === 'goal') {
      openGoal();
    } else if (d.act === 'solve') {
      runSolve();
    } else if (d.act === 'add-plot') {
      openAddPlot();
    } else if (d.act === 'add-craft') {
      openAddCraft();
    } else if (d.act === 'prices') {
      go('prices');
    } else if (d.act === 'me') {
      go('me');
    } else if (d.act === 'quality') {
      openQuality();
    } else if (d.act === 'advanced') {
      openAdvanced();
    } else if (d.act === 'data') {
      openData();
    } else if (d.act === 'fetch-prices') {
      runPriceFetch();
    } else if (d.act === 'price-source') {
      openPriceSource();
    } else if (d.act === 'craft-city') {
      openCraftCity();
    } else if (d.act === 'farm-city') {
      openFarmCity();
    } else if (d.act === 'cycle') {
      openCycle();
    } else if (d.act === 'mastery') {
      openMastery();
    } else if (d.act === 'board') {
      openBoard();
    } else if (d.act === 'craft-pick') {
      openCraftPick();
    } else if (d.act === 'craft-prices') {
      runCraftPriceFetch();
    } else if (d.act === 'scan-prices') {
      runScanPriceFetch();
    } else if (d.act === 'buy-instead') {
      /* The other half of the same question. The farming plan answers "what
       * should I grow to make this"; the Craft tab answers "what if I just
       * buy the lot and brew", which is the same recipe costed with no farm
       * under it. Nothing to configure — it is a different screen, not a
       * different mode. */
      setCraftTarget(state.goal.recipeId);
      goEarn('craft');
    }
  });

  // Boxes are typed into rather than tapped, so they do not go through the
  // click handler above.
  $('#view').addEventListener('change', (e) => {
    const box = e.target.closest('[data-craft-qty],[data-num]');
    if (!box) return;
    if (box.dataset.craftQty !== undefined) { setCraftQty(box.value); return; }
    const v = Number(box.value);
    if (Number.isFinite(v)) setSettings({ [box.dataset.num]: v });
  });

  window.addEventListener('popstate', () => {
    if (sheetIsOpen()) { closeSheet(); history.pushState(null, ''); }
  });
  history.pushState(null, '');
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
}

/* ------------------------------------------------------------- boot ---- */

async function boot() {
  try {
    const data = await loadGameData();
    hydrate(data);
    $('#dataStamp').textContent = `data ${data.generated}`;
  } catch (err) {
    $('#view').innerHTML = `
      <div class="empty"><span class="e">⚠️</span>
        Could not load the game data.<br><small>${err.message}</small></div>`;
    return;
  }
  subscribe(render);
  // The Craft tab finishes loading its data after the first paint, so it
  // needs a way to ask for a redraw once it has.
  setCraftRerender(() => { if (current === 'craft') render(); });
  wire();
  go('earn');
}

boot();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline is a bonus */ });
  });
}
