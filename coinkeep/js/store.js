// Local-only persistence. Nothing ever leaves the phone.

import { chargeDueSubscriptions } from './budget.js';
import { todayKey, uid } from './util.js';

const KEY = 'coinkeep.v1';
const SCHEMA = 1;

export const DEFAULT_CATEGORIES = [
  { id: 'groceries', name: 'Groceries', emoji: '🛒', color: '#4ade80' },
  { id: 'eatingout', name: 'Eating out', emoji: '🍜', color: '#fb923c' },
  { id: 'transport', name: 'Transport', emoji: '🚌', color: '#60a5fa' },
  { id: 'bills', name: 'Bills', emoji: '🧾', color: '#a78bfa' },
  { id: 'shopping', name: 'Shopping', emoji: '🛍️', color: '#f472b6' },
  { id: 'fun', name: 'Fun', emoji: '🎮', color: '#facc15' },
  { id: 'health', name: 'Health', emoji: '💊', color: '#2dd4bf' },
  { id: 'other', name: 'Other', emoji: '📦', color: '#94a3b8' },
];

const DEFAULT_QUICK = [
  { id: uid(), label: 'Coffee', emoji: '☕', amount: 2.5, categoryId: 'eatingout', bs: false },
  { id: uid(), label: 'Lunch', emoji: '🥪', amount: 8, categoryId: 'eatingout', bs: false },
  { id: uid(), label: 'Transport', emoji: '🚌', amount: 1.5, categoryId: 'transport', bs: false },
  { id: uid(), label: 'Groceries', emoji: '🛒', amount: 25, categoryId: 'groceries', bs: false },
  { id: uid(), label: 'Delivery', emoji: '🛵', amount: 12, categoryId: 'eatingout', bs: true },
  { id: uid(), label: 'Impulse', emoji: '🙈', amount: 10, categoryId: 'shopping', bs: true },
];

function defaults() {
  return {
    schema: SCHEMA,
    settings: {
      currency: 'EUR',
      monthlyGoal: 0,
      payAmount: 0,
      payCycleDays: 15,
      lastPayDate: todayKey(),
      startBalance: 0,
      startBalanceDate: todayKey(),
      cashGuard: true,
      onboarded: false,
    },
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    quickAdds: DEFAULT_QUICK.map((q) => ({ ...q })),
    expenses: [],
    incomes: [],
    subs: [],
  };
}

/** Fill in anything a older save (or a hand-edited import) is missing. */
function normalize(raw) {
  const base = defaults();
  const s = {
    ...base,
    ...raw,
    schema: SCHEMA,
    settings: { ...base.settings, ...(raw.settings || {}) },
  };
  for (const k of ['categories', 'quickAdds', 'expenses', 'incomes', 'subs']) {
    if (!Array.isArray(s[k])) s[k] = base[k];
  }
  s.expenses = s.expenses.map((e) => ({
    id: e.id || uid(),
    date: e.date || todayKey(),
    amount: Number(e.amount) || 0,
    categoryId: e.categoryId || 'other',
    note: e.note || '',
    kind: e.kind === 'fixed' ? 'fixed' : 'variable',
    subId: e.subId || null,
    bs: !!e.bs,
  }));
  s.incomes = s.incomes.map((i) => ({
    id: i.id || uid(),
    date: i.date || todayKey(),
    amount: Number(i.amount) || 0,
    note: i.note || '',
    paycheck: i.paycheck !== false,
  }));
  s.subs = s.subs.map((b) => ({
    id: b.id || uid(),
    name: b.name || 'Subscription',
    amount: Number(b.amount) || 0,
    cycle: b.cycle || 'monthly',
    everyDays: Number(b.everyDays) || 30,
    nextDue: b.nextDue || todayKey(),
    categoryId: b.categoryId || 'bills',
    active: b.active !== false,
    bs: !!b.bs,
  }));
  return s;
}

export const state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch (err) {
    console.warn('Could not read saved data, starting fresh.', err);
  }
  return defaults();
}

const listeners = new Set();
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

let saveTimer = null;

/** Persist (debounced) and re-render. */
export function commit() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (err) {
      console.error('Save failed — storage may be full.', err);
    }
  }, 120);
  for (const fn of listeners) fn(state);
}

/* --------------------------------------------------------- mutations --- */

export function addExpense(data) {
  const e = {
    id: uid(),
    date: data.date || todayKey(),
    amount: Number(data.amount) || 0,
    categoryId: data.categoryId || 'other',
    note: (data.note || '').trim(),
    kind: data.kind === 'fixed' ? 'fixed' : 'variable',
    subId: data.subId || null,
    bs: !!data.bs,
  };
  state.expenses.push(e);
  commit();
  return e;
}

export function updateExpense(id, patch) {
  const e = state.expenses.find((x) => x.id === id);
  if (!e) return;
  Object.assign(e, patch, { amount: Number(patch.amount ?? e.amount) || 0 });
  commit();
}

export function removeExpense(id) {
  const i = state.expenses.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const [removed] = state.expenses.splice(i, 1);
  commit();
  return removed;
}

export function addIncome(data) {
  const inc = {
    id: uid(),
    date: data.date || todayKey(),
    amount: Number(data.amount) || 0,
    note: (data.note || '').trim(),
    paycheck: data.paycheck !== false,
  };
  state.incomes.push(inc);
  // A logged paycheck is the truth about the pay cycle — re-anchor the
  // forecast to it, since pay lands "every 15 days or so".
  if (inc.paycheck && inc.date >= state.settings.lastPayDate) {
    state.settings.lastPayDate = inc.date;
    if (!state.settings.payAmount) state.settings.payAmount = inc.amount;
  }
  commit();
  return inc;
}

export function removeIncome(id) {
  const i = state.incomes.findIndex((x) => x.id === id);
  if (i < 0) return;
  state.incomes.splice(i, 1);
  commit();
}

export function saveSub(data) {
  if (data.id) {
    const sub = state.subs.find((s) => s.id === data.id);
    if (sub) Object.assign(sub, data, { amount: Number(data.amount) || 0 });
  } else {
    state.subs.push({
      id: uid(),
      active: true,
      categoryId: 'bills',
      everyDays: 30,
      ...data,
      amount: Number(data.amount) || 0,
    });
  }
  commit();
}

export function removeSub(id) {
  state.subs = state.subs.filter((s) => s.id !== id);
  commit();
}

export function saveQuickAdd(data) {
  if (data.id) {
    const q = state.quickAdds.find((x) => x.id === data.id);
    if (q) Object.assign(q, data, { amount: Number(data.amount) || 0 });
  } else {
    state.quickAdds.push({ id: uid(), ...data, amount: Number(data.amount) || 0 });
  }
  commit();
}

export function removeQuickAdd(id) {
  state.quickAdds = state.quickAdds.filter((q) => q.id !== id);
  commit();
}

export function setSettings(patch) {
  Object.assign(state.settings, patch);
  commit();
}

/** Post any bills that came due while the app was closed. */
export function catchUpSubscriptions() {
  const due = chargeDueSubscriptions(state);
  if (!due.length) return 0;
  for (const d of due) state.expenses.push({ id: uid(), ...d });
  commit();
  return due.length;
}

/* --------------------------------------------------------- backup ------ */

export function exportJSON() {
  return JSON.stringify(state, null, 2);
}

export function importJSON(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') throw new Error('Not a backup file');
  const next = normalize(parsed);
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, next);
  commit();
}

export function wipe() {
  const next = defaults();
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, next);
  commit();
}
