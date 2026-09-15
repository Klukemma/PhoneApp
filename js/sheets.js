// Bottom sheets: adding and editing everything.

import {
  addExpense, addIncome, exportJSON, importJSON, removeExpense, removeIncome,
  removeQuickAdd, removeSub, saveQuickAdd, saveSub, setSettings, state,
  updateExpense, wipe,
} from './store.js';
import {
  $, $$, closeSheet, esc, keypadHTML, openSheet, symbolFor, toast, wireKeypad,
} from './ui.js';
import { addDays, money, todayKey } from './util.js';

const cur = () => state.settings.currency || 'EUR';

const catButtons = (selected) => state.categories.map((c) =>
  `<button type="button" data-cat="${esc(c.id)}" aria-pressed="${c.id === selected}">
     ${esc(c.emoji)} ${esc(c.name)}</button>`).join('');

/** Shared category + BS picker behaviour. */
function wireCatPicker(root, initial) {
  const pick = { cat: initial.categoryId, bs: !!initial.bs };
  root.querySelector('[data-cats]')?.addEventListener('click', (e) => {
    const id = e.target.closest('[data-cat]')?.dataset.cat;
    if (!id) return;
    pick.cat = id;
    $$('[data-cat]', root).forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.cat === id)));
  });
  const bsBtn = root.querySelector('[data-bs]');
  bsBtn?.addEventListener('click', () => {
    pick.bs = !pick.bs;
    bsBtn.setAttribute('aria-pressed', String(pick.bs));
  });
  return pick;
}

const bsToggle = (on) => `
  <div class="toggle" style="margin-bottom:12px">
    <div class="body">
      <div class="t">Mark as BS 🙈</div>
      <div class="d">Money you regret. Tracked separately so you can see the damage.</div>
    </div>
    <button class="switch" data-bs aria-pressed="${!!on}" aria-label="Mark as BS spending"></button>
  </div>`;

/* ------------------------------------------------- expense: add/edit --- */

export function openExpense(existing = null, preset = {}) {
  const editing = !!existing;
  const init = existing || {
    amount: preset.amount || 0,
    categoryId: preset.categoryId || state.categories[0].id,
    note: preset.note || '',
    bs: !!preset.bs,
    date: todayKey(),
    kind: 'variable',
  };

  openSheet(`
    <h2>${editing ? 'Edit expense' : 'Add expense'}</h2>
    <div class="amount-display zero" id="amtDisp">${symbolFor(cur())}0</div>
    ${keypadHTML()}
    <div class="field" style="margin-top:14px">
      <label>What for</label>
      <input type="text" id="note" placeholder="optional note"
        value="${esc(init.note)}" enterkeyhint="done">
    </div>
    <div class="field">
      <label>Category</label>
      <div class="seg cats" data-cats>${catButtons(init.categoryId)}</div>
    </div>
    <div class="field">
      <label>Date</label>
      <input type="date" id="date" value="${esc(init.date)}" max="${todayKey()}">
    </div>
    ${bsToggle(init.bs)}
    <div class="sheet-actions">
      <button class="btn primary" id="save">${editing ? 'Save changes' : 'Add expense'}</button>
      ${editing ? '<button class="btn ghost danger" id="del">Delete</button>' : ''}
    </div>
  `, {
    onMount(root) {
      const disp = $('#amtDisp', root);
      const pad = wireKeypad(root, disp, { currency: cur() });
      pad.set(init.amount || '');
      const pick = wireCatPicker(root, init);

      $('#save', root).onclick = () => {
        const amount = pad.value();
        if (amount <= 0) { toast('Enter an amount first'); return; }
        const data = {
          amount,
          note: $('#note', root).value,
          categoryId: pick.cat,
          bs: pick.bs,
          date: $('#date', root).value || todayKey(),
          kind: init.kind,
        };
        if (editing) {
          updateExpense(existing.id, data);
          toast('Updated');
        } else {
          addExpense(data);
          toast(`${money(amount, cur())} logged`);
        }
        closeSheet();
      };

      $('#del', root)?.addEventListener('click', () => {
        const removed = removeExpense(existing.id);
        closeSheet();
        toast('Deleted', { label: 'Undo', run: () => { addExpense(removed); toast('Restored'); } });
      });
    },
  });
}

/** One tap from the Today screen — logged instantly, undoable. */
export function quickAdd(q) {
  const e = addExpense({
    amount: q.amount, categoryId: q.categoryId, note: q.label, bs: q.bs,
  });
  toast(`${q.emoji || ''} ${q.label} · ${money(q.amount, cur())}`, {
    label: 'Undo',
    run: () => { removeExpense(e.id); toast('Removed'); },
  });
}

/* ---------------------------------------------------------- income ----- */

export function openIncome(existing = null) {
  const init = existing || { amount: state.settings.payAmount || 0, note: '', date: todayKey(), paycheck: true };
  openSheet(`
    <h2>${existing ? 'Edit income' : 'Money in'}</h2>
    <div class="amount-display zero" id="amtDisp">${symbolFor(cur())}0</div>
    ${keypadHTML()}
    <div class="field" style="margin-top:14px">
      <label>Where from</label>
      <input type="text" id="note" placeholder="Paycheck" value="${esc(init.note)}">
    </div>
    <div class="field"><label>Date</label>
      <input type="date" id="date" value="${esc(init.date)}"></div>
    <div class="toggle" style="margin-bottom:12px">
      <div class="body"><div class="t">This is my paycheck</div>
        <div class="d">Re-times the next payday forecast from this date.</div></div>
      <button class="switch" data-pay aria-pressed="${init.paycheck !== false}"></button>
    </div>
    <div class="sheet-actions">
      <button class="btn primary" id="save">Save</button>
      ${existing ? '<button class="btn ghost danger" id="del">Delete</button>' : ''}
    </div>
  `, {
    onMount(root) {
      const pad = wireKeypad(root, $('#amtDisp', root), { currency: cur() });
      pad.set(init.amount || '');
      let paycheck = init.paycheck !== false;
      const payBtn = $('[data-pay]', root);
      payBtn.onclick = () => {
        paycheck = !paycheck;
        payBtn.setAttribute('aria-pressed', String(paycheck));
      };
      $('#save', root).onclick = () => {
        const amount = pad.value();
        if (amount <= 0) { toast('Enter an amount first'); return; }
        if (existing) removeIncome(existing.id);
        addIncome({ amount, note: $('#note', root).value, date: $('#date', root).value, paycheck });
        closeSheet();
        toast(`${money(amount, cur())} in`);
      };
      $('#del', root)?.addEventListener('click', () => {
        removeIncome(existing.id); closeSheet(); toast('Deleted');
      });
    },
  });
}

/* ---------------------------------------------------- subscriptions ---- */

const CYCLES = [['monthly', 'Monthly'], ['weekly', 'Weekly'], ['yearly', 'Yearly'], ['days', 'Every N days']];

export function openSub(existing = null) {
  const init = existing || {
    name: '', amount: 0, cycle: 'monthly', everyDays: 30,
    nextDue: addDays(todayKey(), 1), categoryId: 'bills', active: true, bs: false,
  };

  openSheet(`
    <h2>${existing ? 'Edit subscription' : 'New subscription'}</h2>
    <div class="field"><label>Name</label>
      <input type="text" id="name" placeholder="Netflix, gym, phone plan…"
        value="${esc(init.name)}"></div>
    <div class="two">
      <div class="field"><label>Amount</label>
        <input type="number" id="amount" inputmode="decimal" step="0.01" min="0"
          value="${init.amount || ''}" placeholder="0.00"></div>
      <div class="field"><label>Next charge</label>
        <input type="date" id="due" value="${esc(init.nextDue)}"></div>
    </div>
    <div class="field"><label>Repeats</label>
      <div class="seg" data-cycles>${CYCLES.map(([v, l]) =>
        `<button type="button" data-cycle="${v}" aria-pressed="${init.cycle === v}">${l}</button>`).join('')}</div>
    </div>
    <div class="field ${init.cycle === 'days' ? '' : 'hide'}" id="everyWrap">
      <label>Every how many days</label>
      <input type="number" id="everyDays" inputmode="numeric" min="1" value="${init.everyDays || 30}">
    </div>
    <div class="field"><label>Category</label>
      <div class="seg cats" data-cats>${catButtons(init.categoryId)}</div></div>
    ${existing ? `
      <div class="toggle" style="margin-bottom:12px">
        <div class="body"><div class="t">Active</div>
          <div class="d">Pause it instead of deleting to keep the history.</div></div>
        <button class="switch" data-active aria-pressed="${init.active}"></button>
      </div>` : ''}
    ${bsToggle(init.bs)}
    <div class="sheet-actions">
      <button class="btn primary" id="save">Save</button>
      ${existing ? '<button class="btn ghost danger" id="del">Delete</button>' : ''}
    </div>
  `, {
    onMount(root) {
      const pick = wireCatPicker(root, init);
      let cycle = init.cycle;
      let active = init.active !== false;

      $('[data-cycles]', root).onclick = (e) => {
        const v = e.target.closest('[data-cycle]')?.dataset.cycle;
        if (!v) return;
        cycle = v;
        $$('[data-cycle]', root).forEach((b) =>
          b.setAttribute('aria-pressed', String(b.dataset.cycle === v)));
        $('#everyWrap', root).classList.toggle('hide', v !== 'days');
      };

      const activeBtn = $('[data-active]', root);
      if (activeBtn) activeBtn.onclick = () => {
        active = !active;
        activeBtn.setAttribute('aria-pressed', String(active));
      };

      $('#save', root).onclick = () => {
        const name = $('#name', root).value.trim();
        const amount = Number($('#amount', root).value) || 0;
        if (!name) { toast('Give it a name'); return; }
        if (amount <= 0) { toast('Enter an amount'); return; }
        saveSub({
          id: existing?.id, name, amount, cycle,
          everyDays: Number($('#everyDays', root).value) || 30,
          nextDue: $('#due', root).value || todayKey(),
          categoryId: pick.cat, bs: pick.bs, active,
        });
        closeSheet();
        toast(`${name} saved`);
      };

      $('#del', root)?.addEventListener('click', () => {
        removeSub(existing.id); closeSheet(); toast('Deleted');
      });
    },
  });
}

/* ------------------------------------------------------ quick adds ----- */

export function openQuickEditor() {
  const list = state.quickAdds.map((q) => `
    <button class="row" data-q="${esc(q.id)}">
      <span class="ico">${esc(q.emoji || '💸')}</span>
      <span class="body"><span class="title">${esc(q.label)}</span>
        <span class="meta">${esc(money(q.amount, cur()))}${q.bs ? ' · <span class="tag-bs">BS</span>' : ''}</span></span>
      <span class="amt" style="color:var(--faint)">edit</span>
    </button>`).join('');

  openSheet(`
    <h2>Quick add buttons</h2>
    <p style="color:var(--faint);font-size:13px;margin-bottom:12px">
      One tap logs these straight away. Make them match what you actually buy.</p>
    ${list || '<div class="empty">No buttons yet.</div>'}
    <button class="btn" id="new" style="margin-top:12px">+ New button</button>
    <button class="btn ghost" id="done" style="margin-top:10px">Done</button>
  `, {
    onMount(root) {
      root.onclick = (e) => {
        const id = e.target.closest('[data-q]')?.dataset.q;
        if (id) openQuickForm(state.quickAdds.find((q) => q.id === id));
      };
      $('#new', root).onclick = () => openQuickForm(null);
      $('#done', root).onclick = closeSheet;
    },
  });
}

function openQuickForm(existing) {
  const init = existing || { label: '', emoji: '💸', amount: 0, categoryId: state.categories[0].id, bs: false };
  openSheet(`
    <h2>${existing ? 'Edit button' : 'New button'}</h2>
    <div class="two">
      <div class="field"><label>Emoji</label>
        <input type="text" id="emoji" maxlength="4" value="${esc(init.emoji)}"></div>
      <div class="field"><label>Amount</label>
        <input type="number" id="amount" inputmode="decimal" step="0.01" min="0"
          value="${init.amount || ''}"></div>
    </div>
    <div class="field"><label>Label</label>
      <input type="text" id="label" placeholder="Coffee" value="${esc(init.label)}"></div>
    <div class="field"><label>Category</label>
      <div class="seg cats" data-cats>${catButtons(init.categoryId)}</div></div>
    ${bsToggle(init.bs)}
    <div class="sheet-actions">
      <button class="btn primary" id="save">Save</button>
      ${existing ? '<button class="btn ghost danger" id="del">Delete</button>' : ''}
    </div>
  `, {
    onMount(root) {
      const pick = wireCatPicker(root, init);
      $('#save', root).onclick = () => {
        const label = $('#label', root).value.trim();
        if (!label) { toast('Give it a label'); return; }
        saveQuickAdd({
          id: existing?.id, label,
          emoji: $('#emoji', root).value.trim() || '💸',
          amount: Number($('#amount', root).value) || 0,
          categoryId: pick.cat, bs: pick.bs,
        });
        openQuickEditor();
      };
      $('#del', root)?.addEventListener('click', () => {
        removeQuickAdd(existing.id); openQuickEditor();
      });
    },
  });
}

/* -------------------------------------------------------- settings ----- */

const CURRENCIES = ['EUR', 'USD', 'GBP', 'PLN', 'RON', 'CZK', 'HUF', 'SEK', 'CHF', 'TRY', 'INR', 'BRL'];

export function openSettings() {
  const s = state.settings;
  openSheet(`
    <h2>Setup</h2>

    <div class="field"><label>Savings goal for this month</label>
      <input type="number" id="goal" inputmode="decimal" step="1" min="0"
        value="${s.monthlyGoal || ''}" placeholder="0">
      <div class="hint">What you want left over at the end of the month. Your
        daily limit is built backwards from this.</div></div>

    <div class="two">
      <div class="field"><label>Typical paycheck</label>
        <input type="number" id="payAmount" inputmode="decimal" step="1" min="0"
          value="${s.payAmount || ''}"></div>
      <div class="field"><label>Paid every … days</label>
        <input type="number" id="payCycleDays" inputmode="numeric" min="1" max="60"
          value="${s.payCycleDays || 15}"></div>
    </div>
    <div class="field"><label>Last payday</label>
      <input type="date" id="lastPayDate" value="${esc(s.lastPayDate || todayKey())}">
      <div class="hint">Every 15 days drifts around the calendar — logging each
        paycheck re-times this automatically.</div></div>

    <div class="two">
      <div class="field"><label>Balance right now</label>
        <input type="number" id="startBalance" inputmode="decimal" step="0.01"
          value="${s.startBalance ?? ''}"></div>
      <div class="field"><label>As of</label>
        <input type="date" id="startBalanceDate" value="${esc(s.startBalanceDate || todayKey())}"></div>
    </div>
    <div class="hint" style="margin:-4px 0 12px;color:var(--faint);font-size:11.5px">
      Everything logged from that date on is added or subtracted from this.</div>

    <div class="field"><label>Currency</label>
      <select id="currency">${CURRENCIES.map((c) =>
        `<option value="${c}" ${c === s.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></div>

    <div class="toggle" style="margin-bottom:12px">
      <div class="body"><div class="t">Never outspend the cash</div>
        <div class="d">Caps the daily limit so the money lasts until the next paycheck.</div></div>
      <button class="switch" data-guard aria-pressed="${s.cashGuard !== false}"></button>
    </div>

    <button class="btn primary" id="save">Save</button>

    <div class="section-head" style="margin-top:22px"><h2>Your data</h2></div>
    <p style="color:var(--faint);font-size:12.5px;margin-bottom:10px">
      Everything lives on this phone only. Back it up now and then.</p>
    <div class="btn-row" style="margin-top:0">
      <button class="btn" id="export">Export backup</button>
      <button class="btn" id="import">Restore</button>
    </div>
    <button class="btn ghost danger" id="wipe" style="margin-top:10px">Erase everything</button>
    <input type="file" id="file" accept="application/json,.json" class="hide">
  `, {
    onMount(root) {
      let guard = s.cashGuard !== false;
      const gb = $('[data-guard]', root);
      gb.onclick = () => { guard = !guard; gb.setAttribute('aria-pressed', String(guard)); };

      $('#save', root).onclick = () => {
        setSettings({
          monthlyGoal: Number($('#goal', root).value) || 0,
          payAmount: Number($('#payAmount', root).value) || 0,
          payCycleDays: Math.max(1, Number($('#payCycleDays', root).value) || 15),
          lastPayDate: $('#lastPayDate', root).value || todayKey(),
          startBalance: Number($('#startBalance', root).value) || 0,
          startBalanceDate: $('#startBalanceDate', root).value || todayKey(),
          currency: $('#currency', root).value,
          cashGuard: guard,
          onboarded: true,
        });
        closeSheet();
        toast('Saved');
      };

      $('#export', root).onclick = () => downloadBackup();
      $('#import', root).onclick = () => $('#file', root).click();
      $('#file', root).onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          importJSON(await file.text());
          closeSheet();
          toast('Backup restored');
        } catch (err) {
          toast(`Could not read that file: ${err.message}`);
        }
      };
      $('#wipe', root).onclick = () => {
        if (confirm('Erase every expense, subscription and setting on this phone?')) {
          wipe(); closeSheet(); toast('Everything erased');
        }
      };
    },
  });
}

function downloadBackup() {
  const blob = new Blob([exportJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `coinkeep-backup-${todayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Backup saved to your downloads');
}

/* ------------------------------------------------------ onboarding ----- */

export function openOnboarding() {
  openSheet(`
    <h2>Let's set you up 👋</h2>
    <p style="color:var(--dim);font-size:13.5px;margin-bottom:16px">
      Four numbers and the app can tell you what you're allowed to spend today.</p>

    <div class="field"><label>1. Currency</label>
      <select id="currency">${CURRENCIES.map((c) =>
        `<option value="${c}" ${c === state.settings.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></div>

    <div class="field"><label>2. How much do you want to save this month?</label>
      <input type="number" id="goal" inputmode="decimal" step="10" min="0" placeholder="300"></div>

    <div class="two">
      <div class="field"><label>3. Typical paycheck</label>
        <input type="number" id="payAmount" inputmode="decimal" step="10" min="0" placeholder="800"></div>
      <div class="field"><label>Every … days</label>
        <input type="number" id="payCycleDays" inputmode="numeric" min="1" max="60" value="15"></div>
    </div>
    <div class="field"><label>When were you last paid?</label>
      <input type="date" id="lastPayDate" value="${todayKey()}"></div>

    <div class="field"><label>4. How much is in your account right now?</label>
      <input type="number" id="startBalance" inputmode="decimal" step="0.01" placeholder="0.00"></div>

    <button class="btn primary" id="go">Start tracking</button>
    <button class="btn ghost" id="skip" style="margin-top:10px">Skip for now</button>
  `, {
    onMount(root) {
      $('#go', root).onclick = () => {
        setSettings({
          currency: $('#currency', root).value,
          monthlyGoal: Number($('#goal', root).value) || 0,
          payAmount: Number($('#payAmount', root).value) || 0,
          payCycleDays: Math.max(1, Number($('#payCycleDays', root).value) || 15),
          lastPayDate: $('#lastPayDate', root).value || todayKey(),
          startBalance: Number($('#startBalance', root).value) || 0,
          startBalanceDate: todayKey(),
          onboarded: true,
        });
        closeSheet();
        toast('All set — start logging what you spend');
      };
      $('#skip', root).onclick = () => { setSettings({ onboarded: true }); closeSheet(); };
    },
  });
}
