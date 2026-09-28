// Installing it, which is the difference between a link and an app.
//
// The app is a PWA: it has a manifest, a service worker and icons, and once it
// is on the home screen it opens fullscreen, keeps its own data and works with
// no signal at all. None of that happens on its own, though - somebody has to
// install it, and every platform hides that behind a different menu.
//
// Two paths, because there are only two:
//
//   Chrome and Edge, on Android and on the desktop, fire `beforeinstallprompt`
//   when they decide the app qualifies. Holding on to that event lets the app
//   put the real system install dialog behind its own button, which is one tap.
//
//   Safari on iOS fires nothing and has no API at all. Add to Home Screen is
//   in the Share menu and the only thing the app can do is say so, accurately,
//   for the browser the user is actually holding.
//
// The event is captured by four lines of inline script in index.html rather
// than here, because it can fire before a deferred module has run, and an
// event you did not hear is an install you cannot offer.

/** Is this the packaged Android app rather than a page in a browser? */
export const isNative = () => !!(window.Capacitor?.isNativePlatform?.());

/**
 * Is it already an app, by whichever of the two routes?
 *
 * The APK is the strongest form of "installed" there is, and it must be
 * checked first: a WebView does not reliably report a display mode, so
 * without this the packaged app would sit there offering to install itself.
 */
export function isInstalled() {
  return isNative()
    || window.matchMedia?.('(display-mode: standalone)').matches
    || window.matchMedia?.('(display-mode: fullscreen)').matches
    || window.navigator.standalone === true;
}

/** Did the browser offer us its install dialog to hold on to? */
export const canPrompt = () => !isNative() && !!window.__installPrompt;

/**
 * Show the browser's own install dialog.
 *
 * Returns 'accepted', 'dismissed', or 'unavailable' when there was no event to
 * fire. The event is single-use: once it has been shown the browser will not
 * give it back, so it is dropped either way.
 */
export async function promptInstall() {
  const e = window.__installPrompt;
  if (!e) return 'unavailable';
  window.__installPrompt = null;
  try {
    e.prompt();
    const { outcome } = await e.userChoice;
    return outcome === 'accepted' ? 'accepted' : 'dismissed';
  } catch {
    return 'dismissed';
  }
}

/**
 * Which browser this is, only as far as the install path differs.
 *
 * Deliberately shallow. User-agent sniffing is unreliable and this does not
 * need it to be reliable - it picks which set of true instructions to show
 * first, and every other case falls through to a sentence that is true
 * everywhere.
 */
export function platform() {
  const ua = navigator.userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua)
    // iPadOS reports itself as a Mac, and the touch points give it away.
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) {
    /* On iOS every browser is Safari underneath, but only Safari itself can
     * add to the home screen - Chrome and Firefox on iOS cannot, and saying
     * "use the Share menu" to someone in Chrome sends them somewhere that
     * does not have the option. */
    const realSafari = !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
    return realSafari ? 'ios-safari' : 'ios-other';
  }
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

/** The steps, for the browser in their hand. */
export function steps(where = platform()) {
  switch (where) {
    case 'ios-safari':
      return {
        title: 'Add it to your home screen',
        lines: [
          'Tap the <b>Share</b> button at the bottom of Safari — the square with an arrow coming out of it.',
          'Scroll down the list and tap <b>Add to Home Screen</b>.',
          'Tap <b>Add</b>, top right.',
        ],
        note: `Safari has no button an app can offer for this, so these are the
          steps rather than a tap. Once it is there it opens fullscreen with no
          address bar, keeps your own numbers, and works with no signal.`,
      };
    case 'ios-other':
      return {
        title: 'Open this in Safari first',
        lines: [
          'Tap the <b>…</b> or share menu and choose <b>Open in Safari</b>.',
          'In Safari, tap <b>Share</b>, then <b>Add to Home Screen</b>.',
        ],
        note: `On an iPhone only Safari itself can put an app on the home
          screen. Chrome and Firefox here are Safari underneath but the option
          is not in their menus.`,
      };
    case 'android':
      return {
        title: 'Add it to your home screen',
        lines: [
          'Tap the <b>⋮</b> menu, top right of Chrome.',
          'Tap <b>Add to Home screen</b>, or <b>Install app</b> if it says that.',
        ],
        note: `Chrome usually offers this as a button instead. If it has not
          yet, it is because it waits until you have used the app once or
          twice.`,
      };
    default:
      return {
        title: 'Install it on this computer',
        lines: [
          'Look for an install icon at the right-hand end of the address bar.',
          'Or open the browser menu and choose <b>Install</b>.',
        ],
        note: 'Chrome, Edge and Brave can do this. Firefox and Safari on a desktop cannot.',
      };
  }
}
