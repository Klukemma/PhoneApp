// The rounds card, and the sheet behind it.
//
// This is the whole "what do I do today" surface. It sits at the top of Plan
// because Plan already answers "what should I be doing" in the abstract, and
// this is the same question about the actual afternoon.
//
// It renders nothing at all until you have told it about an island. An empty
// card on a screen you use for something else is just noise.

import { DATA, state } from './store.js';
import {
  clockWords, growMinutes, growableOf, plotStatus, rounds, roundsSummary, whenWords,
} from './rounds.js';
import { ICON, amt, note, rowHTML, slimRow } from './html.js';
import { esc } from './ui.js';

/** The shape the engine wants, built from whatever the app has loaded. */
export const roundsCtx = () => ({
  settings: state.settings,
  plants: DATA?.plants || [],
  animals: DATA?.animals || [],
});

const KIND_LABEL = {
  farm: 'Farm', herbgarden: 'Herb Garden', pasture: 'Pasture', kennel: 'Kennel',
  plant: 'Farm', animal: 'Pasture',
};
const KIND_ICON = {
  farm: '\u{1F33E}', herbgarden: '\u{1F33F}', pasture: '\u{1F404}', kennel: '\u{1F43A}',
  plant: '\u{1F33E}', animal: '\u{1F404}',
};

export const plotName = (plot, i) =>
  plot.label || `${KIND_LABEL[plot.kind] || 'Plot'} ${i + 1}`;

/* ------------------------------------------------------------- the card -- */

/** One line per thing that wants a decision, worst first. */
function taskRow(r, at) {
  const where = `${esc(r.island)} · ${esc(r.label || 'nothing recorded')}`;
  const attrs = `data-round="${esc(r.islandId)}:${esc(r.plotId)}"`;

  if (r.task === 'check') {
    return rowHTML({
      attrs, icon: '❓', cls: 'warn wrap',
      title: where,
      meta: `ready ${esc(whenWords(r.dueMin, at))} and nothing recorded since — `
        + 'tap to say what is actually in there',
      right: amt('?', { tone: 'flat' }),
    });
  }
  if (r.task === 'time') {
    return rowHTML({
      attrs, icon: '⏱️', cls: 'warn wrap',
      title: where,
      meta: 'I do not know when this went in — tap to start the clock, or '
        + 'type what the panel says is left',
      right: amt('—', { tone: 'flat' }),
    });
  }
  if (r.task === 'plant') {
    return rowHTML({
      attrs, icon: KIND_ICON[r.kind] || ICON.seed, cls: 'wrap',
      title: `${esc(r.island)} · empty`,
      meta: 'nothing recorded here — tap to say what you put in',
      right: '',
    });
  }
  if (r.task === 'nurture') {
    return rowHTML({
      attrs, icon: '\u{1F4A7}', cls: 'wrap',
      title: where,
      // A window, not a deadline - the files say how many waterings a growth
      // allows and how long each period is, and never when within a period the
      // game will let you do it. So this says how long is left to do it in.
      meta: `while it grows \u00b7 ${esc(whenWords(r.closesMin, at)).replace(/^in /, '')} left to do it`,
      right: amt('water', { tone: 'good' }),
    });
  }
  // harvest
  return rowHTML({
    attrs, icon: KIND_ICON[r.kind] || ICON.crop, cls: 'wrap',
    title: where,
    meta: `ready ${esc(whenWords(r.dueMin, at))}${r.assumed?.length
      ? ' · see the note below' : ''}`,
    right: amt('ready', { tone: 'good' }),
  });
}

/**
 * The card. Nothing when you have no islands; a short list when you do.
 *
 * It deliberately does not show everything that is growing - only what wants a
 * decision, plus one line saying when the next thing is due. A list of eight
 * plots that are all fine is a list nobody reads.
 */
export function roundsCard(at = Date.now()) {
  if (!state.islands?.length) return '';
  const rows = rounds(roundsCtx(), state.islands, at);
  const sum = roundsSummary(rows);
  const due = rows.filter((r) => r.task !== 'wait');
  const assumed = [...new Set(due.flatMap((r) => r.assumed || []))];

  const head = sum.due
    ? [sum.harvest ? `${sum.harvest} ready` : '',
      sum.nurture ? `${sum.nurture} to water` : '',
      sum.stale ? `${sum.stale} to check` : '',
      sum.untimed ? `${sum.untimed} untimed` : '',
      sum.empty ? `${sum.empty} empty` : ''].filter(Boolean).join(' · ')
    : 'nothing due';

  return `
    <section>
      <div class="section-head">
        <h2>Your rounds</h2>
        <span class="right ${sum.due ? 'good' : 'flat'}">${esc(head)}</span>
      </div>
      ${due.length ? due.slice(0, 8).map((r) => taskRow(r, at)).join('')
    : slimRow({ act: 'islands', icon: '\u{1F3DD}️',
      title: sum.next
        ? `Nothing to do — next is ${esc(sum.next.label)} ${esc(whenWords(sum.next.dueMin, at))}`
        : 'Nothing to do' })}
      ${due.length > 8 ? slimRow({ act: 'islands', icon: '\u{1F3DD}️',
    title: `and ${due.length - 8} more` }) : ''}
      ${sum.due && sum.next ? note(`Next after these: ${esc(sum.next.label)} at
        ${esc(clockWords(sum.next.dueMin, at))}.`, 'centered') : ''}
      ${assumed.length ? note(`Yours rather than the game's: ${esc(assumed.join('; '))}.`) : ''}
    </section>`;
}

/* --------------------------------------------------------- the one line -- */

/**
 * What an island is doing, in a phrase, for the row on Me.
 */
export function islandWords(island, at = Date.now()) {
  const ctx = roundsCtx();
  const plots = island.plots || [];
  if (!plots.length) return 'No plots yet — tap to add them';
  const rows = rounds(ctx, [island], at);
  const sum = roundsSummary(rows);
  const bits = [`${plots.length} plot${plots.length === 1 ? '' : 's'}`];
  if (sum.harvest) bits.push(`${sum.harvest} ready`);
  if (sum.stale) bits.push(`${sum.stale} to check`);
  if (!sum.due && sum.next) bits.push(`next ${whenWords(sum.next.dueMin, at)}`);
  if (!sum.due && !sum.next) bits.push('nothing recorded');
  return bits.join(' · ');
}

/** What one plot holds, for a row inside the island sheet. */
export function plotWords(plot, at = Date.now()) {
  const ctx = roundsCtx();
  const st = plotStatus(ctx, plot, at);
  const g = st.growable;
  switch (st.state) {
    case 'empty': return 'nothing recorded';
    case 'unknown': return st.why;
    case 'untimed': return `${g.name} · no time recorded`;
    case 'stale': return `${g.name} · ready ${whenWords(st.readyMin, at)}, nothing since`;
    case 'ready': return `${g.name} · ready ${whenWords(st.readyMin, at)}`;
    default: return `${g.name} · ready ${whenWords(st.readyMin, at)} (${clockWords(st.readyMin, at)})`;
  }
}

/** Everything that can go in a plot of this kind, for the picker. */
export function choicesFor(kind) {
  const want = KIND_LABEL[kind] ? kind : 'farm';
  const all = [...(DATA?.plants || []), ...(DATA?.animals || [])];
  return all.filter((g) => g.plot === want).sort((a, b) => a.tier - b.tier
    || a.name.localeCompare(b.name));
}

export { KIND_LABEL, KIND_ICON, growableOf, growMinutes };
