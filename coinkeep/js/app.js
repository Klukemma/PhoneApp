// Boot, routing and event wiring.

import { balanceOn } from './budget.js';
import {
  catchUpSubscriptions, state, subscribe,
} from './store.js';
import {
  openExpense, openIncome, openOnboarding, openQuickEditor, openSettings,
  openSub, quickAdd,
} from './sheets.js';
import { $, closeSheet, sheetIsOpen, toast } from './ui.js';
import { addMonths, money, monthStart, todayKey } from './util.js';
import { anchor, setAnchor, setLogFilter, views } from './views.js';

let current = 'today';

function render() {
  const view = views[current]();
  $('#viewTitle').textContent = view.title;
  $('#viewSub').textContent = view.sub || '';
  $('#view').innerHTML = view.html;
  $('#balanceVal').textContent = money(balanceOn(state), state.settings.currency);
}

function go(name) {
  if (!views[name]) return;
  current = name;
  // Month browsing always starts from the current month.
  if (name === 'today') setAnchor(todayKey());
  for (const b of document.querySelectorAll('#nav button')) {
    b.toggleAttribute('aria-current', b.dataset.view === name);
    if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
  }
  render();
  window.scrollTo({ top: 0 });
}

/* ------------------------------------------------------- event wiring -- */

document.querySelector('#nav').addEventListener('click', (e) => {
  const name = e.target.closest('button')?.dataset.view;
  if (name) go(name);
});

$('#fab').addEventListener('click', () => openExpense());
$('#gearBtn').addEventListener('click', () => openSettings());
$('#balanceBtn').addEventListener('click', () => openSettings());
$('#scrim').addEventListener('click', closeSheet);
$('#sheet').addEventListener('click', (e) => {
  if (e.target.closest('[data-close-sheet]')) closeSheet();
});

// One delegated handler for everything the screens render.
$('#view').addEventListener('click', (e) => {
  const el = e.target.closest('[data-quick],[data-expense],[data-income],[data-sub],[data-act],[data-month],[data-filter]');
  if (!el) return;
  const d = el.dataset;

  if (d.quick) {
    const q = state.quickAdds.find((x) => x.id === d.quick);
    if (q) quickAdd(q);
  } else if (d.expense) {
    openExpense(state.expenses.find((x) => x.id === d.expense));
  } else if (d.income) {
    openIncome(state.incomes.find((x) => x.id === d.income));
  } else if (d.sub) {
    openSub(state.subs.find((x) => x.id === d.sub));
  } else if (d.month) {
    const next = addMonths(monthStart(anchor), Number(d.month));
    if (next <= monthStart(todayKey())) { setAnchor(next); render(); }
  } else if (d.filter) {
    setLogFilter(d.filter);
    render();
  } else if (d.act === 'add') {
    openExpense();
  } else if (d.act === 'income') {
    openIncome();
  } else if (d.act === 'add-sub') {
    openSub();
  } else if (d.act === 'edit-quick') {
    openQuickEditor();
  }
});

// Back / gesture-back closes an open sheet instead of leaving the app.
window.addEventListener('popstate', () => {
  if (sheetIsOpen()) { closeSheet(); history.pushState(null, ''); }
});
history.pushState(null, '');

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
});

/* ------------------------------------------------------------- boot ---- */

subscribe(render);

let lastDay = todayKey();

/** Post overdue bills and re-render when the app comes back or the day turns. */
function refresh() {
  const charged = catchUpSubscriptions();
  if (todayKey() !== lastDay) { lastDay = todayKey(); setAnchor(todayKey()); }
  render();
  if (charged) {
    toast(`${charged} subscription${charged > 1 ? 's' : ''} charged`);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

// A day boundary can pass while the app sits open in the background.
setInterval(() => { if (todayKey() !== lastDay) refresh(); }, 60_000);

catchUpSubscriptions();
go('today');

if (!state.settings.onboarded) setTimeout(openOnboarding, 350);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline is a bonus, not a requirement */ });
  });
}
