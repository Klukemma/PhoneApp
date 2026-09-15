// Small shared helpers: dates as local "YYYY-MM-DD" strings, money as numbers.

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------------------------------------------------------- dates ------- */

export function toKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const todayKey = () => toKey(new Date());

export function addDays(key, n) {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
}

export function addMonths(key, n) {
  const d = fromKey(key);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  // Clamp to the last day of the target month (Jan 31 + 1 month -> Feb 28).
  d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
  return toKey(d);
}

export function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** Whole days from a -> b. Negative if b is before a. */
export function daysBetween(aKey, bKey) {
  const a = fromKey(aKey);
  const b = fromKey(bKey);
  return Math.round((b - a) / 86400000);
}

export const monthStart = (key) => key.slice(0, 7) + '-01';

export function monthEnd(key) {
  const [y, m] = key.split('-').map(Number);
  return `${key.slice(0, 7)}-${String(daysInMonth(y, m - 1)).padStart(2, '0')}`;
}

export const sameMonth = (a, b) => a.slice(0, 7) === b.slice(0, 7);

const DAY_FMT = { weekday: 'short', day: 'numeric', month: 'short' };

export function prettyDate(key) {
  const t = todayKey();
  if (key === t) return 'Today';
  if (key === addDays(t, -1)) return 'Yesterday';
  if (key === addDays(t, 1)) return 'Tomorrow';
  return fromKey(key).toLocaleDateString(undefined, DAY_FMT);
}

export function monthLabel(key) {
  return fromKey(monthStart(key)).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

/* ---------------------------------------------------------- money ------- */

/** Round to cents, killing float dust like 0.1 + 0.2. */
export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function money(amount, currency = 'EUR', opts = {}) {
  const n = round2(amount || 0);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: opts.whole && Number.isInteger(n) ? 0 : 2,
      maximumFractionDigits: opts.whole && Number.isInteger(n) ? 0 : 2,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

export const sum = (arr, get = (x) => x) =>
  round2(arr.reduce((t, x) => t + (Number(get(x)) || 0), 0));

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
