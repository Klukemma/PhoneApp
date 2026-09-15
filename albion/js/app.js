// Boot, routing, event wiring.

import { loadGameData, hydrate, state, subscribe } from './store.js';
import {
  openAddCraft, openAddPlot, openCraft, openPlot, openPrice, openPriceSource,
  openSettings, runPriceFetch,
} from './sheets.js';
import { $, closeSheet, sheetIsOpen } from './ui.js';
import {
  setPriceFilter, setRankTab, views,
} from './views.js';
import { addPlot, addCraft, setSettings } from './store.js';

let current = 'plan';

function render() {
  const view = views[current]();
  $('#viewTitle').textContent = view.title;
  $('#viewSub').textContent = view.sub || '';
  $('#view').innerHTML = view.html;
}

function go(name) {
  if (!views[name]) return;
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

  $('#gearBtn').addEventListener('click', openSettings);
  $('#scrim').addEventListener('click', closeSheet);
  $('#sheet').addEventListener('click', (e) => {
    if (e.target.closest('[data-close-sheet]')) closeSheet();
  });

  $('#view').addEventListener('click', (e) => {
    const el = e.target.closest(
      '[data-act],[data-plot],[data-craft],[data-price],[data-rank],' +
      '[data-price-filter],[data-toggle],[data-add-plot],[data-add-craft]');
    if (!el) return;
    const d = el.dataset;

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
      go('plan');
    } else if (d.addCraft) {
      addCraft(d.addCraft, 10);
      go('plan');
    } else if (d.rank) {
      setRankTab(d.rank);
      render();
    } else if (d.priceFilter) {
      setPriceFilter(d.priceFilter);
      render();
    } else if (d.toggle) {
      setSettings({ [d.toggle]: !state.settings[d.toggle] });
    } else if (d.act === 'add-plot') {
      openAddPlot();
    } else if (d.act === 'add-craft') {
      openAddCraft();
    } else if (d.act === 'prices') {
      go('prices');
    } else if (d.act === 'fetch-prices') {
      runPriceFetch();
    } else if (d.act === 'price-source') {
      openPriceSource();
    }
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
  wire();
  go('plan');
}

boot();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline is a bonus */ });
  });
}
