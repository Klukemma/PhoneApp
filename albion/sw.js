// Cache-first shell so the app opens instantly and works with no signal.
// Bump CACHE when the shell or the game data changes.

const CACHE = 'albionfarm-v14';  // v14: buy vs sell, and a market per item
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css',
  './js/app.js', './js/views.js', './js/sheets.js', './js/store.js',
  './js/calc.js', './js/solve.js', './js/prices.js', './js/ui.js', './js/util.js',
  './data/gamedata.json',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((url) => c.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  // Live prices must always go to the network, never the cache.
  if (new URL(request.url).origin !== self.location.origin) return;

  e.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      }).catch(() => hit || caches.match('./index.html'));
      return hit || network;
    }),
  );
});
