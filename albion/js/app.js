// Boot, routing, event wiring.

import { loadGameData, hydrate, state, subscribe } from './store.js';
import {
  acceptSpare, carryLeftoversIn, chainIds, openAddCraft, openAddPlot,
  openAdvanced, openAssumptions, openBoard, openCraft, openCraftCity,
  openCraftPick, openCycle, openData, openFarm, openFarmCity, openGoal,
  openMastery, openPlot, openPrice, openPriceSource, openQuality,
  openScanFilter, openStock, runCraftPriceFetch, runPriceFetch,
  runScanPriceFetch, runSolve, solveWithPrices,
} from './sheets.js';
import {
  craftTarget, ensureGear, setCraftQty, setCraftRerender, setCraftSellTo,
  setCraftTarget, toggleMake,
} from './craft.js';
import { $, $$, closeSheet, sheetIsOpen } from './ui.js';
import {
  missingPrices, rankMissingIds, rankTab, setPriceFilter, setRankTab, views,
} from './views.js';
import { openDetails } from './html.js';
import { addPlot, addCraft, setGoal, setSettings } from './store.js';

let current = 'plan';

function render() {
  const view = views[current]();
  $('#viewTitle').textContent = view.title;
  // One contextual action per screen, top right: Redo, Fetch, or nothing.
  const a = view.action;
  const btn = $('#topAct');
  btn.classList.toggle('hide', !a);
  btn.classList.toggle('warn', !!a?.warn);
  if (a) { btn.textContent = a.label; btn.dataset.act = a.act; }
  $('#view').innerHTML = view.html;
  // A Details block you opened stays open when the store re-renders the
  // screen under it. Toggle does not bubble, so each one is wired.
  for (const d of $$('details.more', $('#view'))) {
    d.addEventListener('toggle', () => {
      if (d.open) openDetails.add(d.dataset.key); else openDetails.delete(d.dataset.key);
    });
  }
  // A screen with real inputs on it, rather than only taps, wires them here.
  view.mount?.($('#view'));
}

function go(name) {
  if (!views[name]) return;
  // The weapon and armour file is two megabytes, so it is fetched the first
  // time something needs it and not before.
  if (name === 'craft' || name === 'rank') ensureGear();
  current = name;
  for (const b of document.querySelectorAll('#nav button')) {
    b.removeAttribute('aria-current');
    if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
  }
  render();
  window.scrollTo({ top: 0 });
}

const SEL = '[data-act],[data-plot],[data-craft],[data-price],[data-rank],'
  + '[data-price-filter],[data-toggle],[data-add-plot],[data-add-craft],'
  + '[data-add-step],[data-add-spare],[data-craft-sell],[data-make],[data-craft-rank]';

/** One tap, wherever it landed. Shared by the screen and the top-bar button. */
function act(el) {
  const d = el.dataset;

  if (d.craftSell) { setCraftSellTo(d.craftSell); return; }
  // A make/buy tag sits inside a price row: the tag wins, the row does not open.
  if (d.make) { toggleMake(d.make); return; }
  // A ranked row is a shortcut into the tab that can actually answer it.
  if (d.craftRank) { setCraftTarget(d.craftRank); go('craft'); return; }

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
    addCraft(d.addCraft);
    go('plan');
  } else if (d.addSpare) {
    acceptSpare(d.count, d.city);
  } else if (d.addStep) {
    // The missing intermediate is usually a cheap one, so keep focus for
    // whatever it feeds rather than burning it here.
    addCraft(d.addStep, { useFocus: false });
    go('plan');
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
  } else if (d.act === 'solve-first') {
    solveWithPrices();
  } else if (d.act === 'fetch-chain') {
    runPriceFetch(chainIds(state.goal.recipeId)).then((ok) => ok && runSolve());
  } else if (d.act === 'fetch-plan-prices') {
    runPriceFetch(missingPrices());
  } else if (d.act === 'rank-prices') {
    runPriceFetch(rankMissingIds());
  } else if (d.act === 'assumptions') {
    openAssumptions(rankTab);
  } else if (d.act === 'scan-filter') {
    openScanFilter();
  } else if (d.act === 'add-plot') {
    openAddPlot();
  } else if (d.act === 'add-craft') {
    openAddCraft();
  } else if (d.act === 'prices') {
    go('prices');
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
  } else if (d.act === 'stock') {
    openStock();
  } else if (d.act === 'carry-stock') {
    carryLeftoversIn();
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
     * should I grow to make this"; the Craft tab answers "what if I just buy
     * the lot and brew". Craft follows the plan's recipe on its own, so only
     * point it there when it is looking at something else — re-setting the
     * same recipe would throw away the make/buy choices for nothing. */
    if (craftTarget() !== state.goal.recipeId) setCraftTarget(state.goal.recipeId);
    go('craft');
  } else if (d.act === 'grow-instead') {
    const id = craftTarget();
    if (id && state.goal.recipeId !== id) setGoal({ recipeId: id });
    go('plan');
    if (!state.plan.plots.length && !state.plan.crafts.length) solveWithPrices();
  }
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

  const onTap = (e) => {
    const el = e.target.closest(SEL);
    if (el) act(el);
  };
  $('#view').addEventListener('click', onTap);
  $('#topAct').addEventListener('click', onTap);

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
  } catch (err) {
    $('#view').innerHTML = `
      <div class="empty"><span class="e">⚠️</span>
        Could not load the game data.<br><small>${err.message}</small></div>`;
    return;
  }
  subscribe(render);
  // The Craft tab finishes loading its data after the first paint, so it
  // needs a way to ask for a redraw once it has.
  setCraftRerender(() => { if (current === 'craft' || current === 'rank') render(); });
  wire();
  go('plan');
}

boot();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline is a bonus */ });
  });
}
