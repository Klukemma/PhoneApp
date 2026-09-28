// Installing it: which steps a browser gets told, and whether it is already on.
//
// Two paths and no third, and the one that matters is the one with no API
// behind it - on iOS the app can only print instructions, so the instructions
// have to be right for the browser actually in hand. Getting that wrong sends
// somebody to a menu that does not have the option.

import assert from 'node:assert/strict';
import test from 'node:test';

/* The module reads navigator and window at call time, not at import time, so
 * one fake per test is enough and there is no module cache to fight. */
const as = (ua, { platform = '', touch = 0, standalone, display } = {}) => {
  const nav = { userAgent: ua, platform, maxTouchPoints: touch, standalone };
  /* Node 22 ships its own `navigator` and it is getter-only, so a plain
   * assignment throws rather than shadowing it. */
  Object.defineProperty(globalThis, 'navigator', {
    value: nav, configurable: true, writable: true,
  });
  globalThis.window = {
    navigator: nav,
    matchMedia: (q) => ({ matches: display ? q.includes(display) : false }),
  };
};

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126 Mobile/15E148 Safari/604.1',
  ipadOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36',
  desktop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
};

as(UA.desktop);
const { canPrompt, isInstalled, isNative, platform, steps } = await import('../js/install.js');

test('an iPhone is told to use Safari, and told so only when it is Safari', () => {
  as(UA.iphoneSafari);
  assert.equal(platform(), 'ios-safari');
  assert.match(steps().lines.join(' '), /Share/);
  assert.match(steps().lines.join(' '), /Add to Home Screen/);

  /* Chrome on an iPhone is Safari underneath and still cannot do it - the
   * option is not in its menus. Sending someone there to look for a Share
   * sheet that has no Add to Home Screen in it is worse than saying nothing. */
  as(UA.iphoneChrome);
  assert.equal(platform(), 'ios-other');
  assert.match(steps().title, /Safari/);
  assert.match(steps().note, /only Safari/);
});

test('an iPad says it is a Mac, and the touch points give it away', () => {
  // iPadOS has reported itself as a desktop Mac since version 13.
  as(UA.ipadOS, { platform: 'MacIntel', touch: 5 });
  assert.equal(platform(), 'ios-safari');
  // A real Mac, with the same string and no touch, is not.
  as(UA.ipadOS, { platform: 'MacIntel', touch: 0 });
  assert.equal(platform(), 'desktop');
});

test('everything else falls through to something that is true there', () => {
  as(UA.android);
  assert.equal(platform(), 'android');
  assert.match(steps().lines.join(' '), /Home screen|Install app/);
  as(UA.desktop);
  assert.equal(platform(), 'desktop');
  assert.match(steps().lines.join(' '), /address bar/);
  // Every path has steps, a title and a note - none of them can come back bare.
  for (const where of ['ios-safari', 'ios-other', 'android', 'desktop']) {
    const s = steps(where);
    assert.ok(s.title && s.note && s.lines.length >= 2, where);
  }
});

test('an app already on the home screen does not ask to be installed', () => {
  as(UA.android, { display: 'standalone' });
  assert.equal(isInstalled(), true);
  as(UA.android, { display: 'fullscreen' });
  assert.equal(isInstalled(), true);
  // iOS has no display-mode for this and uses its own flag instead.
  as(UA.iphoneSafari, { standalone: true });
  assert.equal(isInstalled(), true);
  as(UA.iphoneSafari, { standalone: false });
  assert.equal(isInstalled(), false);
  as(UA.android);
  assert.equal(isInstalled(), false);
});

test('the packaged app never offers to install itself', () => {
  /* The APK is the strongest form of "installed" there is, and a WebView does
   * not reliably report a display mode - so without this check the packaged
   * Android build would sit there offering to put itself on the home screen. */
  as(UA.android);
  assert.equal(isNative(), false);
  assert.equal(isInstalled(), false, 'a plain Chrome tab is not installed');
  globalThis.window.Capacitor = { isNativePlatform: () => true };
  assert.equal(isNative(), true);
  assert.equal(isInstalled(), true);
  // And it never holds a browser install prompt either, whatever fires.
  globalThis.window.__installPrompt = { prompt() {} };
  assert.equal(canPrompt(), false);
  delete globalThis.window.Capacitor;
  delete globalThis.window.__installPrompt;
});

test('there is no install dialog to offer until the browser hands one over', () => {
  as(UA.android);
  assert.equal(canPrompt(), false);
  globalThis.window.__installPrompt = { prompt() {} };
  assert.equal(canPrompt(), true);
});
