// Open world farming: what the world pays you for your time.
//
// The one screen that answers the question the rest of the app had scattered
// across four. Your kit lives on Me, the prices live on Market, the refining
// routes live on Craft and a ranking lived behind a button called Best - and
// none of them ever said "here is what an hour out there is worth to YOU".
//
// Open world means nodes and water anyone can walk up to and compete for.
// Islands, farm plots and pastures are the other kind of farming and they are
// on Plan: land you own regrows on a timer you set, and a node in the world
// does not.
//
// Three units, and which ones you get depends on what you have told the app,
// not on what it is willing to guess:
//
//   A stack    999 of the thing. Needs nothing but prices, so it works on the
//              first open. Exact.
//   A full load  Needs the kilos you can carry, which is one number on Me.
//              Exact once it is there: every weight involved is published.
//   An hour    Needs a run you timed, because travel, respawn, competition and
//              - for fishing - the cast itself are in no game file. Until then
//              this unit says so instead of quoting a ceiling as an hour.
//
// What it will not do is turn the swing floor into silver an hour. That figure
// is exact arithmetic and a wrong answer to the question: it assumes you never
// walk, never wait for a respawn and never find a node taken. The app has
// refused it everywhere else and refuses it here.

import { costOf, DATA, priceOf, state } from './store.js';
import { recipeOf } from './craft.js';
import { carryCapacity, gatherRun, kitOf, rawId, refinedOf } from './gather.js';
import { resourceExits } from './exits.js';
import {
  fishChoices, fishExits, fishKitOf, fishNameOf, fishRun, commonFishId,
} from './fish.js';
import {
  ICON, amt, heroHTML, moreHTML, note, rowHTML, slimRow, tag,
} from './html.js';
import { esc } from './ui.js';
import { hours, pct, short, toneOf } from './util.js';

/* ------------------------------------------------------------- state --- */

export let wildTier = 0;
export const setWildTier = (t) => { wildTier = Number(t) || 0; };

export let wildUnit = '';
export const setWildUnit = (u) => { wildUnit = u; };

/**
 * The tier to rank if you have not said.
 *
 * Your tool's own tier first, because a node above it is half again as long a
 * swing and two above it the game refuses outright - the tier the tool was made
 * for is the one you are equipped for.
 *
 * But not if you have never priced anything there. A screen that opens on seven
 * rows of "needs a price" has answered nothing, and the tier you have prices for
 * is the tier you have been shopping in. So it falls back to the best-priced
 * tier, which is a choice about which question to answer first and not a number
 * invented for you - the tier strip is right there and every tier is one tap.
 */
function defaultTier() {
  const mine = kitOf(state.settings).toolTier
    || state.settings.gather?.fish?.rodTier || 4;
  if (pricedAt(mine) > 0) return mine;
  const best = [8, 7, 6, 5, 4, 3, 2]
    .map((t) => ({ t, n: pricedAt(t) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || b.t - a.t)[0];
  return best ? best.t : mine;
}

/* How much of a tier you have actually priced. Counted off the price table
 * rather than by running the ranking seven times, which would cost five
 * craftPnL chains a tier before the screen had drawn anything. */
function pricedAt(tier) {
  let n = 0;
  for (const family of state.settings.gathering?.families || []) {
    const id = rawId(family, tier, 0);
    if (priceOf(id) > 0) n += 1;
    const refined = refinedOf(id);
    if (refined && priceOf(refined) > 0) n += 1;
  }
  return n;
}

const ctxNow = () => ({
  recipeOf,
  priceOf,
  costOf,
  sellPriceOf: priceOf,
  settings: state.settings,
  cityId: state.settings.craftCity,
});

/** Which units this user's own entries have earned. */
export function unitsAvailable() {
  const cap = carryCapacity(state.settings);
  return {
    stack: true,
    load: cap.total > 0,
    capacity: cap,
  };
}

const UNIT_LABEL = { stack: 'A stack', load: 'A full load', hour: 'An hour' };

/* -------------------------------------------------------- the ranking --- */

/**
 * Strip everything off the kit except the tool, so the run can be costed twice
 * and the difference named.
 *
 * This is the only honest answer to "did my destiny board and my set pay off".
 * It cannot be silver an hour: a measured rate already contains the board, and
 * a stack is a stack however fast you fill it. What the board and the set
 * actually buy is FEWER SWINGS, and that is exact - both halves of it come out
 * of published tables.
 */
function bareSettings(settings) {
  const kit = settings.gather || {};
  return {
    ...settings,
    /* Premium stays ON in both runs. It is a subscription, not something you
     * earned or bought for this - and the line this feeds names the board, the
     * set, the tool and the pie, so it has to measure those and nothing else. */
    nodeLevels: {},
    gather: {
      ...kit,
      gear: { head: 0, armor: 0, shoes: 0, backpack: 0 },
      food: '', potion: '', foodEnchant: 0, potionEnchant: 0,
      toolAvalon: false,
      specLevels: {},
      fish: { ...(kit.fish || {}), gear: { head: 0, armor: 0, shoes: 0, backpack: 0 }, rodAvalon: false },
    },
  };
}

/** What the kit is worth on one land resource, in swings and in minutes. */
export function kitPayoff(itemId) {
  const real = gatherRun(itemId, { qty: 999, settings: state.settings });
  if (!real || real.impossible) return null;
  const bare = gatherRun(itemId, { qty: 999, settings: bareSettings(state.settings) });
  if (!bare || bare.impossible) return null;
  if (!(bare.swingSeconds > 0) || !(real.swingSeconds > 0)) return null;
  return {
    itemId,
    realSeconds: real.swingSeconds,
    bareSeconds: bare.swingSeconds,
    realSwings: real.swings,
    bareSwings: bare.swings,
    times: bare.swingSeconds / real.swingSeconds,
  };
}

/**
 * Every resource at one tier and the best thing to do with each, land and
 * water in one list on one unit.
 *
 * Fishing is a row here rather than a screen of its own because the choice is
 * real: an hour is an hour, and whether it is better spent on a tree or on the
 * water is exactly the comparison this screen exists to make.
 */
export function wildRank(tier = wildTier || defaultTier()) {
  const ctx = ctxNow();
  const rows = [];

  for (const family of state.settings.gathering?.families || []) {
    const id = rawId(family, tier, 0);
    /* Ask whether it can be gathered at all before asking what to do with it.
     * A tool two tiers under the node, or a sort of node that does not exist at
     * this tier, is a row with a reason on it rather than a row missing. */
    const run = gatherRun(id, { qty: 999, settings: state.settings });
    if (!run) continue;
    if (run.impossible) {
      rows.push({ kind: 'land', family, id, tier, exits: [], best: null, blocked: run, missing: [] });
      continue;
    }
    const exits = resourceExits(id, ctx, { qty: 999 });
    if (!exits.length) continue;
    const ready = exits.filter((e) => !e.missing.length);
    rows.push({
      kind: 'land', family, id, tier, run, exits,
      best: ready[0] || null,
      blocked: null,
      missing: [...new Set(exits.flatMap((e) => e.missing))],
    });
  }

  const fishKit = fishKitOf(state.settings);
  for (const fish of fishAtTier(tier, fishKit)) {
    const run = fishRun(fish.id, { qty: 999, settings: state.settings });
    if (!run) continue;
    if (run.impossible) {
      rows.push({ kind: 'fish', id: fish.id, tier, fish, exits: [], best: null, blocked: run, missing: [] });
      continue;
    }
    const exits = fishExits(fish.id, ctx, { qty: 999 });
    const ready = exits.filter((e) => !e.missing.length);
    rows.push({
      kind: 'fish', id: fish.id, tier, fish, run, exits,
      best: ready[0] || null,
      blocked: null,
      missing: [...new Set(exits.flatMap((e) => e.missing))],
    });
  }
  return { tier, rows };
}

/**
 * Which fish are on the table at one tier, for where you actually are.
 *
 * Two or three rows, not nine. The common of your water, the ONE rare your
 * landscape carries, and at T8 the boss shark. Listing all seven freshwater
 * rares would be honest about the file and useless on the glass: at a given
 * tier they are identical in every published number - same value, same fame,
 * same weight - so seven rows would differ only by market price and by a
 * landscape you are not standing in. The zone picker is in the fishing kit.
 *
 * Rares exist only at T3, T5 and T7, so most tiers have one row plus the boss.
 */
function fishAtTier(tier, kit) {
  const all = fishChoices(state.settings, tier);
  const common = commonFishId(tier, kit.water);
  const rares = all.filter((f) => f.rarity === 'rare' && f.water === kit.water);
  const rare = kit.water === 'saltwater'
    ? rares[0]
    // By id first, never by zone alone: the two Avalonian rares share the word
    // `avalon`, so a zone is a label and the id is the thing.
    : (rares.find((f) => f.id === kit.zone)
      || rares.find((f) => f.zone === kit.zone)
      || rares[0]);
  const boss = all.filter((f) => f.rarity === 'boss' && f.water === kit.water);
  return all.filter((f) => f.id === common || f.id === rare?.id
    || boss.some((b) => b.id === f.id))
    .sort((a, b) => a.value - b.value);
}

/** The number a row is ranked and headlined by, in the chosen unit. */
function unitValue(row, unit, capacity) {
  const best = row.best;
  if (!best) return null;
  if (row.kind === 'fish') {
    if (unit === 'hour') return best.silverPerHour;
    if (unit === 'load') {
      return capacity > 0 && row.run.weight > 0
        ? best.profit * (capacity / row.run.weight) : null;
    }
    return best.profit;
  }
  if (unit === 'hour') return best.silverPerHour;
  if (unit === 'load') {
    const weight = row.run?.weight || 0;
    return capacity > 0 && weight > 0 ? best.profit * (capacity / weight) : null;
  }
  return best.profit;
}

/** The unit to open on: the best one this user's own entries have earned. */
function pickUnit(rows, avail) {
  if (wildUnit) return wildUnit;
  if (rows.some((r) => r.best?.silverPerHour != null)) return 'hour';
  return avail.load ? 'load' : 'stack';
}

/** Every id the screen needs a price for, for one scoped fetch. */
export function wildMissingIds(tier = wildTier || defaultTier()) {
  return [...new Set(wildRank(tier).rows.flatMap((r) => r.missing))];
}

/* ------------------------------------------------------------- the view -- */

const UNIT_SUFFIX = { stack: '/stack', load: '/load', hour: '/h' };

/* Every unit stays tappable, because tapping one you have not earned is how
 * you find out what it needs - the screen then says so in the hero and on every
 * row rather than in a disabled button nobody can interrogate. */
function unitStrip(unit, avail, timed) {
  const need = { stack: '', load: avail.load ? '' : ' \u00b7 needs your kilos',
    hour: timed ? '' : ' \u00b7 needs a timed run' };
  return `<div class="seg small" style="margin-bottom:10px">
    ${['stack', 'load', 'hour'].map((u) => `
      <button data-wild-unit="${u}" aria-pressed="${u === unit}">${
  UNIT_LABEL[u]}${need[u]}</button>`).join('')}
  </div>`;
}

function tierStrip(tier) {
  return `<div class="seg small" style="margin-bottom:10px">
    ${[2, 3, 4, 5, 6, 7, 8].map((t) => `
      <button data-wild-tier="${t}" aria-pressed="${t === tier}">T${t}</button>`).join('')}
  </div>`;
}

const nameOfRow = (row) => (row.kind === 'fish'
  ? fishNameOf(state.settings, row.id) || row.id
  : DATA.items?.[row.id]?.name || row.id);

function rowMeta(row, unit, capacity) {
  const b = row.best;
  const bits = [];
  if (row.kind === 'fish') {
    const run = row.run;
    bits.push(`${short(b.profit)} off 999`);
    if (unit !== 'load' && run.weight > 0) {
      bits.push(`${(run.weightEach).toFixed(2)} kg each${run.weightCut
        ? `, ${pct(run.weightCut, 0)} off in your pack` : ''}`);
    }
    if (unit === 'load' && capacity > 0) {
      bits.push(`${Math.floor(capacity / run.weightEach).toLocaleString()} fish a load`);
    }
    bits.push(`${short(run.famePer)} fame each`);
    if (run.journal) bits.push(`${run.journal.filled.toFixed(1)} books`);
    if (b.silverPerHour == null) bits.push('no cast time is published — time ten minutes');
    return bits.filter(Boolean).join(' · ');
  }
  bits.push(`${short(b.profit)} off 999`);
  if (unit === 'load' && capacity > 0 && row.run?.weight > 0) {
    bits.push(`${Math.round(capacity / (row.run.weight / 999)).toLocaleString()} a load`);
  }
  bits.push(b.hours ? `${hours(b.hours)} at your pace` : `${hours(b.swingSeconds / 3600)} swinging`);
  bits.push(b.focus > 0 ? `${short(b.focus)} focus` : 'no focus');
  /* The next route you could actually take today, which is not exits[1]: that
   * may be the winner itself, or a route whose price you have never entered.
   * Naming the same route twice read as a bug and was one. */
  const next = row.exits.find((e) => e !== b && !e.missing.length);
  if (next) bits.push(`next best ${next.label.toLowerCase()}`);
  const dearer = row.exits.find((e) => e.missing.length && e.profit > b.profit);
  if (dearer) bits.push(`${dearer.label.toLowerCase()} needs a price`);
  return bits.filter(Boolean).join(' · ');
}

function listHTML(rank, unit, avail) {
  const capacity = avail.capacity.total;
  const scored = rank.rows.map((r) => ({ ...r, value: unitValue(r, unit, capacity) }));
  const ready = scored.filter((r) => r.value != null);
  const top = Math.max(...ready.map((r) => Math.abs(r.value)), 0.01);
  scored.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));

  const one = (r) => {
    const icon = r.kind === 'fish' ? '\u{1F3A3}' : ICON.raw;
    if (!r.best) {
      return rowHTML({
        act: r.kind === 'fish' ? 'fish-setup' : 'gather-setup',
        icon, cls: 'warn',
        title: esc(nameOfRow(r)),
        meta: r.blocked ? esc(r.blocked.why)
          : `needs a price for ${r.missing.slice(0, 2).map((id) => esc(
            fishNameOf(state.settings, id) || DATA.items?.[id]?.name || id)).join(', ')}${
            r.missing.length > 2 ? ` and ${r.missing.length - 2} more` : ''}`,
        right: amt('—', { tone: 'flat' }),
      });
    }
    if (r.value == null) {
      // The row is real and priced; this UNIT is the thing that is missing.
      return rowHTML({
        act: unit === 'hour' ? (r.kind === 'fish' ? 'fish-time' : 'gather-setup') : 'me',
        icon, cls: 'warn',
        title: `${esc(nameOfRow(r))} → ${esc(r.best.label.toLowerCase())}`,
        meta: unit === 'hour'
          ? 'time ten minutes of this and the hour becomes yours'
          : 'say what you can carry, on Me, and this becomes silver a load',
        right: amt('—', { tone: 'flat' }),
      });
    }
    const w = (Math.abs(r.value) / top) * 100;
    return `
      <button class="row rank wrap" data-${r.kind === 'fish' ? 'fish' : 'gather'}-row="${esc(r.id)}">
        <span class="ico">${icon}</span>
        <span class="body">
          <span class="title">${esc(nameOfRow(r))} → ${esc(r.best.label.toLowerCase())}</span>
          <span class="meta">${esc(rowMeta(r, unit, capacity))}</span>
          <span class="bar"><i class="${toneOf(r.value)}" style="width:${w.toFixed(1)}%"></i></span>
        </span>
        ${amt(r.value, { unit: UNIT_SUFFIX[unit] })}
      </button>`;
  };
  return scored.map(one).join('');
}

function heroFor(rank, unit, avail) {
  const capacity = avail.capacity.total;
  const scored = rank.rows
    .map((r) => ({ r, value: unitValue(r, unit, capacity) }))
    .filter((x) => x.value != null)
    .sort((a, b) => b.value - a.value);
  const winner = scored[0];
  const kit = kitOf(state.settings);
  const fishKit = fishKitOf(state.settings);

  if (!kit.toolTier && !fishKit.rodTier) {
    return heroHTML({
      label: 'Open world farming',
      amount: '—',
      tone: 'flat',
      sub: 'Say which tool you swing, or which rod you hold, and this whole '
        + 'screen comes alive.',
    });
  }
  if (!winner) {
    return heroHTML({
      label: `T${rank.tier}, ${UNIT_LABEL[unit].toLowerCase()}`,
      amount: '—',
      tone: 'flat',
      sub: unit === 'hour'
        ? 'Nothing here is timed yet. Ten minutes with a stopwatch is the only '
          + 'thing that turns a pile into an hour — travel, respawn and the cast '
          + 'itself are in no game file.'
        : 'Fetch some prices and this fills in.',
    });
  }

  const { r, value } = winner;
  const stats = [];
  if (r.kind === 'land') {
    const pay = kitPayoff(r.id);
    stats.push({ v: hours((r.best.hours ?? r.best.swingSeconds / 3600)),
      k: r.best.hours ? 'at your pace' : 'swinging' });
    if (pay) {
      stats.push({ v: `${pay.times.toFixed(1)}×`, k: 'fewer swings, your kit', cls: 'good' });
    }
    if (r.run?.weight) stats.push({ v: `${Math.round(r.run.weight)} kg`, k: 'a 999 pile' });
  } else {
    stats.push({ v: short(r.run.fame), k: 'fishing fame' });
    if (r.run.kitShare > 0) {
      stats.push({ v: pct(r.run.kitShare, 0), k: 'of it is your kit', cls: 'good' });
    }
    stats.push({ v: `${Math.round(r.run.weight)} kg`, k: 'a 999 pile' });
  }

  return heroHTML({
    label: unit === 'hour' ? 'At your timed pace, an hour'
      : unit === 'load' ? `A full load, ${Math.round(avail.capacity.total).toLocaleString()} kg`
        : 'A stack of 999, best route',
    amount: short(value),
    tone: toneOf(value),
    sub: `${esc(nameOfRow(r))} → ${esc(r.best.label.toLowerCase())}`,
    stats: stats.slice(0, 3),
  });
}

/** The Open world farming screen. */
export function wild() {
  const avail = unitsAvailable();
  const rank = wildRank();
  const unit = pickUnit(rank.rows, avail);
  const kit = kitOf(state.settings);
  const fishKit = fishKitOf(state.settings);
  const missing = wildMissingIds(rank.tier);

  return {
    title: 'Open world farming',
    action: missing.length ? { label: '↓ Prices', act: 'wild-prices' } : null,
    html: `
      ${heroFor(rank, unit, avail)}
      ${unitStrip(unit, avail, rank.rows.some((r) => r.best?.silverPerHour != null))}
      ${payoffLine(rank)}
      ${note(`Out here: nodes you swing at and water you cast into, that anyone
        can walk up to and take first. Your island's plots and pastures are the
        other kind of farming — land you own, regrowing on a timer you set —
        and they live on <b>Plan</b>.`, 'centered')}
      <section class="card">
        ${slimRow({ act: 'gather-setup', icon: ICON.raw, title: esc(kitWords(kit)) })}
        ${slimRow({ act: 'fish-setup', icon: '\u{1F3A3}', title: esc(fishWords(fishKit)) })}
        ${slimRow({ act: 'gather-board', icon: ICON.board, title: esc(boardWords()) })}
        ${avail.capacity.total > 0 ? '' : slimRow({
    act: 'me', icon: ICON.carry, cls: 'suggest',
    title: 'Say what you can carry and every row gets a silver-a-load figure',
  })}
      </section>
      ${tierStrip(rank.tier)}
      ${missing.length ? `<button class="btn primary fetch" data-act="wild-prices">
        ↓ Fetch the ${missing.length} prices these rows need</button>` : ''}
      ${listHTML(rank, unit, avail)}
      ${slimRow({ act: 'plan', icon: ICON.island,
    title: "Your island's plots and pastures" })}
      ${note(unitNote(unit), 'centered')}`,
  };
}

/**
 * What the destiny board and the kit actually bought you, in the two units
 * where the answer is not zero.
 *
 * This line exists because the obvious ones are all insensitive to it. A stack
 * is a stack. A load is a load. And an hour comes from a count you timed, which
 * already had the board in it - level the board to 100 and the hours, the kilos
 * and the fame of a 999 pile do not move by one digit.
 *
 * What DOES move is how long you stand there swinging, and on the water, how
 * much comes back per catch. Both are published arithmetic: the run is costed
 * twice, once with your kit and once with the same tool and nothing else.
 */
function payoffLine(rank) {
  const land = rank.rows.filter((r) => r.kind === 'land' && r.best)
    .sort((a, b) => b.best.profit - a.best.profit)[0];
  const fish = rank.rows.find((r) => r.kind === 'fish' && r.run && !r.run.impossible);
  const bits = [];
  if (land) {
    const pay = kitPayoff(land.id);
    if (pay && pay.times > 1.01) {
      const [was, now] = sameUnit(pay.bareSeconds, pay.realSeconds);
      bits.push(`take a 999 pile of ${esc(nameOfRow(land))} from
        <b>${was}</b> of swinging down to <b>${now}</b> —
        ${pay.times.toFixed(1)}× fewer swings`);
    }
  }
  if (fish && fish.run.kitShare > 0.01) {
    bits.push(`are <b>${pct(fish.run.kitShare, 0)}</b> of everything you land on the water`);
  }
  if (!bits.length) return '';
  return note(`Your board, your set and your pie ${bits.join(', and ')}.
    That is what they are worth — and it is the only place they show, because a
    stack is a stack however fast you fill it, and an hour you timed already had
    them in it.`, 'centered');
}

/* Two durations that are about to sit in one sentence, so they are formatted
 * together: "from 1.8h down to 31 min" reads as two different measurements of
 * two different things, which is the opposite of the point. */
function sameUnit(a, b) {
  const big = Math.max(a, b);
  if (big < 5400) return [a, b].map((x) => `${Math.round(x / 60)} min`);
  return [a, b].map((x) => hours(x / 3600));
}

function unitNote(unit) {
  if (unit === 'hour') return `An hour is your own timed pace — the only unit that
    can be, because travel, respawn, somebody else on the node and, for fishing,
    the cast itself are in no game file. Every other figure on this screen is
    published arithmetic over your own prices. Tap a row for every way out of it.`;
  if (unit === 'load') return `A full load is exact: every weight here is published,
    your pack's cut is published, and the kilos are yours. It says nothing about how
    many loads fit in an hour — that is the part only a stopwatch settles. Note the
    five land resources at one tier all weigh exactly the same, so a load ranks them
    in the same order a stack does; where the unit changes the answer is land against
    fishing. Tap a row for every way out of it.`;
  return `A stack is 999, costed every way out and best first, over your own prices.
    It needs no measurement at all. What it does not say is how long 999 takes:
    for that, carry weight turns it into a load and a timed run turns it into an
    hour. Tap a row to see every route side by side.`;
}

/* ------------------------------------------------------ the kit in words -- */

export function kitWords(kit = kitOf(state.settings)) {
  if (!kit.toolTier) return 'No gathering tool set — tap to say what you swing';
  const bits = [`T${kit.toolTier}${kit.toolAvalon ? ' Avalonian' : ''} tool`];
  const set = ['head', 'armor', 'shoes'].map((s) => kit.gear[s]).filter(Boolean);
  bits.push(set.length === 3 && new Set(set).size === 1 ? `T${set[0]} set`
    : set.length ? `${set.length} of 3 worn` : 'no gatherer set');
  if (kit.gear.backpack) bits.push(`T${kit.gear.backpack} pack`);
  if (kit.food) bits.push(DATA.gathering.food[kit.food]?.name || kit.food);
  const timed = Object.keys(kit.measured || {}).length;
  bits.push(timed ? `${timed} timed` : 'nothing timed');
  return bits.join(' · ');
}

export function fishWords(kit = fishKitOf(state.settings)) {
  if (!kit.rodTier) return 'No fishing rod set — tap to say what you hold';
  const bits = [`T${kit.rodTier}${kit.rodAvalon ? ' Avalonian' : ''} rod`];
  const set = ['head', 'armor', 'shoes'].map((s) => kit.gear[s]).filter(Boolean);
  bits.push(set.length === 3 && new Set(set).size === 1 ? `T${set[0]} fisherman's set`
    : set.length ? `${set.length} of 3 worn` : "no fisherman's set");
  if (kit.gear.backpack) bits.push(`T${kit.gear.backpack} pack`);
  bits.push(kit.bait
    ? fishNameOf(state.settings, kit.bait) || kit.bait : 'no bait');
  bits.push(kit.water);
  const timed = Object.keys(kit.measured || {}).length;
  bits.push(timed ? `${timed} timed` : 'nothing timed');
  return bits.join(' · ');
}

function boardWords() {
  const levels = state.settings.gather?.specLevels || state.nodeLevels || {};
  const nodes = [
    ...(DATA.gathering?.board || []),
    ...(DATA.gathering?.fishing?.board || []),
  ];
  const set = nodes.filter((n) => Number(levels[n.id]) > 0).length;
  return `Gathering and fishing on the destiny board — ${set} of ${nodes.length} set`;
}
