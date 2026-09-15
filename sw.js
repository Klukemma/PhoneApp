// Retirement worker.
//
// CoinKeep used to be served from this path and registered a service worker
// with scope /PhoneApp/ — which covers /PhoneApp/albion/ too. While that
// registration lives, the installed CoinKeep captures the Albion app's URL and
// Chrome will not install it separately. So this worker drops the old cache,
// unregisters itself, and hands the pages back to the network.

const RETIRED_CACHE = 'coinkeep-v1';   // the old root-scoped shell

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Only the old cache — caches are shared per origin, and the apps in their
    // new homes own the others.
    await caches.delete(RETIRED_CACHE);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      client.navigate(client.url).catch(() => {});
    }
  })());
});

// Until the unregister lands, stay out of the way.
self.addEventListener('fetch', () => {});
