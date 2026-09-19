// Shared building blocks for every screen: the icons, the ask strip, the
// hero, the one row anatomy, and the small helpers that decide what goes in
// a row's right-hand slot. A leaf module, so craft.js and views.js can both
// use it without importing each other.

import { esc } from './ui.js';

/* ------------------------------------------------------------- icons --- */

export const ICON = {
  crop: '\u{1F33E}', herb: '\u{1F33F}', seed: '\u{1F331}', livestock: '\u{1F404}',
  baby: '\u{1F423}', animal: '\u{1F404}', mount: '\u{1F40E}', product: '\u{1F95A}',
  potion: '\u{1F9EA}', food: '\u{1F35E}', meat: '\u{1F969}', material: '\u{1F9F1}',
  other: '\u{1F4E6}', city: '\u{1F3EF}', island: '\u{1F3DD}️', cart: '\u{1F6D2}',
  bag: '\u{1F392}', carry: '\u{1F40E}', board: '\u{1F31F}', spark: '✨',
  farm: '\u{1F33E}', herbgarden: '\u{1F33F}', pasture: '\u{1F404}', kennel: '\u{1F43A}',
  weapon: '⚔️', armor: '\u{1F6E1}️', gear: '\u{1F392}', refined: '\u{1F9F1}',
  land: '\u{1F5FA}️', cycle: '\u{1F504}', prices: '\u{1F4E1}', quality: '✨',
  mastery: '\u{1F4DA}', advanced: '\u{1F527}', data: '\u{1F4BE}', warn: '⚠️',
  make: '\u{1F528}', empty: '\u{1F3DA}️', next: '\u{1F501}', assume: '⚙️',
};

/** The icon for a game item category, never a bare box for something known. */
export const iconFor = (cat) => ICON[cat] || ICON.other;

/** The icon for a recipe category: potions, meals, or any of the meat_* cuts. */
export const craftIcon = (category = '') => (category.startsWith('meat_') ? ICON.meat
  : ICON[category] || ICON.potion);

/* --------------------------------------------------------- right slot --- */

/** A signed, coloured number for a row's right-hand slot, unit on its own line. */
export function amt(value, { tone = null, unit = '', sign = false } = {}) {
  if (value === null || value === undefined || value === '') return '';
  const cls = tone || (typeof value === 'number' ? (value > 0.5 ? 'good' : value < -0.5 ? 'bad' : 'flat') : '');
  const text = typeof value === 'number' ? fmtSigned(value, sign) : String(value);
  return `<span class="amt num ${cls}">${text}${unit ? `<small>${esc(unit)}</small>` : ''}</span>`;
}

function fmtSigned(n, sign) {
  const abs = Math.abs(n);
  const body = abs >= 1e6 ? `${(abs / 1e6).toFixed(abs >= 1e7 ? 1 : 2)}m`
    : abs >= 1e3 ? `${(abs / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}k`
      : String(Math.round(abs));
  return `${n < 0 ? '−' : sign && n > 0 ? '+' : ''}${body}`;
}

export const tag = (text, on = false, attrs = '') =>
  `<span class="tag ${on ? 'on' : ''}" ${attrs}>${esc(text)}</span>`;
export const tick = () => '<span class="tick">✓</span>';
export const go = () => '<span class="go">›</span>';

/* ------------------------------------------------------------- rows ---- */

/**
 * The one list anatomy: icon, title over meta, and one thing on the right.
 * `right` is already rendered (amt(), tag(), tick() or go()); nothing else
 * goes there. `act` becomes data-act; `attrs` is any other data-* string.
 */
export function rowHTML({
  act = '', attrs = '', icon = '', title = '', meta = '', right = '', cls = '',
  tagName = 'button',
}) {
  return `
    <${tagName} class="row ${cls}" ${act ? `data-act="${esc(act)}"` : ''} ${attrs}>
      ${icon ? `<span class="ico">${icon}</span>` : ''}
      <span class="body">
        <span class="title">${title}</span>
        ${meta ? `<span class="meta">${meta}</span>` : ''}
      </span>
      ${right}
    </${tagName}>`;
}

/** A one-line row: a nudge, a filter, a source line. */
export const slimRow = ({ act = '', attrs = '', icon = '', title = '', cls = '', right = go() }) =>
  rowHTML({ act, attrs, icon, title, cls: `slim ${cls}`, right });

/** The dashed "+ Add a plot" row at the end of a list. */
export const addRow = (label, act, attrs = '') =>
  `<button class="row add" data-act="${esc(act)}" ${attrs}>+ ${esc(label)}</button>`;

/** Neutral explanatory text. Not a warning: those are .warn-note. */
export const note = (html, cls = '') => `<div class="note ${cls}">${html}</div>`;

/* --------------------------------------------------------- ask strip --- */

/**
 * One question of the ask strip. `state` is 'set' (you chose: gold dot),
 * 'default' (the app's default is in force: hollow dot, dim value) or
 * 'unset' (nothing chosen and the value is an instruction: hollow dot, gold).
 * A line with an input or nested buttons in it is a label or a div, never a
 * button.
 */
export function askLine({ act = '', k, v, state = 'set', tagName = 'button', inner = '', meta = '' }) {
  const dot = `<span class="dot ${state === 'set' ? 'set' : ''}"></span>`;
  const body = inner || `<span class="v">${v}${meta ? `<span class="meta">${meta}</span>` : ''}</span>`;
  const right = tagName === 'button' ? '<span class="go">›</span>' : '';
  return `
    <${tagName} class="ask-line ${state}" ${act ? `data-act="${esc(act)}"` : ''}>
      ${dot}<span class="k">${esc(k)}</span>${body}${right}
    </${tagName}>`;
}

export const askStrip = (lines, seg = '', button = '') => `
  <section><div class="card ask">
    ${lines}${seg}${button}
  </div></section>`;

/* -------------------------------------------------------------- hero ---- */

/**
 * The one number a screen is about, with up to three small facts under it.
 * A bare section, not a card: it is the page's headline, not a box on it.
 */
export function heroHTML({
  label, amount, tone = '', sub = '', stats = [], meter = null, stale = false,
}) {
  return `
    <section class="hero ${stale ? 'stale' : ''}">
      <div class="label">${label}</div>
      <div class="amount ${tone} num">${amount}</div>
      ${sub ? `<div class="sub">${sub}</div>` : ''}
      ${stats.length ? `<div class="stats ${stats.length === 2 ? 'two' : 'three'}">
        ${stats.map((x) => `<div class="stat"><span class="v num ${x.cls || ''}">${x.v}</span>
          <span class="k">${esc(x.k)}</span></div>`).join('')}</div>` : ''}
      ${meter ? `<div class="meter"><i class="${meter.over ? 'over' : ''}"
        style="width:${Math.max(0, Math.min(100, meter.pct * 100))}%"></i></div>` : ''}
    </section>`;
}

/* -------------------------------------------------------- disclosure --- */

/** Which Details blocks are open, so a re-render does not slam them shut. */
export const openDetails = new Set();

export const moreHTML = (key, title, sub, inner) => `
  <details class="more" data-key="${esc(key)}" ${openDetails.has(key) ? 'open' : ''}>
    <summary>${esc(title)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</summary>
    ${inner}
  </details>`;
