// The five screens. Each returns { title, sub, html, mount }.

import {
  categoryBreakdown, dailySeries, expectedPaydays, monthlyEquivalent, snapshot,
} from './budget.js';
import { state } from './store.js';
import { esc } from './ui.js';
import {
  addDays, daysBetween, fromKey, monthEnd, monthLabel, money, prettyDate,
  round2, sum, todayKey,
} from './util.js';

/** Which month the Log and Stats screens are looking at. */
export let anchor = todayKey();
export const setAnchor = (key) => { anchor = key; };

const cur = () => state.settings.currency || 'EUR';
const fmt = (n, opts) => money(n, cur(), opts);
const catOf = (id) => state.categories.find((c) => c.id === id)
  || { id, name: 'Other', emoji: '📦', color: '#94a3b8' };

const empty = (emoji, text) =>
  `<div class="empty"><span class="e">${emoji}</span>${esc(text)}</div>`;

/* =========================================================== TODAY ===== */

export function today() {
  const s = snapshot(state);
  const spent = s.spentTodayVariable;
  const pct = s.allowance > 0 ? Math.min(1, spent / s.allowance) : (spent > 0 ? 1 : 0);
  const over = s.leftToday < 0;
  const tight = !over && s.allowance > 0 && s.leftToday < s.allowance * 0.2;

  const tone = over ? 'bad' : tight ? 'warn' : 'good';
  const glow = over ? 'rgba(248,113,113,.18)'
    : tight ? 'rgba(251,191,36,.16)' : 'rgba(52,211,153,.16)';

  const headline = s.goal <= 0
    ? 'Set a savings goal to get a daily limit'
    : over
      ? `${fmt(Math.abs(s.leftToday))} over today's limit`
      : `of ${fmt(s.allowance)} left for today`;

  const why = s.limitedBy === 'cash'
    ? `Capped by cash on hand until ${prettyDate(s.nextPayday).toLowerCase()}`
    : `Paced to save ${fmt(s.goal)} this month`;

  const rows = state.expenses
    .filter((e) => e.date === s.day)
    .sort((a, b) => b.id.localeCompare(a.id));

  const paydaySoon = expectedPaydays(state.settings, addDays(s.day, -2), addDays(s.day, 1))
    .filter((p) => !state.incomes.some((i) => Math.abs(daysBetween(p, i.date)) <= 3));

  return {
    title: 'Today',
    sub: fromKey(s.day).toLocaleDateString(undefined,
      { weekday: 'long', day: 'numeric', month: 'long' }),
    html: `
      <section>
        <div class="card hero" style="--glow:${glow}">
          <div class="label">Safe to spend</div>
          <div class="amount ${tone} num">${fmt(over ? 0 : s.leftToday)}</div>
          <div class="note">${esc(headline)}</div>
          <div class="meter">
            <i class="${over ? 'over' : 'spent'}" style="width:${pct * 100}%"></i>
          </div>
          <div class="hero-foot">
            <span class="num">${fmt(spent)} spent today</span>
            <span class="num">${s.daysLeft} ${s.daysLeft === 1 ? 'day' : 'days'} left in ${monthLabel(s.day).split(' ')[0]}</span>
          </div>
          <div class="chips">
            <span class="chip ${s.limitedBy === 'cash' ? 'warn' : ''}">${esc(why)}</span>
            <span class="chip ${s.onTrack ? 'good' : 'bad'}">
              ${s.onTrack ? 'On track' : 'Off track'} · saving ${fmt(s.projectedSaved)}
            </span>
          </div>
        </div>
      </section>

      ${paydaySoon.length ? `
        <section>
          <button class="row" data-act="income">
            <span class="ico" style="background:#14392c">💰</span>
            <span class="body">
              <span class="title">Payday — log your paycheck</span>
              <span class="meta">Expected ${esc(prettyDate(paydaySoon[0]))}. Keeps the forecast honest.</span>
            </span>
            <span class="amt in">+</span>
          </button>
        </section>` : ''}

      <section>
        <div class="section-head">
          <h2>Quick add</h2>
          <button class="right" data-act="edit-quick">Edit</button>
        </div>
        <div class="quick-grid">
          ${state.quickAdds.map((q) => `
            <button class="quick ${q.bs ? 'is-bs' : ''}" data-quick="${esc(q.id)}">
              <span class="e">${esc(q.emoji || '💸')}</span>
              <span class="l">${esc(q.label)}${q.bs ? ' ·bs' : ''}</span>
              <span class="a num">${fmt(q.amount, { whole: true })}</span>
            </button>`).join('')}
          <button class="quick" data-act="add"><span class="e">✏️</span>
            <span class="l">Other</span><span class="a">amount</span></button>
        </div>
      </section>

      <section>
        <div class="section-head"><h2>Today's spending</h2>
          <span class="right num" style="color:var(--dim)">${fmt(s.spentToday)}</span>
        </div>
        ${rows.length ? rows.map(expenseRow).join('') : empty('🌱', 'Nothing spent yet today.')}
      </section>`,
  };
}

function expenseRow(e) {
  const c = catOf(e.categoryId);
  const meta = [
    e.kind === 'fixed' ? 'Subscription' : c.name,
    e.bs ? '<span class="tag-bs">BS</span>' : '',
  ].filter(Boolean).join(' · ');
  return `
    <button class="row" data-expense="${esc(e.id)}">
      <span class="ico" style="color:${esc(c.color)}">${esc(e.kind === 'fixed' ? '🔁' : c.emoji)}</span>
      <span class="body">
        <span class="title">${esc(e.note || c.name)}</span>
        <span class="meta">${meta}</span>
      </span>
      <span class="amt num">−${fmt(e.amount)}</span>
    </button>`;
}

function incomeRow(i) {
  return `
    <button class="row" data-income="${esc(i.id)}">
      <span class="ico" style="background:#14392c">💰</span>
      <span class="body">
        <span class="title">${esc(i.note || (i.paycheck ? 'Paycheck' : 'Income'))}</span>
        <span class="meta">Money in</span>
      </span>
      <span class="amt in num">+${fmt(i.amount)}</span>
    </button>`;
}

/* ============================================================= LOG ===== */

export let logFilter = 'all';
export const setLogFilter = (f) => { logFilter = f; };

export function log() {
  const mStart = anchor.slice(0, 7) + '-01';
  const mEnd = monthEnd(anchor);

  let expenses = state.expenses.filter((e) => e.date >= mStart && e.date <= mEnd);
  if (logFilter === 'bs') expenses = expenses.filter((e) => e.bs);
  if (logFilter === 'fixed') expenses = expenses.filter((e) => e.kind === 'fixed');

  const incomes = logFilter === 'all'
    ? state.incomes.filter((i) => i.date >= mStart && i.date <= mEnd) : [];

  const byDay = new Map();
  for (const e of expenses) {
    if (!byDay.has(e.date)) byDay.set(e.date, { out: [], in: [] });
    byDay.get(e.date).out.push(e);
  }
  for (const i of incomes) {
    if (!byDay.has(i.date)) byDay.set(i.date, { out: [], in: [] });
    byDay.get(i.date).in.push(i);
  }
  const days = [...byDay.keys()].sort().reverse();
  const total = sum(expenses, (e) => e.amount);

  const isThisMonth = mStart === todayKey().slice(0, 7) + '-01';

  return {
    title: 'Log',
    sub: monthLabel(anchor),
    html: `
      <section>
        <div class="card" style="display:flex;align-items:center;gap:10px;padding:10px 12px">
          <button class="btn ghost" data-month="-1" style="width:44px;min-height:40px">‹</button>
          <div style="flex:1;text-align:center">
            <div style="font-weight:640">${esc(monthLabel(anchor))}</div>
            <div style="font-size:12px;color:var(--faint)" class="num">${fmt(total)} out</div>
          </div>
          <button class="btn ghost" data-month="1" ${isThisMonth ? 'disabled' : ''}
            style="width:44px;min-height:40px${isThisMonth ? ';opacity:.3' : ''}">›</button>
        </div>
      </section>

      <section>
        <div class="seg">
          <button data-filter="all" aria-pressed="${logFilter === 'all'}">Everything</button>
          <button data-filter="bs" aria-pressed="${logFilter === 'bs'}">BS only</button>
          <button data-filter="fixed" aria-pressed="${logFilter === 'fixed'}">Subscriptions</button>
        </div>
      </section>

      <section>
        ${days.length ? days.map((d) => {
          const g = byDay.get(d);
          const dayOut = sum(g.out, (e) => e.amount);
          return `
            <div class="day-head"><b>${esc(prettyDate(d))}</b>
              <span class="num">${dayOut ? `−${fmt(dayOut)}` : ''}</span></div>
            ${g.in.map(incomeRow).join('')}
            ${g.out.sort((a, b) => b.id.localeCompare(a.id)).map(expenseRow).join('')}`;
        }).join('') : empty('🗒️', 'Nothing recorded for this month yet.')}
      </section>`,
  };
}

/* =========================================================== BILLS ===== */

export function bills() {
  const subs = [...state.subs].sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  const perMonth = round2(sum(subs.filter((s) => s.active), monthlyEquivalent));
  const s = snapshot(state);

  return {
    title: 'Bills',
    sub: 'Subscriptions & recurring',
    html: `
      <section>
        <div class="card">
          <div class="stat-grid">
            <div class="stat"><div class="k">Per month</div>
              <div class="v num">${fmt(perMonth)}</div>
              <div class="s">${subs.filter((x) => x.active).length} active</div></div>
            <div class="stat"><div class="k">Left this month</div>
              <div class="v num">${fmt(s.fixedAfterToday)}</div>
              <div class="s">${s.billsAfterToday.length} still to charge</div></div>
          </div>
          <div style="margin-top:12px;font-size:12px;color:var(--faint)">
            These are reserved before your daily limit is worked out, so a bill
            landing never eats your spending money.
          </div>
        </div>
      </section>

      <section>
        <div class="section-head"><h2>Recurring</h2>
          <button class="right" data-act="add-sub">+ Add</button></div>
        ${subs.length ? subs.map((sub) => {
          const c = catOf(sub.categoryId);
          const days = daysBetween(todayKey(), sub.nextDue);
          const due = days <= 0 ? 'due today' : days === 1 ? 'in 1 day' : `in ${days} days`;
          return `
            <button class="row" data-sub="${esc(sub.id)}" style="${sub.active ? '' : 'opacity:.45'}">
              <span class="ico" style="color:${esc(c.color)}">${esc(sub.emoji || '🔁')}</span>
              <span class="body">
                <span class="title">${esc(sub.name)}${sub.bs ? ' <span class="tag-bs">BS</span>' : ''}</span>
                <span class="meta">${sub.active
                  ? `${esc(cycleLabel(sub))} · next ${esc(prettyDate(sub.nextDue))} (${due})`
                  : 'Paused'}</span>
              </span>
              <span class="amt num">${fmt(sub.amount)}</span>
            </button>`;
        }).join('') : empty('🔁', 'No subscriptions yet. Add the ones that drain you monthly.')}
      </section>

      ${subs.length ? `
      <section>
        <div class="section-head"><h2>Cost per month, biggest first</h2></div>
        <div class="card">
          ${[...subs].filter((x) => x.active)
            .sort((a, b) => monthlyEquivalent(b) - monthlyEquivalent(a))
            .map((sub) => {
              const m = monthlyEquivalent(sub);
              const w = perMonth ? (m / perMonth) * 100 : 0;
              return `<div class="bar-row">
                <span class="n">${esc(sub.name)}</span>
                <span class="track"><i style="width:${w}%;background:${esc(catOf(sub.categoryId).color)}"></i></span>
                <span class="v num">${fmt(m)}</span></div>`;
            }).join('')}
          <div class="bar-row" style="border-top:1px solid var(--line);margin-top:6px;padding-top:12px">
            <span class="n" style="color:var(--dim)">Per year</span>
            <span class="track" style="background:none"></span>
            <span class="v num">${fmt(perMonth * 12)}</span>
          </div>
        </div>
      </section>` : ''}`,
  };
}

export function cycleLabel(sub) {
  switch (sub.cycle) {
    case 'weekly': return 'Weekly';
    case 'yearly': return 'Yearly';
    case 'days': return `Every ${sub.everyDays} days`;
    default: return 'Monthly';
  }
}

/* =========================================================== STATS ===== */

export function stats() {
  const isCurrent = anchor.slice(0, 7) === todayKey().slice(0, 7);
  const day = isCurrent ? todayKey() : monthEnd(anchor);
  const s = snapshot(state, day);
  const cats = categoryBreakdown(state, day);
  const series = dailySeries(state, day);
  const maxDay = Math.max(s.allowance, ...series.map((d) => d.amount), 1);

  // Progress is measured against where the month is HEADING, not against the
  // running total — that figure jumps the moment a paycheck lands and would
  // call the goal met on the 15th.
  const goalPct = s.goal > 0 ? Math.max(0, Math.min(1, s.projectedSaved / s.goal)) : 0;
  const shortBy = round2(s.goal - s.projectedSaved);
  const bsShare = s.spentMonth ? s.bsMonth / s.spentMonth : 0;

  return {
    title: 'Stats',
    sub: monthLabel(anchor),
    html: `
      <section>
        <div class="card" style="display:flex;align-items:center;gap:10px;padding:10px 12px">
          <button class="btn ghost" data-month="-1" style="width:44px;min-height:40px">‹</button>
          <div style="flex:1;text-align:center;font-weight:640">${esc(monthLabel(anchor))}</div>
          <button class="btn ghost" data-month="1" ${isCurrent ? 'disabled' : ''}
            style="width:44px;min-height:40px${isCurrent ? ';opacity:.3' : ''}">›</button>
        </div>
      </section>

      <section>
        <div class="section-head"><h2>Savings goal</h2></div>
        <div class="card">
          <div style="display:flex;align-items:baseline;gap:8px">
            <div class="num" style="font-size:30px;font-weight:700;letter-spacing:-1px;
              color:${s.onTrack ? 'var(--good)' : 'var(--bad)'}">
              ${fmt(s.projectedSaved)}</div>
            <div style="color:var(--faint);font-size:13px">
              heading for, of ${esc(fmt(s.goal))}</div>
          </div>
          <div class="meter">
            <i class="${s.onTrack ? 'spent' : 'over'}" style="width:${goalPct * 100}%"></i>
          </div>
          <div class="hero-foot">
            <span class="num">${fmt(s.savedSoFar)} kept so far</span>
            <span class="num" style="color:${s.onTrack ? 'var(--good)' : 'var(--bad)'}">
              ${s.goal <= 0 ? 'no goal set'
                : s.onTrack ? `${fmt(-shortBy)} clear` : `${fmt(shortBy)} short`}</span>
          </div>
          <div style="font-size:11.5px;color:var(--faint);margin-top:8px">
            ${isCurrent
              ? `Where the month lands if you keep spending ${esc(fmt(s.avgPerDay))} a day.`
              : 'Final figure for the month.'}
          </div>
        </div>
      </section>

      <section>
        <div class="section-head"><h2>This month</h2></div>
        <div class="stat-grid">
          <div class="stat"><div class="k">Money in</div>
            <div class="v good num">${fmt(s.incomeSoFar)}</div>
            <div class="s">${s.incomeExpected ? `+${fmt(s.incomeExpected)} expected` : 'all paychecks in'}</div></div>
          <div class="stat"><div class="k">Money out</div>
            <div class="v num">${fmt(s.spentMonth)}</div>
            <div class="s">${fmt(s.avgPerDay)}/day average</div></div>
          <div class="stat"><div class="k">Subscriptions</div>
            <div class="v num">${fmt(s.fixedMonth)}</div>
            <div class="s">${fmt(s.fixedAfterToday)} still due</div></div>
          <div class="stat"><div class="k">BS spending</div>
            <div class="v bs num">${fmt(s.bsMonth)}</div>
            <div class="s">${Math.round(bsShare * 100)}% of everything</div></div>
        </div>
        ${s.bsMonth > 0 ? `
          <div class="card" style="margin-top:10px;border-color:#58304a">
            <div style="font-size:13.5px">
              Cutting the BS would put <b class="num" style="color:var(--bs)">${fmt(s.bsMonth)}</b>
              back in your pocket — that is
              <b class="num">${fmt(s.bsMonth / Math.max(1, s.dayOfMonth))}</b> a day,
              or <b class="num">${fmt(s.bsMonth * 12)}</b> a year at this rate.
            </div>
          </div>` : ''}
      </section>

      <section>
        <div class="section-head"><h2>Day by day</h2></div>
        <div class="card">
          <div class="spark">
            ${series.map((d) => {
              const h = Math.max(2, (d.amount / maxDay) * 100);
              const cls = d.future ? 'future' : !d.amount ? 'zero'
                : d.date === todayKey() ? 'today'
                  : d.amount > s.allowance && s.allowance > 0 ? 'over' : '';
              return `<i class="${cls}" style="height:${h}%" title="${esc(d.date)}"></i>`;
            }).join('')}
          </div>
          <div class="legend"><span>1</span>
            <span>daily limit ${esc(fmt(s.allowance))}</span>
            <span>${series.length}</span></div>
        </div>
      </section>

      <section>
        <div class="section-head"><h2>Where it went</h2></div>
        <div class="card">
          ${cats.length ? cats.map((row) => `
            <div class="bar-row">
              <span class="n">${esc(row.category.emoji)} ${esc(row.category.name)}</span>
              <span class="track"><i style="width:${row.share * 100}%;
                background:${esc(row.category.color)}"></i></span>
              <span class="v num">${fmt(row.amount)}</span>
            </div>`).join('') : empty('📊', 'No spending recorded this month.')}
        </div>
      </section>

      <section>
        <div class="section-head"><h2>Pay cycle</h2></div>
        <div class="card">
          <div class="bar-row"><span class="n">Balance now</span>
            <span class="track" style="background:none"></span>
            <span class="v num">${fmt(s.balance)}</span></div>
          <div class="bar-row"><span class="n">Next paycheck</span>
            <span class="track" style="background:none"></span>
            <span class="v num">${esc(prettyDate(s.nextPayday))}</span></div>
          <div class="bar-row"><span class="n">Days to stretch</span>
            <span class="track" style="background:none"></span>
            <span class="v num">${s.daysToPay}</span></div>
          <div class="bar-row"><span class="n">Cash limit / day</span>
            <span class="track" style="background:none"></span>
            <span class="v num">${fmt(s.cashAllowance)}</span></div>
          <div class="bar-row"><span class="n">Goal pace / day</span>
            <span class="track" style="background:none"></span>
            <span class="v num">${fmt(s.paceAllowance)}</span></div>
          <div style="font-size:12px;color:var(--faint);margin-top:8px">
            Your daily limit is the smaller of the two, so you never plan around
            money that has not landed yet.
          </div>
        </div>
      </section>`,
  };
}

export const views = { today, log, bills, stats };
