# PhoneApp

Two offline phone apps, installed from a link and updated automatically.

**Open <https://klukemma.github.io/PhoneApp/> on the phone and install them
from there.**

| App | What it does | Lives at |
| --- | --- | --- |
| [**CoinKeep**](coinkeep/README.md) | What can I spend today and still hit my savings goal? | `/coinkeep/` |
| [**Albion Farm Profit**](albion/README.md) | What does farming and crafting actually earn in Albion Online? | `/albion/` |

Both are PWAs: no Play Store, no APK, no account, no server. Everything stays
on the phone.

## Why each app has its own folder

A PWA owns a URL prefix — its *scope* — and one app's scope cannot sit inside
another's. While CoinKeep was served from the site root its scope was
`/PhoneApp/`, which swallowed `/PhoneApp/albion/`: tapping the Albion link just
opened CoinKeep, and Chrome would not offer to install Albion separately
because the URL already belonged to an installed app.

So the two apps are siblings, and the root holds only a plain launcher page
with no manifest and no scope of its own:

```
/PhoneApp/            launcher (not installable, claims nothing)
/PhoneApp/coinkeep/   CoinKeep          scope /PhoneApp/coinkeep/
/PhoneApp/albion/     Albion Farm Profit scope /PhoneApp/albion/
```

`sw.js` at the root is a retirement worker: it deletes the old root-scoped
cache and unregisters itself, so the service worker CoinKeep left behind stops
claiming `/albion/`.

Browser storage is per *origin*, not per path, so moving CoinKeep from `/` to
`/coinkeep/` did not touch any saved data.

## Development

```bash
npm start     # http://localhost:8080 — launcher, both apps underneath
npm test      # both apps: 17 CoinKeep + 89 Albion
npm run gamedata   # refresh Albion's game data after a patch
```

No build step and no dependencies. Plain ES modules served as-is.
Each app is self-contained: its own `index.html`, manifest, service worker,
icons and tests.

## Licence

MIT.
