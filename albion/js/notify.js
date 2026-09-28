// Reminders that arrive when the app is shut.
//
// This is the one thing a web page cannot do, and the only reason the app is
// also packaged as an APK. Chrome abandoned the API that would have let a page
// schedule its own alarm, Safari never had one, and real web push needs a
// server to send it. A native alarm needs none of that: the operating system
// holds the time and wakes the app, with nothing leaving the device.
//
// So this module has two jobs and one rule. The jobs are to schedule what is
// knowable and to cancel what is not. The rule is the app's own: a reminder is
// an assertion about the world, so nothing is scheduled off a moment the user
// did not give. A plot with no planting time gets no alarm rather than a
// guessed one, and a plot the app has stopped asserting about - one whole
// growth overdue, where "ready" is no longer something it knows - gets no
// alarm either, because there is nothing honest left to say.
//
// No bundler. The app is plain ES modules served as they are, so the plugin is
// reached through the bridge Capacitor injects into the WebView rather than
// through an import, and everything here is a no-op in a browser.

import { rounds } from './rounds.js';

/** The native plugin, or null in any browser. */
const plugin = () => window.Capacitor?.Plugins?.LocalNotifications || null;

/** Can this build schedule an alarm at all? */
export const canRemind = () => !!plugin();

/**
 * A stable small integer per plot, because that is all Android will take.
 *
 * It has to be stable across runs: the ids are how a stale alarm gets
 * cancelled when you harvest early, and an id that changed between launches
 * would leave the old one to fire anyway. A plain 31-bit string hash, with the
 * kind folded in so a plot's harvest and its watering never collide.
 */
export function idFor(plotId, kind = 'ready') {
  let h = kind === 'ready' ? 0x1f3d5 : 0x1f4a7;
  const s = String(plotId);
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 2147483647 || 1;
}

/** Has the user said yes? Never asks - see `askToRemind`. */
export async function reminderState() {
  const p = plugin();
  if (!p) return 'unavailable';
  try {
    const { display } = await p.checkPermissions();
    return display;
  } catch {
    return 'unavailable';
  }
}

/** Ask, which must come from a tap. */
export async function askToRemind() {
  const p = plugin();
  if (!p) return 'unavailable';
  try {
    const { display } = await p.requestPermissions();
    return display;
  } catch {
    return 'denied';
  }
}

/**
 * Everything worth an alarm, from the same engine the screen reads.
 *
 * Deliberately derived rather than stored. The alarms are a projection of the
 * state and never a second copy of it: every sync cancels the lot and lays
 * them down again, so there is no way for a reminder to outlive the thing it
 * was about.
 */
export function plannedReminders(ctx, islands, at = Date.now()) {
  const out = [];
  for (const r of rounds(ctx, islands, at)) {
    // Only a plot the app is still willing to make a claim about.
    if (r.state === 'growing' && r.dueMin > 0 && r.task === 'wait') {
      out.push({
        id: idFor(r.plotId, 'ready'),
        at: r.dueMin,
        title: `${r.label} is ready`,
        body: `${r.island} · tap to say what you did with it`,
      });
    }
    /* A watering window, reminded shortly before it shuts rather than when it
     * opens - the whole point is to catch you before you lose it. Skipped
     * when the window would close within the hour, because an alarm for
     * something already almost gone is noise. */
    if (r.task === 'nurture' && r.closesMin > 0) {
      const when = r.closesMin - 60;
      if (when > Math.floor(at / 60000) + 5) {
        out.push({
          id: idFor(r.plotId, 'water'),
          at: when,
          title: `Water the ${r.label.split(' · ')[0]}`,
          body: `${r.island} · an hour left of this window`,
        });
      }
    }
  }
  /* Soonest first, and capped. Android holds a few hundred alarms and a person
   * has no use for the fiftieth, so the cap is about the person rather than
   * the platform. */
  return out.sort((a, b) => a.at - b.at).slice(0, 48);
}

/**
 * Lay down exactly the alarms the current state implies, and no others.
 *
 * Cancel-everything-then-reschedule rather than diffing. The set is small, it
 * runs on a tap, and the alternative quietly grows a drift between what the
 * phone will say and what the app believes - which on a reminder is the one
 * failure that matters.
 */
export async function syncReminders(ctx, islands, at = Date.now()) {
  const p = plugin();
  if (!p) return { scheduled: 0, why: 'not the packaged app' };
  if ((await reminderState()) !== 'granted') {
    return { scheduled: 0, why: 'not allowed to notify' };
  }
  try {
    const pending = await p.getPending();
    if (pending?.notifications?.length) {
      await p.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
    }
    const want = plannedReminders(ctx, islands, at);
    if (!want.length) return { scheduled: 0, why: 'nothing to remind about' };
    await p.schedule({
      notifications: want.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        schedule: {
          at: new Date(n.at * 60000),
          // Fire on time even in doze, which is most of a farming night.
          allowWhileIdle: true,
        },
      })),
    });
    return { scheduled: want.length, why: '' };
  } catch (err) {
    return { scheduled: 0, why: err?.message || 'the device refused' };
  }
}

/** Turn them all off, for the switch. */
export async function clearReminders() {
  const p = plugin();
  if (!p) return;
  try {
    const pending = await p.getPending();
    if (pending?.notifications?.length) {
      await p.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
    }
  } catch { /* nothing to clear is not a failure */ }
}
