// Run with: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  balanceOn, chargeDueSubscriptions, expectedPaydays, monthlyEquivalent,
  nextCycle, snapshot, upcomingCharges,
} from '../js/budget.js';

const base = (over = {}) => ({
  settings: {
    currency: 'EUR', monthlyGoal: 300, payAmount: 800, payCycleDays: 15,
    lastPayDate: '2026-09-08', startBalance: 400, startBalanceDate: '2026-09-01',
    cashGuard: true,
    ...(over.settings || {}),
  },
  categories: [{ id: 'bills', name: 'Bills', emoji: '🧾', color: '#a78bfa' }],
  quickAdds: [],
  expenses: over.expenses || [],
  incomes: over.incomes || [],
  subs: over.subs || [],
});

const exp = (date, amount, extra = {}) =>
  ({ id: date + amount, date, amount, categoryId: 'bills', kind: 'variable', bs: false, ...extra });

/* ---------------------------------------------------------- pay cycle -- */

test('paydays step by the cycle length, not by calendar month', () => {
  const s = base().settings;
  assert.deepEqual(
    expectedPaydays(s, '2026-09-01', '2026-10-31'),
    ['2026-09-08', '2026-09-23', '2026-10-08', '2026-10-23'],
  );
});

test('paydays are found even when the anchor is far in the past', () => {
  const s = base({ settings: { lastPayDate: '2025-01-03' } }).settings;
  const days = expectedPaydays(s, '2026-09-01', '2026-09-30');
  assert.equal(days.length, 2);
  assert.ok(days.every((d) => d >= '2026-09-01' && d <= '2026-09-30'));
});

/* ----------------------------------------------------- daily allowance -- */

test('the daily limit reserves the savings goal and every bill still due', () => {
  const state = base({
    incomes: [{ id: 'i1', date: '2026-09-08', amount: 800, paycheck: true }],
    expenses: [exp('2026-09-02', 30), exp('2026-09-10', 45)],
    subs: [{
      id: 's1', name: 'Spotify', amount: 10.99, cycle: 'monthly',
      nextDue: '2026-09-20', categoryId: 'bills', active: true,
    }],
  });
  const s = snapshot(state, '2026-09-15');

  // 800 in + 800 expected on the 23rd - 75 spent - 10.99 bill - 300 goal
  // = 1214.01 over the 16 days from the 15th to the 30th.
  assert.equal(s.incomeExpected, 800);
  assert.equal(s.fixedAfterToday, 10.99);
  assert.equal(s.daysLeft, 16);
  assert.equal(s.pacePool, 1214.01);
  assert.equal(s.paceAllowance, 75.88);
  assert.equal(s.allowance, 75.88);
  assert.equal(s.leftToday, 75.88);
});

test("today's spending comes straight off today's limit", () => {
  const state = base({
    incomes: [{ id: 'i1', date: '2026-09-08', amount: 800, paycheck: true }],
    expenses: [exp('2026-09-15', 20)],
  });
  const s = snapshot(state, '2026-09-15');
  assert.equal(s.leftToday, s.allowance - 20);
  assert.equal(s.spentTodayVariable, 20);
});

test('a bill charged today does not eat the daily spending money', () => {
  const withBill = base({
    incomes: [{ id: 'i1', date: '2026-09-08', amount: 800, paycheck: true }],
    expenses: [exp('2026-09-15', 50, { kind: 'fixed', subId: 's1' })],
  });
  const without = base({
    incomes: [{ id: 'i1', date: '2026-09-08', amount: 800, paycheck: true }],
  });
  const a = snapshot(withBill, '2026-09-15');
  const b = snapshot(without, '2026-09-15');

  // The bill lowers the pot, so the limit drops - but only by its share of the
  // remaining days, never by the whole 50 at once.
  assert.ok(a.leftToday < b.leftToday);
  assert.ok(b.leftToday - a.leftToday < 50);
  assert.equal(a.spentTodayFixed, 50);
  assert.equal(a.spentTodayVariable, 0);
});

/* ------------------------------------------------------- the cash guard - */

test('the limit never plans around money that has not arrived yet', () => {
  // Big paycheck coming, but almost nothing in the account right now.
  const state = base({
    settings: { startBalance: 60, startBalanceDate: '2026-09-15', monthlyGoal: 0 },
    incomes: [{ id: 'i1', date: '2026-09-08', amount: 800, paycheck: true }],
  });
  const s = snapshot(state, '2026-09-15');

  assert.equal(s.limitedBy, 'cash');
  assert.equal(s.balance, 60);
  assert.equal(s.daysToPay, 8);           // next payday is 23 Sep
  assert.equal(s.allowance, 7.5);         // 60 spread over 8 days
  assert.ok(s.paceAllowance > s.allowance);
});

test('turning the cash guard off falls back to the monthly pace', () => {
  const state = base({
    settings: {
      startBalance: 60, startBalanceDate: '2026-09-15', monthlyGoal: 0,
      cashGuard: false,
    },
    incomes: [{ id: 'i1', date: '2026-09-08', amount: 800, paycheck: true }],
  });
  const s = snapshot(state, '2026-09-15');
  assert.equal(s.limitedBy, 'pace');
  assert.equal(s.allowance, s.paceAllowance);
});

test('an impossible goal produces a negative limit rather than a fake one', () => {
  const state = base({
    settings: { monthlyGoal: 5000 },
    incomes: [{ id: 'i1', date: '2026-09-08', amount: 800, paycheck: true }],
  });
  const s = snapshot(state, '2026-09-15');
  assert.ok(s.allowance < 0, `expected a negative limit, got ${s.allowance}`);
  assert.equal(s.onTrack, false);
});

/* ------------------------------------------------------ subscriptions --- */

test('a monthly bill on the 31st lands on the last day of short months', () => {
  assert.equal(nextCycle({ cycle: 'monthly' }, '2026-01-31'), '2026-02-28');
  assert.equal(nextCycle({ cycle: 'weekly' }, '2026-09-28'), '2026-10-05');
  assert.equal(nextCycle({ cycle: 'yearly' }, '2026-09-28'), '2027-09-28');
  assert.equal(nextCycle({ cycle: 'days', everyDays: 10 }, '2026-09-28'), '2026-10-08');
});

test('every cycle is comparable as a monthly cost', () => {
  assert.equal(monthlyEquivalent({ cycle: 'monthly', amount: 12 }), 12);
  assert.equal(monthlyEquivalent({ cycle: 'yearly', amount: 120 }), 10);
  assert.equal(monthlyEquivalent({ cycle: 'weekly', amount: 3 }), 13);
  assert.equal(monthlyEquivalent({ cycle: 'days', everyDays: 15, amount: 5 }), 10.14);
});

test('missed bills are charged once each, on the day they were due', () => {
  const state = base({
    subs: [{
      id: 's1', name: 'Gym', amount: 30, cycle: 'monthly',
      nextDue: '2026-07-05', categoryId: 'bills', active: true,
    }],
  });
  const charges = chargeDueSubscriptions(state, '2026-09-15');
  assert.deepEqual(charges.map((c) => c.date), ['2026-07-05', '2026-08-05', '2026-09-05']);
  assert.equal(state.subs[0].nextDue, '2026-10-05');
  assert.ok(charges.every((c) => c.kind === 'fixed' && c.subId === 's1'));

  // Running it again must not double-charge.
  assert.deepEqual(chargeDueSubscriptions(state, '2026-09-15'), []);
});

test('a paused subscription neither charges nor forecasts', () => {
  const sub = {
    id: 's1', name: 'Gym', amount: 30, cycle: 'monthly',
    nextDue: '2026-09-20', categoryId: 'bills', active: false,
  };
  assert.deepEqual(upcomingCharges(sub, '2026-09-15', '2026-12-31'), []);
  const state = base({ subs: [sub] });
  assert.deepEqual(chargeDueSubscriptions(state, '2026-12-31'), []);
});

/* ------------------------------------------------------------ balance -- */

test('balance is the opening figure plus what came in, less what went out', () => {
  const state = base({
    incomes: [{ id: 'i1', date: '2026-09-08', amount: 800 }],
    expenses: [exp('2026-09-02', 30), exp('2026-09-10', 45)],
  });
  assert.equal(balanceOn(state, '2026-09-15'), 1125);
  assert.equal(balanceOn(state, '2026-09-05'), 370);
});

test('anything dated before the opening balance is ignored', () => {
  const state = base({
    settings: { startBalance: 100, startBalanceDate: '2026-09-10' },
    expenses: [exp('2026-09-02', 30)],
  });
  assert.equal(balanceOn(state, '2026-09-15'), 100);
});

/* ------------------------------------------------------------ totals --- */

test('BS spending is counted separately from the rest', () => {
  const state = base({
    expenses: [exp('2026-09-10', 45, { bs: true }), exp('2026-09-11', 20)],
  });
  const s = snapshot(state, '2026-09-15');
  assert.equal(s.bsMonth, 45);
  assert.equal(s.spentMonth, 65);
});

test('last day of the month still leaves one day to budget for', () => {
  const state = base({
    incomes: [{ id: 'i1', date: '2026-09-08', amount: 800 }],
  });
  const s = snapshot(state, '2026-09-30');
  assert.equal(s.daysLeft, 1);
  assert.ok(Number.isFinite(s.allowance));
});

test('a brand new install does not produce NaN anywhere', () => {
  const state = base({
    settings: {
      monthlyGoal: 0, payAmount: 0, startBalance: 0, lastPayDate: '2026-09-15',
    },
  });
  const s = snapshot(state, '2026-09-15');
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} is ${v}`);
  }
});
