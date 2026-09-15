// Sheets, toasts, and the amount keypad.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function buzz(ms = 12) {
  try { navigator.vibrate?.(ms); } catch { /* not supported, no problem */ }
}

/* ------------------------------------------------------------ sheet ---- */

let onClose = null;

export function openSheet(html, { onMount, onDismiss } = {}) {
  const sheet = $('#sheet');
  const scrim = $('#scrim');
  // The grabber doubles as a close target — with the keypad open the sheet is
  // tall enough that the scrim above it is a thin strip to aim at.
  sheet.innerHTML =
    `<button class="grabber" aria-label="Close" data-close-sheet></button>${html}`;
  scrim.classList.add('open');
  // Next frame, so the transform transition actually runs.
  requestAnimationFrame(() => sheet.classList.add('open'));
  onClose = onDismiss || null;
  onMount?.(sheet);
  return sheet;
}

export function closeSheet() {
  const sheet = $('#sheet');
  if (!sheet.classList.contains('open')) return;
  sheet.classList.remove('open');
  $('#scrim').classList.remove('open');
  const cb = onClose;
  onClose = null;
  setTimeout(() => { if (!sheet.classList.contains('open')) sheet.innerHTML = ''; }, 280);
  cb?.();
}

export const sheetIsOpen = () => $('#sheet').classList.contains('open');

/* ------------------------------------------------------------ toast ---- */

let toastTimer = null;

export function toast(msg, action) {
  const el = $('#toast');
  $('#toastMsg').textContent = msg;
  const btn = $('#toastAction');
  if (action) {
    btn.textContent = action.label;
    btn.classList.remove('hide');
    btn.onclick = () => { hideToast(); action.run(); };
  } else {
    btn.classList.add('hide');
    btn.onclick = null;
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 5200 : 2400);
}

function hideToast() {
  clearTimeout(toastTimer);
  $('#toast').classList.remove('show');
}

/* ----------------------------------------------------------- keypad ---- */

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'];

export const keypadHTML = () =>
  `<div class="keypad">${KEYS.map((k) =>
    `<button type="button" data-key="${k}">${k}</button>`).join('')}</div>`;

/**
 * Wire a keypad to a display element. Digits are typed left-to-right the way
 * a calculator behaves, so "1 2 . 5" reads as 12.50.
 */
export function wireKeypad(root, display, { currency, onChange } = {}) {
  let raw = '';

  const value = () => Number(raw || 0);

  const paint = () => {
    const n = value();
    display.classList.toggle('zero', !raw);
    const shown = raw === '' ? '0'
      : raw.endsWith('.') ? raw
        : raw.includes('.') ? Number(raw).toFixed(raw.split('.')[1].length)
          : String(Number(raw));
    display.textContent = `${symbolFor(currency)}${shown}`;
    onChange?.(n);
  };

  root.addEventListener('click', (e) => {
    const key = e.target.closest('[data-key]')?.dataset.key;
    if (!key) return;
    buzz(8);
    if (key === '⌫') raw = raw.slice(0, -1);
    else if (key === '.') { if (!raw.includes('.')) raw = (raw || '0') + '.'; }
    else if (raw.includes('.') && raw.split('.')[1].length >= 2) { /* cents full */ }
    else if (raw === '0') raw = key;
    else if (raw.replace('.', '').length < 9) raw += key;
    paint();
  });

  paint();
  return { value, set: (n) => { raw = n ? String(n) : ''; paint(); } };
}

const SYMBOLS = { EUR: '€', USD: '$', GBP: '£', JPY: '¥', PLN: 'zł ', RON: 'lei ' };

export function symbolFor(code = 'EUR') {
  if (SYMBOLS[code]) return SYMBOLS[code];
  try {
    const parts = new Intl.NumberFormat(undefined, {
      style: 'currency', currency: code,
    }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value ?? `${code} `;
  } catch {
    return `${code} `;
  }
}
