// The money engine. Everything the UI shows is derived here so the numbers
// can never drift between screens.

import {
  addDays, addMonths, daysBetween, monthEnd, monthStart, round2, sum, todayKey,
} from './util.js';

/* ------------------------------------------------- subscription cycles -- */

/** Advance a due date by one billing cycle. */
export function nextCycle(sub, dueKey) {
  switch (sub.cycle) {
    case 'weekly': return addDays(dueKey, 7);
    case 'yearly': return addMonths(dueKey, 12);
    case 'days': return addDays(dueKey, Math.max(1, sub.everyDays || 30));
    case 'monthly':
    default: return addMonths(dueKey, 1);
  }
}

/** What one subscription costs per 30 days, for comparing plans. */
export function monthlyEquivalent(sub) {
  const a = Number(sub.amount) || 0;
  switch (sub.cycle) {
    case 'weekly': return round2((a * 52) / 12);
    case 'yearly': return round2(a / 12);
    case 'days': return round2((a * 365) / (Math.max(1, sub.everyDays || 30) * 12));
    case 'monthly':
    default: return round2(a);
  }
}

/**
 * Charges an active subscription will incur in (afterKey, untilKey].
 * Purely a forecast — it never writes anything.
 */
export function upcomingCharges(sub, afterKey, untilKey) {
  if (!sub.active) return [];
  const out = [];
  let due = sub.nextDue;
  // Guard against a pathological config looping forever.
  for (let i = 0; i < 400 && due <= untilKey; i++) {
    if (due > afterKey) out.push({ date: due, amount: Number(sub.amount) || 0, sub });
    due = nextCycle(sub, due);
  }
  return out;
}

/** Roll any subscription whose due date has arrived into real expenses. */
export function chargeDueSubscriptions(state, upTo = todayKey()) {
  const created = [];
  for (const sub of state.subs) {
    if (!sub.active) continue;
    for (let i = 0; i < 400 && sub.nextDue <= upTo; i++) {
      created.push({
        date: sub.nextDue,
        amount: Number(sub.amount) || 0,
        categoryId: sub.categoryId || 'bills',
        note: sub.name,
        kind: 'fixed',
        subId: sub.id,
        bs: !!sub.bs,
      });
      sub.nextDue = nextCycle(sub, sub.nextDue);
    }
  }
  return created;
}

/* ------------------------------------------------------------ paydays -- */

/**
 * Expected paydays in [fromKey, toKey], extrapolated from the last known
 * payday and the cycle length. "Every 15 days or so" — so these are
 * estimates used for forecasting, not ledger entries.
 */
export function expectedPaydays(settings, fromKey, toKey) {
  const cycle = Math.max(1, Number(settings.payCycleDays) || 15);
  const anchor = settings.lastPayDate;
  if (!anchor) return [];

  // Walk back to at or before the window, then forward through it.
  let d = anchor;
  const backSteps = Math.ceil(Math.max(0, daysBetween(fromKey, d)) / cycle);
  d = addDays(d, -backSteps * cycle);

  const out = [];
  for (let i = 0; i < 400 && d <= toKey; i++) {
    if (d >= fromKey) out.push(d);
    d = addDays(d, cycle);
  }
  return out;
}

export function nextPayday(settings, from = todayKey()) {
  const days = expectedPaydays(settings, addDays(from, 1), addDays(from, 400));
  return days[0] || addDays(from, 15);
}

/** A predicted payday counts as "already banked" if income landed near it. */
function paydayAlreadyLogged(incomes, payKey, slack = 3) {
  return incomes.some((i) => Math.abs(daysBetween(payKey, i.date)) <= slack);
}

/* ------------------------------------------------------------ balance -- */

export function balanceOn(state, key = todayKey()) {
  const { startBalance = 0, startBalanceDate } = state.settings;
  const since = startBalanceDate || '0000-01-01';
  const inc = sum(state.incomes.filter((i) => i.date >= since && i.date <= key), (i) => i.amount);
  const exp = sum(state.expenses.filter((e) => e.date >= since && e.date <= key), (e) => e.amount);
  return round2(Number(startBalance || 0) + inc - exp);
}

/* ------------------------------------------------------- the snapshot -- */

const inRange = (list, a, b) => list.filter((x) => x.date >= a && x.date <= b);
const isFixed = (e) => e.kind === 'fixed';

/**
 * Everything about "where do I stand today".
 *
 * The goal is monthly but income arrives every ~15 days, so two limits are
 * computed and the tighter one wins:
 *   1. pace  - spread the month's leftover money evenly over the days left,
 *              after reserving the savings goal and every bill still due.
 *   2. cash  - never plan to spend money that is not in the account yet:
 *              cash on hand, minus bills due before the next paycheck,
 *              spread over the days until that paycheck.
 */
export function snapshot(state, day = todayKey()) {
  const s = state.settings;
  const mStart = monthStart(day);
  const mEnd = monthEnd(day);
  const goal = Number(s.monthlyGoal) || 0;

  const daysLeft = Math.max(1, daysBetween(day, mEnd) + 1);
  const dayOfMonth = daysBetween(mStart, day) + 1;

  /* ---- what has already happened this month ---- */
  const monthExpenses = inRange(state.expenses, mStart, mEnd);
  const monthIncomes = inRange(state.incomes, mStart, mEnd);

  const before = monthExpenses.filter((e) => e.date < day);
  const today = monthExpenses.filter((e) => e.date === day);

  const spentBefore = sum(before, (e) => e.amount);
  const spentToday = sum(today, (e) => e.amount);
  const spentTodayVariable = sum(today.filter((e) => !isFixed(e)), (e) => e.amount);
  const spentTodayFixed = round2(spentToday - spentTodayVariable);
  const spentMonth = round2(spentBefore + spentToday);
  const bsMonth = sum(monthExpenses.filter((e) => e.bs), (e) => e.amount);
  const fixedMonth = sum(monthExpenses.filter(isFixed), (e) => e.amount);
  const variableMonth = round2(spentMonth - fixedMonth);

  const incomeSoFar = sum(monthIncomes, (i) => i.amount);

  /* ---- what is still coming ---- */
  const payAmount = Number(s.payAmount) || 0;
  const futurePaydays = expectedPaydays(s, addDays(day, 1), mEnd)
    .filter((p) => !paydayAlreadyLogged(state.incomes, p));
  const incomeExpected = round2(payAmount * futurePaydays.length);

  const billsAfterToday = state.subs.flatMap((sub) => upcomingCharges(sub, day, mEnd));
  const fixedAfterToday = sum(billsAfterToday, (b) => b.amount);
  // Bills charged today are already money gone, but must not eat today's
  // spending money — so they belong to the fixed side, not the daily side.
  const fixedFromTodayOn = round2(spentTodayFixed + fixedAfterToday);

  /* ---- limit 1: pace toward the goal ---- */
  const pacePool = round2(
    incomeSoFar + incomeExpected - spentBefore - fixedFromTodayOn - goal,
  );
  const paceAllowance = round2(pacePool / daysLeft);

  /* ---- limit 2: don't outspend the cash on hand ---- */
  const balance = balanceOn(state, day);
  const payKey = nextPayday(s, day);
  const daysToPay = Math.max(1, daysBetween(day, payKey));
  const billsBeforePay = state.subs.flatMap((sub) =>
    upcomingCharges(sub, day, addDays(payKey, -1)));
  const cashPool = round2(balance + spentTodayVariable - sum(billsBeforePay, (b) => b.amount));
  const cashAllowance = round2(cashPool / daysToPay);

  const guarded = s.cashGuard !== false;
  const limitedBy = !guarded || paceAllowance <= cashAllowance ? 'pace' : 'cash';
  const allowance = round2(
    guarded ? Math.min(paceAllowance, cashAllowance) : paceAllowance,
  );
  const leftToday = round2(allowance - spentTodayVariable);

  /* ---- where the month is heading at the current rate ---- */
  const avgPerDay = dayOfMonth > 0 ? round2(variableMonth / dayOfMonth) : 0;
  const projectedSpend = round2(spentMonth + fixedAfterToday + avgPerDay * (daysLeft - 1));
  const projectedSaved = round2(incomeSoFar + incomeExpected - projectedSpend);
  const savedSoFar = round2(incomeSoFar - spentMonth);

  return {
    day, monthStart: mStart, monthEnd: mEnd, daysLeft, dayOfMonth, goal,
    allowance, leftToday, limitedBy,
    paceAllowance, cashAllowance, pacePool, cashPool,
    spentToday, spentTodayVariable, spentTodayFixed, spentMonth,
    variableMonth, fixedMonth, bsMonth,
    incomeSoFar, incomeExpected, futurePaydays,
    balance, nextPayday: payKey, daysToPay,
    fixedAfterToday, billsAfterToday,
    savedSoFar, projectedSaved, avgPerDay,
    onTrack: projectedSaved >= goal,
  };
}

/** Per-category totals for a month, biggest first. */
export function categoryBreakdown(state, day = todayKey()) {
  const rows = inRange(state.expenses, monthStart(day), monthEnd(day));
  const total = sum(rows, (e) => e.amount);
  const byCat = new Map();
  for (const e of rows) {
    byCat.set(e.categoryId, round2((byCat.get(e.categoryId) || 0) + (Number(e.amount) || 0)));
  }
  return [...byCat.entries()]
    .map(([id, amount]) => ({
      category: state.categories.find((c) => c.id === id) ||
        { id, name: 'Other', emoji: '•', color: '#8b8b95' },
      amount,
      share: total ? amount / total : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
}

/** Daily variable spend for the current month, for the bar chart. */
export function dailySeries(state, day = todayKey()) {
  const mStart = monthStart(day);
  const mEnd = monthEnd(day);
  const out = [];
  for (let k = mStart; k <= mEnd; k = addDays(k, 1)) {
    const rows = state.expenses.filter((e) => e.date === k && !isFixed(e));
    out.push({ date: k, amount: sum(rows, (e) => e.amount), future: k > day });
  }
  return out;
}
