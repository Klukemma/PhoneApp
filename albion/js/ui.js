// Sheets, toasts and small DOM helpers.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function buzz(ms = 10) {
  try { navigator.vibrate?.(ms); } catch { /* unsupported, fine */ }
}

let onClose = null;

export function openSheet(html, { onMount, onDismiss } = {}) {
  const sheet = $('#sheet');
  // The grabber doubles as a close target: a tall sheet leaves only a thin
  // strip of scrim to aim at.
  sheet.innerHTML =
    `<button class="grabber" aria-label="Close" data-close-sheet></button>${html}`;
  $('#scrim').classList.add('open');
  requestAnimationFrame(() => sheet.classList.add('open'));
  onClose = onDismiss || null;
  // A sheet's own click handler must not outlive it: the next sheet may use
  // the same data-* attribute for something else entirely.
  sheet.onclick = null;
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

let toastTimer = null;

export function toast(msg, action) {
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
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 5000 : 2400);
}

function hideToast() {
  clearTimeout(toastTimer);
  $('#toast').classList.remove('show');
}
