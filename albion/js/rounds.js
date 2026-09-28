// Your rounds: what is actually growing, and what needs doing now.
//
// Everything else in this app answers "what is this worth". This answers
// "what do I do today", which needs the one thing none of the game files
// carry: the wall-clock moment YOU planted something.
//
// That is the whole trick, and it is worth being clear about how small the
// gap really is. Albion publishes every duration exactly - all fifteen crops
// take 22 hours, a chicken 44, a Master's Ox 188 with a nurture every 22 -
// and this app already holds all of them. The game does not send "your
// foxglove is ready at 19:40" to anyone; even a tool that reads the game's
// own network traffic derives readiness from these same published durations
// and calls its answer an estimate. One tap on "planted" supplies the only
// missing number, and everything after it is arithmetic.
//
// So the rule this file keeps is the app's rule applied to state rather than
// to numbers: it never claims a plot is in a condition nobody told it about.
//
//   - No crop recorded            -> it says nothing and offers to be told.
//   - Recorded but no time        -> "I am not going to guess when this was".
//   - Recorded, time known        -> an exact due time, and it says what it
//                                    was derived from.
//   - One whole growth overdue    -> it STOPS asserting and starts asking.
//     Past that point "ready" is a guess: you may have harvested it two days
//     ago and never said, and a task list that quietly rolls itself forward
//     would be inventing your afternoon.
//
// Nothing here ever marks a task done because time passed. An unharvested
// crop does not harvest itself, and a reminder that expires on its own is
// worse than no reminder.

/* Times are stored as EPOCH MINUTES, and every field that holds one says so
 * in its name - plantedMin, caredMin, checkedMin. The app already keeps price
 * dates that way and the halving of bytes is worth having, but a bare number
 * whose unit you have to remember is how unit bugs happen, so the unit is in
 * the name instead of in a comment. */
export const MIN = 60000;
export const nowMin = (at = Date.now()) => Math.floor(at / MIN);
export const minToMs = (m) => (m > 0 ? m * MIN : 0);

/* --------------------------------------------------------- the growable -- */

/**
 * The plant or animal a plot holds, whichever kind it is.
 *
 * Takes the tables rather than digging them out of a global, so every function
 * in here is pure and can be tested against the real game file. `ctx` is
 * { settings, plants, animals } - the same shape calc.js is handed.
 */
export function growableOf(ctx, itemId) {
  if (!itemId) return null;
  return (ctx.plants || []).find((p) => p.id === itemId)
    || (ctx.animals || []).find((a) => a.id === itemId)
    || null;
}

/** Is this thing an animal, which is the half premium speeds up? */
export const isAnimal = (g) => !!g && g.kind !== 'crop' && g.kind !== 'herb';

/**
 * How long one growth takes, in minutes, for this user.
 *
 * Crops are 22 hours whatever you do - premium doubles the YIELD of a crop and
 * not its speed. Animals are the other way round: premium's own store copy
 * says "Double farm animal growth rate", so a chicken goes from 44 hours to
 * 22. That doubling is published as words rather than as a table row, which is
 * why it is a setting the user can change rather than a constant in here, and
 * why anything derived from it says so.
 */
export function growMinutes(ctx, g) {
  if (!g) return 0;
  const s = ctx.settings;
  const mult = isAnimal(g) && s.premium ? (s.premiumGrowthMultiplier ?? 2) : 1;
  return Math.round(g.growSeconds / mult / 60);
}

/**
 * Whether a nurture is even possible, which is not the same as whether it is
 * worth it.
 *
 * The game refuses watering and nurturing without Premium, and calc.js already
 * gates every focus cost on exactly this pair. A task list that told a
 * non-premium player to water their carrots would be worse than useless: it
 * would be asking for something the game will not let them do.
 */
export const canNurture = (ctx) => !!(ctx.settings.watered && ctx.settings.premium);

/** The gap between nurtures, in minutes, and how many a growth allows. */
export function nurturePlan(ctx, g) {
  if (!g || !canNurture(ctx)) return { every: 0, allowed: 0 };
  const s = ctx.settings;
  const mult = isAnimal(g) && s.premium ? (s.premiumGrowthMultiplier ?? 2) : 1;
  return {
    every: Math.round((g.careSeconds || g.growSeconds) / mult / 60),
    allowed: Math.max(0, Number(g.maxCycles) || 0),
  };
}

/* ------------------------------------------------------------ one plot -- */

/**
 * What one plot is doing, right now.
 *
 * Six states and no seventh. The two that matter most are the ones that refuse
 * to answer: a plot with no planting time gets no due time at all, and a plot
 * a whole growth past due stops being called ready, because by then the app
 * genuinely does not know whether it is standing or was cleared yesterday.
 */
export function plotStatus(ctx, plot, at = Date.now()) {
  const now = nowMin(at);
  const s = ctx.settings;
  const g = growableOf(ctx, plot?.itemId);
  const base = { plotId: plot?.id, islandId: plot?.islandId, kind: plot?.kind, growable: g };

  if (!plot?.itemId) {
    return { ...base, state: 'empty', why: 'nothing recorded here yet' };
  }
  if (!g) {
    /* An id the game data no longer has - a patch removed it, or a hand-edited
     * backup invented it. Say so rather than treating it as bare ground. */
    return { ...base, state: 'unknown', why: `the game data has no ${plot.itemId}` };
  }
  /* The span is worked out even for a plot with no planting time, because it
   * is what the "the panel says N left" box needs to turn a countdown back into
   * a moment - and that box is most useful on exactly this plot. */
  const span = growMinutes(ctx, g);

  if (!(plot.plantedMin > 0)) {
    return {
      ...base,
      span,
      state: 'untimed',
      why: 'I am not going to guess when this went in — start the clock, or '
        + 'tell me what the panel says is left',
    };
  }

  const readyMin = plot.plantedMin + span;
  const overdue = now - readyMin;
  const assumed = [];
  if (isAnimal(g) && s.premium) {
    assumed.push('premium’s doubled animal growth is store copy rather than a '
      + 'table row, so this time halves on that reading');
  }

  const nurture = nurtureDue(ctx, plot, g, now, readyMin);

  /* One whole growth past ready is where the app stops asserting. Before that,
   * "ready and you have not said otherwise" is a fair reading of silence.
   * After it, silence could just as easily mean you harvested and replanted
   * without telling it, and there is no way to tell the two apart. */
  if (overdue >= span) {
    return {
      ...base, span, readyMin, overdue, nurture, assumed,
      state: 'stale',
      why: 'more than a full growth has passed with nothing recorded, so I no '
        + 'longer know what is in there',
    };
  }
  if (overdue >= 0) {
    return { ...base, span, readyMin, overdue, nurture, assumed, state: 'ready' };
  }
  return { ...base, span, readyMin, overdue, nurture, assumed, state: 'growing' };
}

/**
 * The next nurture, if the user can nurture at all and has not used them up.
 *
 * Nurtures are counted, not inferred. `caredMin` is a list of the moments you
 * said you did it, so "two of four done" is something you told the app rather
 * than something it worked out from the clock.
 */
function nurtureDue(ctx, plot, g, now, readyMin) {
  const { every, allowed } = nurturePlan(ctx, g);
  if (!every || !allowed) return null;
  const cared = (plot.caredMin || []).filter((m) => m >= plot.plantedMin);
  const done = cared.length;

  /* A growth is divided into periods, one nurture allowed in each, and what is
   * open NOW is the period the clock is in - not the next one you have not got
   * round to. That distinction is the whole of this function.
   *
   * Counting off recorded nurtures instead meant a single missed window locked
   * out every later one: a Master's Ox whose first feed you forgot would never
   * be offered the other three, because the app was still holding period one
   * open and the clock had left it behind.
   *
   * A missed period is simply missed. The app does not offer it back, and it
   * does not pretend it was used either - `done` stays what you actually told
   * it, so "1 of 4" means one of four done, not one of four possible. */
  const period = Math.min(allowed - 1, Math.floor((now - plot.plantedMin) / every));
  if (period < 0 || now >= readyMin) {
    return { done, allowed, period: null, opensMin: null, closesMin: null, ready: false };
  }
  const opensMin = plot.plantedMin + every * period;
  const closesMin = Math.min(readyMin, opensMin + every);
  // Used already if anything was recorded inside this period's own window.
  const usedThisPeriod = cared.some((m) => m >= opensMin && m < closesMin);
  return {
    done, allowed, period, opensMin, closesMin,
    ready: !usedThisPeriod && now >= opensMin && now < closesMin,
  };
}

/* ----------------------------------------------------------- the rounds -- */

const ORDER = { stale: 0, ready: 1, nurture: 2, untimed: 3, empty: 4, growing: 5, unknown: 6 };

/**
 * Everything across every island that wants a decision, worst first.
 *
 * "Worst" is deliberately not "most valuable". A stale plot outranks a ready
 * one because it is the only kind the app cannot reason about at all, and the
 * fix is two seconds of the user's attention rather than a harvest.
 */
export function rounds(ctx, islands, at = Date.now()) {
  const settings = ctx.settings;
  const now = nowMin(at);
  const rows = [];
  for (const island of islands || []) {
    for (const plot of island.plots || []) {
      const st = plotStatus(ctx, { ...plot, islandId: island.id }, at);
      const g = st.growable;
      const nurture = st.nurture;
      // A plot can want two different things at once - it is ready AND a
      // nurture is due - so each is its own row rather than a row with a
      // secondary flag nobody reads.
      if (nurture?.ready && st.state === 'growing') {
        rows.push({
          ...st,
          island: island.name,
          task: 'nurture',
          sort: ORDER.nurture,
          dueMin: nurture.opensMin,
          closesMin: nurture.closesMin,
          lateMin: nurture.closesMin - now,
          label: `${g.name} · ${settings.watered ? 'water' : 'nurture'} it`
            + ` (${nurture.done + 1} of ${nurture.allowed})`,
        });
      }
      rows.push({
        ...st,
        island: island.name,
        task: st.state === 'empty' ? 'plant'
          : st.state === 'ready' ? 'harvest'
            : st.state === 'stale' ? 'check'
              : st.state === 'untimed' ? 'time' : 'wait',
        sort: ORDER[st.state] ?? 9,
        dueMin: st.readyMin ?? null,
        lateMin: st.overdue ?? null,
        label: g ? g.name : '',
      });
    }
  }
  rows.sort((a, b) => a.sort - b.sort
    || (b.lateMin ?? -Infinity) - (a.lateMin ?? -Infinity)
    || (a.dueMin ?? Infinity) - (b.dueMin ?? Infinity));
  return rows;
}

/** The one-line summary the card is headed by. */
export function roundsSummary(rows) {
  const n = (t) => rows.filter((r) => r.task === t).length;
  return {
    total: rows.length,
    harvest: n('harvest'),
    nurture: n('nurture'),
    stale: n('check'),
    empty: n('plant'),
    untimed: n('time'),
    // Anything that wants a decision now, as against something still growing.
    due: rows.filter((r) => r.task !== 'wait').length,
    next: rows.filter((r) => r.task === 'wait' && r.dueMin > 0)
      .sort((a, b) => a.dueMin - b.dueMin)[0] || null,
  };
}

/* ------------------------------------------------------------- wording -- */

/** "in 4h", "9h ago", "now". Whole minutes, because that is what is known. */
export function whenWords(dueMin, at = Date.now()) {
  if (!(dueMin > 0)) return '';
  const mins = dueMin - nowMin(at);
  const abs = Math.abs(mins);
  const unit = abs < 1 ? 'now'
    : abs < 60 ? `${abs}m`
      : abs < 48 * 60 ? `${Math.round(abs / 60)}h`
        : `${Math.round(abs / 1440)}d`;
  if (unit === 'now') return 'now';
  return mins > 0 ? `in ${unit}` : `${unit} ago`;
}

/** The clock time a thing is due, for a plan you make the night before. */
export function clockWords(dueMin, at = Date.now()) {
  if (!(dueMin > 0)) return '';
  const d = new Date(minToMs(dueMin));
  const today = new Date(at);
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  const tomorrow = new Date(at + 86400000);
  if (d.toDateString() === tomorrow.toDateString()) return `${time} tomorrow`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}
