// Optional: pull live market prices from the Albion Online Data Project.
//
// ADP is community-run and fed by players running its client, so coverage
// varies by server, city and item — anything it has no data for is left alone
// rather than overwritten with a zero. Typing prices in by hand always works
// and is never blocked by this failing.

/**
 * The three live game servers.
 *
 * The data project's hostnames still use the old names — Albion Americas was
 * "West" and Albion Asia was "East" — so the hostname is kept as an
 * implementation detail and the server is shown by the name it has in game.
 */
export const SERVERS = [
  { id: 'americas', name: 'Americas', host: 'https://west.albion-online-data.com' },
  { id: 'asia', name: 'Asia', host: 'https://east.albion-online-data.com' },
  { id: 'europe', name: 'Europe', host: 'https://europe.albion-online-data.com' },
];

const hostFor = (id) => SERVERS.find((s) => s.id === id)?.host;

export const serverName = (id) =>
  SERVERS.find((s) => s.id === id)?.name || id;

export const CITIES = [
  'Caerleon', 'Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Martlock',
  'Thetford', 'Brecilien',
];

const BATCH = 100;          // keep the URL comfortably short
const chunk = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/**
 * Fetch sell-order prices for `ids`.
 *
 * Returns { prices, found, missing, stale } — `prices` maps item id to the
 * cheapest current sell offer, which is what you would actually pay.
 * `onProgress` is called with (done, total) so the UI can show movement.
 */
export async function fetchPrices(ids, { server = 'americas', city = 'Caerleon',
  maxAgeHours = 0, onProgress, signal } = {}) {
  const host = hostFor(server);
  if (!host) throw new Error(`Unknown server "${server}"`);

  const batches = chunk([...new Set(ids)], BATCH);
  const prices = {};
  let stale = 0;
  const cutoff = maxAgeHours > 0 ? Date.now() - maxAgeHours * 3600_000 : null;

  for (const [i, batch] of batches.entries()) {
    const url = `${host}/api/v2/stats/prices/${batch.join(',')}` +
      `?locations=${encodeURIComponent(city)}&qualities=1`;

    const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`Price server replied ${res.status}. Try again later, ` +
        `or enter prices by hand.`);
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error('Price server sent an unexpected reply.');

    for (const row of rows) {
      const value = Number(row?.sell_price_min);
      if (!Number.isFinite(value) || value <= 0) continue;
      if (cutoff) {
        const seen = Date.parse(row.sell_price_min_date || '');
        if (Number.isFinite(seen) && seen < cutoff) { stale++; continue; }
      }
      // Several rows can come back per item; keep the cheapest offer.
      const id = row.item_id;
      prices[id] = prices[id] ? Math.min(prices[id], value) : value;
    }
    onProgress?.(i + 1, batches.length);
  }

  const found = Object.keys(prices);
  return {
    prices, found,
    missing: [...new Set(ids)].filter((id) => !(id in prices)),
    stale,
  };
}

/** Turn a fetch failure into something worth showing a person. */
export function explain(err) {
  if (err?.name === 'AbortError') return 'Price update cancelled.';
  if (err instanceof TypeError) {
    return 'Could not reach the price server — check your connection. ' +
      'You can still type prices in by hand.';
  }
  return err?.message || 'Price update failed.';
}
