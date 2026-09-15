# PhoneApp

Two small offline phone apps, installed from a link and updated automatically.

| App | What it does | Link |
| --- | --- | --- |
| **CoinKeep** | What can I spend today and still hit my savings goal? | [/](https://klukemma.github.io/PhoneApp/) |
| **Albion Farm Profit** | What does farming and crafting actually earn in Albion Online? | [/albion/](https://klukemma.github.io/PhoneApp/albion/) — [docs](albion/README.md) |

Both are PWAs: no Play Store, no APK, no account, no server. Everything stays
on the phone. `npm test` covers both.

---

# CoinKeep

A small offline money tracker for your phone. It answers one question every
morning:

> **How much can I spend today and still hit my savings goal this month?**

Built for a pay cycle that isn't monthly — you get paid roughly every 15 days,
so the app works out your limit from *when your money actually arrives*, not
from the calendar.

---

## Getting it on your Honor phone

It's a **PWA** — a web app that installs from a link. No Play Store, no APK,
no Google services needed, and it updates itself.

1. **Turn on hosting (once).** In this repo go to **Settings → Pages**, and
   under *Source* pick **GitHub Actions**. Push to `main` and the included
   workflow publishes the app.
2. Wait for the green tick on the **Actions** tab. Your link will be:
   `https://klukemma.github.io/PhoneApp/`
3. **On the phone**, open that link in **Chrome**.
4. Tap the **⋮** menu → **Add to Home screen** (or *Install app*).
5. Open it from your home screen. It runs full screen and works with no signal.

> Prefer to try it on a computer first? `npm start` and open
> <http://localhost:8080>.

**Your data never leaves the phone.** There is no account, no server, no
analytics. Everything sits in that browser's storage — so use
**⚙️ → Export backup** now and then, especially before clearing browser data
or switching phones.

---

## How the daily limit is worked out

The number on the Today screen is the **smaller of two limits**, so it is
always the honest one:

**1. The goal pace** — spread what's left over the days left:

```
( money in this month
+ paychecks still expected before month end
− everything spent so far
− every subscription still due this month
− your savings goal )           ÷  days left in the month
```

**2. The cash guard** — never plan around money that hasn't landed:

```
( money in your account right now
− subscriptions due before your next paycheck )  ÷  days until that paycheck
```

That second limit is the one that matters on a 15-day pay cycle. Halfway
through the month the first rule might happily offer you €120 a day because a
big paycheck is coming — but if there's only €60 in the account and payday is
eight days out, the app says **€7.50**, and the Today screen tells you it's
capped by cash on hand.

A few consequences worth knowing:

- **Overspend today and tomorrow's limit drops**, because the pot is
  recalculated from what's actually left. Nothing is "lost" — it's absorbed
  across the days remaining.
- **A bill landing never eats your spending money.** Subscriptions are
  reserved out of the pot up front, so the day Netflix charges you, your daily
  limit doesn't collapse.
- **Pay dates re-time themselves.** "Every 15 days or so" drifts. Each time you
  log a paycheck, the next payday forecast re-anchors to that date.

---

## Using it

**Today** — your limit, and the quick-add buttons. One tap logs a purchase
instantly; a toast lets you undo if you fat-finger it. Hit **Edit** to change
the buttons to whatever you actually buy, with your own amounts.

**The + button** — anything not on a quick button. Big keypad, pick a
category, optionally date it earlier if you're catching up.

**BS spending 🙈** — the point of the app. Flag anything you regret — the
delivery you didn't need, the impulse buy. It still counts against your money,
but it's totted up separately so Stats can show you exactly what it costs you
per day and per year. Quick-add buttons can be pre-flagged as BS.

**Bills** — subscriptions and anything recurring. Set the amount and when it
next charges; the app posts it automatically on the day, even if the app was
closed for weeks. Weekly, monthly, yearly or every-N-days. Pause one instead
of deleting it to keep the history. The screen ranks them by what they cost you
per month, and shows the yearly damage.

**Log** — everything by day, with month-by-month browsing. Filter to *BS only*
to see the pattern. Tap any row to edit or delete it.

**Stats** — goal progress, where the money went, a day-by-day bar chart, and
your pay-cycle position: balance, next payday, and both daily limits side by
side so you can see which one is binding.

**⚙️ Setup** — savings goal, paycheck size and cycle length, current balance,
currency, and backup/restore.

### Getting started

The app asks for four things on first run: your currency, this month's savings
goal, your usual paycheck and how often it lands, and what's in your account
right now. That's enough for a real number. Then just log what you spend, and
log each paycheck as it arrives.

---

## Development

```bash
npm start     # dev server at http://localhost:8080
npm test      # the money math — 17 tests, no dependencies
```

No build step and no dependencies. Plain ES modules served as-is.

| Path | What's in it |
| --- | --- |
| `js/budget.js` | All the money math: limits, pay cycles, bill scheduling |
| `js/store.js` | Local storage, backup/restore |
| `js/views.js` | The four screens |
| `js/sheets.js` | Add/edit forms |
| `js/ui.js` | Sheets, toasts, the keypad |
| `js/util.js` | Date and currency helpers |
| `tests/` | Tests for `budget.js` |
| `sw.js` | Service worker — makes it work offline |
| `albion/` | The Albion Farm Profit app — see [its README](albion/README.md) |

`budget.js` is deliberately pure: it reads state and returns numbers, never
touching storage or the DOM. Every figure on every screen comes from
`snapshot()`, so no two screens can disagree.

After changing anything in the app shell, bump `CACHE` in `sw.js` so installed
copies pick up the new version.

## Licence

MIT.
