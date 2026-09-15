# Albion Farm Profit

Works out what farming and crafting actually earn you in Albion Online, on
your phone, offline.

Install it the same way as CoinKeep: open
**https://klukemma.github.io/PhoneApp/albion/** in Chrome on the phone, then
**⋮ → Add to Home screen**. It installs as its own app, separate from
CoinKeep.

---

## The three screens

**Plan** — what you are actually running. Add farm plots (crops, herbs,
animals to raise, animals kept for eggs and milk) and craft jobs, and it totals
your silver per day and per month. The focus bar shows whether your plan fits
in the 10,000 focus a day you regenerate — plan more than that and it says so,
because a plan you cannot fuel is not a plan.

**Best** — the "what should I plant" screen. Every crop, herb and animal ranked
by silver per plot per day, and every recipe ranked by **silver per focus**,
which is the number that matters once focus is your bottleneck rather than
silver. Toggle watering, premium, focus and the city bonus and watch the order
change. Tap any row to add it to your plan.

**Prices** — your market prices. Everything else is fixed by the game; this is
the only part that is yours, and it is what makes the answers real.

Tap any row anywhere to get the full breakdown — every number in this app
opens up into the arithmetic behind it. Nothing is a black box.

### Prices

Hit **Fetch live market prices** to pull current sell orders from the
[Albion Online Data Project](https://www.albion-online-data.com/), choosing
your server and city under *change*. ADP is community-fed, so coverage varies —
anything it has no data for is left alone rather than overwritten, and you can
always type prices in by hand.

Rows whose prices you have not set are pushed into a **Needs prices** group and
show a dash instead of a number. That is deliberate: an unpriced input reads as
free and an unpriced output reads as worthless, so a row missing either would
otherwise look like a bargain when it is really just unknown.

---

## Where the numbers come from

Almost everything is read straight out of the game's own data files
([ao-data/ao-bin-dumps](https://github.com/ao-data/ao-bin-dumps)) rather than
typed in from a guide:

| From the game files | |
| --- | --- |
| Crops and herbs | tier, NPC seed price, 22h grow time, seed return rate, watering bonus, focus cost, 3–6 yield |
| Animals | baby price, grow time, offspring rate, nutrition needed, favourite food, egg/milk output |
| Recipes | every potion and food recipe that uses something you farm — inputs, output count, focus cost |
| Focus | crafting bonus **+59%**, and the cost constant that halves focus at specialisation 100 |

To refresh after a patch:

```bash
npm run gamedata     # re-reads the dumps and rewrites albion/data/gamedata.json
npm test             # checks the result is still internally consistent
```

The return rate formula is the standard one:

```
return rate = 1 − 100 / (100 + sum of bonuses)
```

Bonuses add as percentage points before converting, which is why they do not
simply stack. The defaults reproduce the figures players see in game:

| Setup | Bonuses | Return rate |
| --- | --- | --- |
| Royal city, no focus | 18 | 15.2% |
| Royal city + focus | 18 + 59 | 43.5% |
| Specialty city + focus | 18 + 15 + 59 | 47.9% |
| Refining specialty + focus | 18 + 40 + 59 | 53.9% |

### Cities

The specialty bonus only applies when the city actually specialises in what you
are making, so you pick the city and the app works out the rest. Of this app's
two craft categories:

| Category | Bonus city | Everywhere else |
| --- | --- | --- |
| Potions | **Brecilien** (+18 base, +15 specialty) | +18 base only |
| Cooked food | **Caerleon** (+18 base, +15 specialty) | +18 base only |

The five royal cities specialise in weapons, armour and refining, so for
potions and food they give the base and nothing more. Brewing a T4 healing
potion with focus returns 47.9% of materials in Brecilien but 43.5% in
Martlock — worth several hundred silver a craft, so it is worth getting right.

Set your usual city under **⚙️ Setup → Craft in…**, and override it per job by
tapping that job on the Plan screen. The Best screen costs everything in the
city shown in its header.

### Mastery

Albion specialises per item line, not globally, so mastery is set per recipe:
**⚙️ Setup → Mastery per recipe**, or on a job directly. Focus cost falls by the
constant from the game files and is exactly halved at mastery 100 — a T4
healing potion drops from 210 focus to 105, which doubles the silver you get
per point of focus. Recipes you have not set use your default level.

**Not everything is published in the dumps.** The city base bonus (+18), the
crafting specialty bonus (+15), which cities hold which specialty, focus
regeneration (10,000/day) and market tax (6.5% with premium, 10.5% without) are
community-sourced and cross-checked against the return rates above. Every one
of them is editable under **⚙️ Setup → Game numbers**, so when a patch moves
them you fix it yourself rather than waiting for me. In game, a station's real
bonus is on the city map — the yellow triangle under the resource icons.

### One assumption worth knowing

Animals list a favourite plant with a `favouritebonus` of 1 in the game files.
The app reads that as *the favourite is worth double nutrition*, so a chicken
eats 9 wheat instead of 18 of something else. The breakdown always shows the
plant count, so check it against your pasture once and turn **Feed animals
their favourite** off in Setup if it does not match.

---

## How the maths works

**A plot of crops.** Seeds come back at the rate in the game files, and
watering adds the watering bonus. Above 100% the plot pays for its own seed and
leaves a surplus, so the seed line becomes income rather than cost — this is
why watered cabbage beats unwatered cabbage by more than the extra harvest
alone.

**An animal.** Feed is `nutrition ÷ 48` plants, offspring offsets the next
baby, and the sale of the grown animal is taxed. Kept for eggs or milk instead,
it produces every 22 hours and keeps eating, so upkeep is charged per harvest.

**A craft.** Materials are charged at `(1 − return rate)`, because the rest
comes back. The return rate comes from the city you chose for that job plus the
focus bonus, and the focus cost comes from your mastery in that specific
recipe. With focus on, the app also reports silver per focus and tells you how
many crafts a day your focus budget covers.

**Per month.** Crops ripen in 22 hours, but the default assumes you harvest
every 24 — the honest cadence for someone logging in once a day. Set it to 22
under Setup if you really do harvest the moment it ripens.

Everything is priced **after market tax** on the sell side and at what you
actually pay on the buy side.

---

## Development

```bash
npm start      # http://localhost:8080/albion/
npm test       # 32 tests over the profit engine and the extracted data
npm run gamedata
```

`js/calc.js` is pure — game data and prices in, silver out, no storage or DOM.
Every figure on every screen comes from it, so no two screens can disagree.
`albion/tools/build_gamedata.py` is the only thing that knows about Albion's
file formats; the app only ever sees `data/gamedata.json`.

Your prices, plan and settings live in this browser's storage and nowhere else.
Back them up under **⚙️ Setup → Export backup**.
