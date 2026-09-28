// Boot, routing, event wiring.

import { loadGameData, hydrate, state, subscribe } from './store.js';
import {
  acceptSpare, carryLeftoversIn, chainIds, GATHER_BRANCH, openAddCraft,
  openAddPlot, openAdvanced, openAssumptions, openBoard, openCraft,
  openCraftCity, openCraftPick, openCycle, openData, openFarm, openFarmCity,
  openFishSetup, openFishExits, openFishTime, openGatherSetup, openGoal,
  openInstall, openIsland, openIslands, openMastery, openPlot, openPrice,
  openPriceSource, openReminders,
  openQuality, openResourceExits, openScanFilter, openStock, runCraftPriceFetch,
  runPriceFetch, runScanPriceFetch, runSolve, setNavigate, solveWithPrices,
} from './sheets.js';
import {
  craftTarget, cycleSource, ensureGear, setCraftQty, setCraftRerender,
  setCraftSellTo, setCraftTarget,
} from './craft.js';
import { $, $$, closeSheet, sheetIsOpen } from './ui.js';
import {
  missingPrices, rankMissingIds, rankTab, setPriceFilter, setRankTab, views,
} from './views.js';
import {
  setWildTier, setWildUnit, wildMissingIds,
} from './wild.js';
import { openDetails } from './html.js';
import { canRemind, syncReminders } from './notify.js';
import { roundsCtx } from './roundscard.js';
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
  /* The weapon and armour file is two megabytes, so it is fetched the first
   * time something needs it and not before. `wild` needs it as much as the
   * other two: every refine and transmute route lives in there, and exits.js
   * drops a route whose recipe it cannot find without a word, so a screen
   * missing from this list would quietly show "sell it as it is" and nothing
   * else. */
  if (name === 'craft' || name === 'rank' || name === 'wild') ensureGear();
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
  + '[data-add-step],[data-add-spare],[data-craft-sell],[data-source],'
  + '[data-craft-rank],[data-gather-row],[data-gather-tier],'
  + '[data-fish-row],[data-wild-tier],[data-wild-unit],[data-round]';

/** One tap, wherever it landed. Shared by the screen and the top-bar button. */
function act(el) {
  const d = el.dataset;

  if (d.craftSell) { setCraftSellTo(d.craftSell); return; }
  /* The buy/make/gather tag sits inside a price row: the tag wins, and the row
   * underneath does not open. */
  if (d.source) { cycleSource(d.source); return; }
  // A ranked row is a shortcut into the tab that can actually answer it.
  if (d.craftRank) { setCraftTarget(d.craftRank); go('craft'); return; }
  // A ranked resource opens every way out of it, rather than one of them.
  if (d.gatherRow) { openResourceExits(d.gatherRow); return; }
  if (d.gatherTier || d.wildTier) { setWildTier(d.gatherTier || d.wildTier); render(); return; }
  if (d.wildUnit) { setWildUnit(d.wildUnit); render(); return; }
  // A fish row opens every way out of that catch, the same as a land row does.
  if (d.fishRow) { openFishExits(d.fishRow); return; }
  // A rounds row opens the island it belongs to, at that plot.
  if (d.round) { openIsland(d.round.split(':')[0]); return; }

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
  } else if (d.act === 'me') {
    // A row that points at a setting whose home is the Me screen.
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
  } else if (d.act === 'stock') {
    openStock();
  } else if (d.act === 'carry-stock') {
    carryLeftoversIn();
  } else if (d.act === 'mastery') {
    openMastery();
  } else if (d.act === 'board') {
    openBoard();
  } else if (d.act === 'gather-setup') {
    openGatherSetup();
  } else if (d.act === 'gather-board') {
    openBoard(GATHER_BRANCH);
  } else if (d.act === 'journal-prices') {
    // The books this run fills, so a full one can be given a price.
    go('prices');
  } else if (d.act === 'wild-prices') {
    runPriceFetch(wildMissingIds());
  } else if (d.act === 'islands') {
    openIslands();
  } else if (d.act === 'reminders') {
    openReminders();
  } else if (d.act === 'install') {
    openInstall();
  } else if (d.act === 'fish-setup') {
    openFishSetup();
  } else if (d.act === 'fish-time') {
    openFishTime();
  } else if (d.act === 'plan') {
    go('plan');
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

/**
 * Keep the phone's alarms matching what the app believes.
 *
 * Debounced, because every tap commits and a commit tells every listener - and
 * rescheduling crosses the native bridge, which is not something to do four
 * times while somebody edits a name. A no-op in a browser.
 */
let resyncTimer = null;
function scheduleResync() {
  if (!canRemind() || !state.settings.remindMe) return;
  clearTimeout(resyncTimer);
  resyncTimer = setTimeout(() => {
    syncReminders(roundsCtx(), state.islands || []);
  }, 800);
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
  subscribe(scheduleResync);
  /* And once at boot, because the alarms are a projection of the state rather
   * than a second copy of it: anything that changed while the app was shut -
   * or an Android that dropped them - is corrected the first time you open it. */
  scheduleResync();
  // The Craft tab finishes loading its data after the first paint, so it
  // needs a way to ask for a redraw once it has.
  setCraftRerender(() => {
    if (current === 'craft' || current === 'rank' || current === 'wild') render();
  });
  // A sheet that ranks a route has to be able to open the tab that works on it.
  setNavigate(go);
  wire();
  go('plan');
}

boot();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline is a bonus */ });
  });
}
