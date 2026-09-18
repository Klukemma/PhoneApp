// Formatting helpers. Albion numbers get large, so most of this is about
// keeping them readable on a phone.

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** 1234567 -> "1.23m", 45678 -> "45.7k", 523 -> "523". */
export function short(n) {
  const v = Number(n) || 0;
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (a >= 1e9) return `${sign}${trim(a / 1e9)}b`;
  if (a >= 1e6) return `${sign}${trim(a / 1e6)}m`;
  if (a >= 1e4) return `${sign}${trim(a / 1e3)}k`;
  if (a >= 1) return `${sign}${Math.round(a).toLocaleString()}`;
  if (a === 0) return '0';
  return `${sign}${a.toFixed(2)}`;
}

const trim = (n) => {
  const dp = n >= 100 ? 0 : n >= 10 ? 1 : 2;
  return n.toFixed(dp).replace(/\.0+$/, '');
};

/** Full silver with separators, for places where precision matters. */
export function silver(n) {
  const v = Math.round(Number(n) || 0);
  return v < 0 ? `−${Math.abs(v).toLocaleString()}` : v.toLocaleString();
}

export const pct = (frac, dp = 1) => `${((Number(frac) || 0) * 100).toFixed(dp)}%`;

export function hours(h) {
  const v = Number(h) || 0;
  if (v < 1) return `${Math.round(v * 60)}m`;
  if (v % 1 === 0) return `${v}h`;
  return `${v.toFixed(1)}h`;
}

/** Tier label, e.g. 5 -> "T5". */
export const tierLabel = (t) => `T${t}`;

/** Colour a number by sign — green for profit, red for loss. */
export const toneOf = (n) => (n > 0 ? 'good' : n < 0 ? 'bad' : 'flat');

export const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));

/** "3h ago" — how stale a market quote is, at a glance. */
export function ago(ms) {
  if (!Number.isFinite(ms)) return 'no date';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** 1, 2 or 3 for an enchanted item — `T6_POTION_HEAL@2` — and 0 for a plain one. */
export const enchantOf = (id) => {
  const m = /@(\d)$/.exec(id || '');
  return m ? Number(m[1]) : 0;
};

/** How the game writes a tier: T6 plain, T6.1 once enchanted. */
export const tierText = (tier, enchant = 0) =>
  (enchant > 0 ? `T${tier}.${enchant}` : `T${tier}`);
