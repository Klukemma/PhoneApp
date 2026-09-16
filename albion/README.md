# Albion Farm Profit

Works out what farming and crafting actually earn you in Albion Online, on
your phone, offline.

Install it the same way as CoinKeep: open
**https://klukemma.github.io/PhoneApp/albion/** in Chrome on the phone, then
**⋮ → Add to Home screen**. It installs as its own app, separate from
CoinKeep.

---

## The three screens

**Plan** — one whole **cycle**, not a daily rate. Farming and crafting are
separate phases because that is how focus works: it banks up while you farm,
caps at 30,000, and is then spent in one batch. So a cycle is *farm for N days,
idle while focus tops up, craft it all at the end*, and every figure on this
screen is worked out over one of those.

It is a single profit and loss, so nothing is double counted: what you grow
feeds what you craft, and only the leftovers get sold. Craft jobs run in
dependency order automatically — potatoes become alcohol before alcohol becomes
potions, however you list them.

Three things it tells you that are easy to miss:

- **When your focus caps.** Regeneration stops dead at the cap, so idling past
  that day throws away 10,000 focus a day. The card names the day and the
  amount; shortening the cycle to that day wastes none.
- **Whether you can actually water what you planted.** Watering 18 plots costs
  18,000 focus a day against 10,000 of regeneration, so most of it never
  happens and those yields are fiction. It says so.
- **What is really limiting each craft** — materials or focus. Leftover focus
  means grow more; leftover materials mean focus is the wall.

**Best** — the "what should I plant" screen. Every crop, herb and animal ranked
by silver per plot per day, and every recipe ranked by **silver per focus**,
which is the number that matters once focus is your bottleneck rather than
silver. Toggle watering, premium, focus and the city bonus and watch the order
change. Tap any row to add it to your plan.

**Prices** — your market prices. Everything else is fixed by the game; this is
the only part that is yours, and it is what makes the answers real. Seeds
default to the NPC price, which is usually well above what they fetch on the
market — worth correcting before you read anything into a big seed surplus.

Tap any row anywhere to get the full breakdown — every number in this app
opens up into the arithmetic behind it. Nothing is a black box.

### Prices

Hit **Fetch live market prices** to pull current sell orders from the
[Albion Online Data Project](https://www.albion-online-data.com/), choosing
your server — **Americas**, **Asia** or **Europe** — and city under *change*.
(The data project's hostnames still carry the old names, `west` for Americas
and `east` for Asia; the app keeps that as an implementation detail and shows
the servers by the names they have in game.) ADP is community-fed, so coverage varies —
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
| Names | the real in-game names, so alcohol is Potato Schnapps and a healing potion is a Major Healing Potion |
| Crops and herbs | tier, NPC seed price, 22h grow time, seed return rate, watering bonus, focus cost, 3–6 yield **per tile** |
| Animals | baby price, grow time, offspring rate, nutrition needed, favourite food, egg/milk output |
| Recipes | every potion and food recipe that uses something you farm — inputs, output count, focus cost |
| Cities | crafting bonus per category, the island value, farming bonus per item |
| Market | 2.5% setup fee, 8% transaction tax |
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

Where you do something changes what you get, so the app asks rather than
assumes. All of this is read from the game's own `craftingmodifiers.xml` and
`farmingmodifiers.xml`, not copied from a guide.

**Crafting.** Every city gives +18%. On top of that a city adds +15% only for
the categories it specialises in, and of this app's two categories there is
exactly one city each:

| Category | Bonus city | Any other city | Your own island |
| --- | --- | --- | --- |
| Potions | **Brecilien** (+33) | +18 | **+0** |
| Cooked food | **Caerleon** (+33) | +18 | **+0** |

The royal cities specialise in weapons, armour and refining, so for potions and
food they are just the base. Crafting on a private island earns *no* city bonus
at all — `islandvalue` is 0 throughout the game file — which costs you more
than crafting in the wrong city does. A T4 healing potion with focus returns
47.9% in Brecilien, 43.5% in a royal city and 37.1% on your island.

**Farming.** Each city gives **+10% yield** on a few named crops, herbs and
animal products, and here an island *does* inherit the bonus of the city it is
bound to. Raising an animal gets nothing; only its eggs or milk do.

| City | +10% on |
| --- | --- |
| Thetford | Agaric, Cabbage, Mullein |
| Lymhurst | Carrot, Burdock, Goose eggs, Pumpkin |
| Bridgewatch | Bean, Goat milk, Teasel, Corn |
| Martlock | Wheat, Potato, Foxglove, Cow milk |
| Fort Sterling | Chicken eggs, Turnip, Sheep milk, Yarrow |
| Caerleon | Comfrey, Teasel, Mullein |
| Brecilien | every crop (no herbs) |

An animal's favourite food is deliberately boosted in a *different* city from
the animal, so no single city is best at everything — there is a test that
asserts exactly that, to catch it if the game ever changes.

Set your usual places under **⚙️ Setup** — *Farm in…* and *Craft in…* — and
override either per plot or per craft job by tapping it on the Plan screen.

### Mastery

Albion specialises per item line, not globally, so mastery is set per recipe:
**⚙️ Setup → Mastery per recipe**, or on a job directly. Focus cost falls by the
constant from the game files and is exactly halved at mastery 100 — a T4
healing potion drops from 210 focus to 105, which doubles the silver you get
per point of focus. Recipes you have not set use your default level.

**Not everything is published in the dumps.** Focus regeneration (10,000 a day,
capped at 30,000) and premium doubling the farm yield are community-sourced and
editable under **⚙️ Setup → Game numbers**. Everything else now comes out of the
game files, including market tax: `gamedata.xml` gives a 2.5% setup fee and an
8% transaction tax, and premium halves the transaction half — 6.5% against
10.5%.

### One assumption worth knowing

Animals list a favourite plant with a `favouritebonus` of 1 in the game files.
The app reads that as *the favourite is worth double nutrition*, so a chicken
eats 9 wheat instead of 18 of something else. The breakdown always shows the
plant count, so check it against your pasture once and turn **Feed animals
their favourite** off in Setup if it does not match.

---

## How the maths works

**Counting.** A row is a number of **3×3 plots**, because that is the unit you
actually build and think in — one plot is nine tiles or nine animals. The game
data is per tile (3–6 crops, or 7–11 eggs from one bird), so the app multiplies
by nine and shows both numbers. Getting this wrong understates a farm ninefold,
which is exactly what it did before someone checked it against a real harvest:
four goose pastures return about 713 eggs a harvest here, against roughly 760
counted in game.

**A plot of crops.** Seeds come back at the rate in the game files, and
watering adds the watering bonus. Above 100% the plot pays for its own seed and
leaves a surplus. Those spare seeds are treated as **stock you can sell**, not
as a discount on the seed bill, so they appear in the end-of-cycle sales where
you can see them — this is why watered high-tier herbs beat unwatered ones by
more than the extra harvest alone.

**An animal.** Feed is `nutrition ÷ 48` plants, offspring offsets the next
baby, and the sale of the grown animal is taxed. Kept for eggs or milk instead,
it produces every 22 hours and keeps eating, so upkeep is charged per harvest.

**A craft.** Materials are charged at `(1 − return rate)`, because the rest
comes back — which also means the same pile of herbs makes *more* crafts, and
every one of those still costs focus. The return rate comes from the city you
chose for that job plus the focus bonus, and the focus cost from your mastery
in that specific recipe.

Focus is set per job, not globally, and that matters more than it sounds. A T6
healing potion needs 18 alcohol, and alcohol is 38 focus each — 684 focus of
alcohol feeding a 768-focus potion. Brew the alcohol with focus and it eats the
entire 30,000 before you make a single potion. Turn focus off for the cheap
intermediate step and the same cycle makes potions instead. There is a test
pinning exactly that.

**Per cycle.** Crops ripen in 22 hours, but the default assumes you harvest
every 24 — the honest cadence for someone logging in once a day — so ten
farming days is ten harvests. Per day and per 30 days are just the cycle figure
spread out, for comparing against something on a different schedule.

Set the cycle under **⚙️ Setup → Your cycle**: its length, how many of those
days you actually farm, and how much focus you start with.

Everything is priced **after market tax** on the sell side and at what you
actually pay on the buy side.

---

## Development

```bash
npm start      # http://localhost:8080/albion/
npm test       # 59 tests over the profit engine and the extracted data
npm run gamedata
```

`js/calc.js` is pure — game data and prices in, silver out, no storage or DOM.
Every figure on every screen comes from it, so no two screens can disagree.
`albion/tools/build_gamedata.py` is the only thing that knows about Albion's
file formats; the app only ever sees `data/gamedata.json`.

Your prices, plan and settings live in this browser's storage and nowhere else.
Back them up under **⚙️ Setup → Export backup**.
