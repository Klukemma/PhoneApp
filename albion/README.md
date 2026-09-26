# Albion Farm Profit

Works out what farming and crafting actually earn you in Albion Online, on
your phone, offline.

Install it the same way as CoinKeep: open
**https://klukemma.github.io/PhoneApp/albion/** in Chrome on the phone, then
**⋮ → Add to Home screen**. It installs as its own app, separate from
CoinKeep.

---

## The five screens

**Plan** — one whole **cycle**, not a daily rate. Farming and crafting are
separate phases because that is how focus works: it banks up while you farm,
caps at 30,000, and is then spent in one batch. So a cycle is *farm for N days,
idle while focus tops up, craft it all at the end*, and every figure on this
screen is worked out over one of those.

It is a single profit and loss, so nothing is double counted: what you grow
feeds what you craft. Craft jobs run in dependency order automatically —
potatoes become schnapps before schnapps becomes potions, however you list
them.

**Leftover ingredients are not sold.** Anything your own crafting eats is held
for the next batch, because that is what you actually do with it — you work
through the pile over following cycles rather than dumping it on the market.
Only the finished goods and the spare seeds count as revenue. The stock is
listed separately with its value, so you can see it without it flattering the
profit.

Three things it tells you that are easy to miss:

- **When your focus caps.** Regeneration stops dead at the cap, so idling past
  that day throws away 10,000 focus a day. The card names the day and the
  amount; shortening the cycle to that day wastes none.
- **Whether you can actually water what you planted.** Watering costs 1,000
  focus a *tile*, so nine 3×3 plots want 81,000 a farming day against 10,000 of
  regeneration. Only the share you can pay for earns the extra seeds, and the
  figures already reflect that rather than quietly assuming a fully watered
  farm. It tells you what that share is.
- **What skipping a day buys you.** Farming every other day halves your
  harvests but doubles the focus waiting for each watering, so a bigger share
  of the farm gets watered. Set the rhythm under *Your cycle* and compare.
  Rows that cost no focus ignore the rhythm entirely — collecting eggs is free,
  so there is nothing to rest for and the geese keep laying through the skipped
  days.
- **Whether the farm is outrunning the crafting.** Each crop is scored against
  what your crafting actually gets through — "6.8× what you use" — with the
  plot count that would match it, and how many cycles before the pile passes
  the spare stock you are willing to sit on (5,000 by default, under Me).
  That is the point at which you stop farming it and let the pile drain.
- **What is really limiting each craft** — and *which* material, by name.
  "Short on Elusive Foxglove" tells you what to plant; "no Potato Schnapps at
  all" tells you that you forgot a step, and offers to add it. Leftover focus
  means grow more; leftover materials mean focus is the wall.

**Craft** — a profit and loss for one production run, whatever it is: a stack
of potions, a set of plate boots, a pile of steel bars, a saddled mount. Every
material carries a **buy / make / gather** tag, and tapping it changes where
that material comes from. Buy it and it is a bill; make it and the run grows a
refining step; gather it and the bill goes to zero and the run starts costing
hours instead.

**Best** — four rankings, on four tabs. *Farm*: every crop, herb and animal by
silver per plot per day. *Brew*: every recipe by **silver per focus**, which is
the number that matters once focus is the bottleneck rather than silver.
*Gear*: one slice of the six thousand weapons and armours, whichever of the
market and the Black Market pays more. *Gather*: every resource at a tier by
the best thing to do with it. Toggle watering, premium, focus and the city
bonus and watch the order change. Tap any row to open it where it can be
worked on.

**Market** — your market prices. Everything else is fixed by the game; this is
the only part that is yours, and it is what makes the answers real. Seeds
default to the NPC price, which is usually well above what they fetch on the
market — worth correcting before you read anything into a big seed surplus.

Tap any row anywhere to get the full breakdown — every number in this app
opens up into the arithmetic behind it. Nothing is a black box.

### Market

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
| Destiny board | every node that reduces focus cost, what it covers, and by how much per level |
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

| Me | Bonuses | Return rate |
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

Set your usual places under **Me** — *Farm in…* and *Craft in…* — and
override either per plot or per craft job by tapping it on the Plan screen.

### Mastery

Focus cost is driven by the **destiny board**, under **Me → Destiny
board**, and both halves of it count:

| Node | Per level | Covers |
| --- | --- | --- |
| `Herbs` (branch mastery) | **+1.0** | every herb seed |
| `Foxglove` (specialisation) | **+2.0** | foxglove only |
| `Alchemist` (branch mastery) | **+0.3** | all potions and schnapps |
| `Major Healing Potion` (spec) | **+2.5** own item, **+0.225** whole branch |

Those numbers come from `achievements.xml`, so they are the game's, not a
guess. Add them up for an item and you get its **focus cost efficiency**; every
100 points halves the cost, using the same constant the game publishes.

Two things fall out that are easy to miss, and the app makes both visible:

- **Specialisations help their siblings.** Levelling Potato Schnapps gives
  +0.225 a level to *every* potion, so it quietly cheapens your healing
  potions. Board editor shows the breakdown line by line.
- **Farming nodes cut watering, not just crafting.** Herbs mastery and the
  foxglove specialisation at 100 take a tile from 1,000 focus to 125. On a
  90-tile farm that lifts the share you can actually water from 11% to 52%,
  which changes the seed return on every plot.

Worked example, a T6 Major Healing Potion at 768 focus:

| Board | Efficiency | Focus each |
| --- | --- | --- |
| nothing levelled | 0 | 768 |
| Heal spec 100 | 272.5 | 116 |
| + Alchemist mastery 100 | 302.5 | 94 |
| + Potato Schnapps spec 100 | 325 | 81 |

If you would rather just type the number your game screen shows, there is a
per-recipe override under **Me → Per-recipe overrides** which wins over the
board.

**Not everything is published in the dumps.** Focus regeneration (10,000 a day,
capped at 30,000) and premium doubling the farm yield are community-sourced and
editable under **Me → Game numbers**. Everything else now comes out of the
game files, including market tax: `gamedata.xml` gives a 2.5% setup fee and an
8% transaction tax, and premium halves the transaction half — 6.5% against
10.5%.

### Journals

A gathering run earns fame, and that fame fills journals: you buy them empty at
a station, gather as you were going to anyway, and sell them full. It is worth
about 8% of a run and the app used to report it as zero. On 999 T5 logs it is
78k of full books against 35k of empty ones.

The whole economy is published — the station's price for an empty one, what a
full one holds, and which tiers count towards it. Two things in the file catch
people out and both are handled: the journal families are named for the
profession while the resources are named for the material, so a stone gatherer
fills a **Stonecutter's** journal off **rock**; and an empty journal and a full
one are not separate entries in items.xml at all, though they are separate items
on the market, so both ids are emitted for pricing.

One thing the files do not settle, and the app says so on screen: a journal
carries two fame numbers — `maxfame` and a mission value exactly two thirds of
it — and nothing says which fills the book. The app counts with `maxfame`, the
one that names a capacity.

### Quality, and rerolling it

The repair station's Reroll Quality action is published in full, and two facts
in that table are worth knowing. Every below-diagonal weight is zero, so a
reroll can only ever move an item **up**. And from Normal the stay-weight is
zero too — so rerolling a plain item **always** improves it, four times in five
to Good and one in two thousand straight to Masterpiece.

What the station charges is in no game file. So the app does not quote a fee: it
works out what the reroll is *worth* from your own per-quality prices and gives
you the threshold — "worth doing if the fee is under 43,431". The unknown number
stays unknown and becomes the thing you check at the station, where it is
written down anyway.

### How old is that price?

Every price records when the market last **saw** it — the data project's own
observation date, not when you pressed fetch. Prices older than your threshold
(24 hours by default) are flagged on the Market list and warned about in the
price sheet.

Age is a label and never an adjustment. Nothing in any game file says when a
quote goes off, so no number is silently discounted by it. Prices saved before
the app recorded dates read "age unknown", because that is what they are.

### Where you farm

A royal city pays **+10%** yield on the handful of crops, herbs and animal
products it specialises in, and every island carries the full bonus of the city
it is bound to.

Guild territory in the Outlands pays **+200%** — twenty times that — on fifteen
crops and herbs. Three things about it the file says and nobody expects: it
covers plants only, so eggs and milk earn nothing out there while Martlock pays
on cow milk; an island in the Outlands earns **no** bonus at all, the exact
opposite of a royal island; and it has no station, so it is offered as a place
to farm and never as a place to craft.

### Gathering

The other half of the same question: what an hour in the open world is worth.
Set your kit under **Me → Your gathering** — the tool and whether it is
Avalonian, a tier per gear slot, the pie, the potion, what sort of node and how
good the cluster is — and the sheet shows what it comes to while you change it.

Two levers and they are not the same one. Your **tool** decides how long a
swing takes. Everything else decides how much a swing gives, which means
needing fewer swings rather than swinging faster. Only the gathering potion and
the destiny board touch the swing itself, and the two together are capped at
+40%.

Three details the game files settle and most calculators get wrong:

- **A plain tool gives no yield at all.** It has no passive slot. Only the
  Avalonian ones carry a bonus, and that bonus pays from T2 up.
- **Gatherer gear ramps and is hard tier-gated.** A little every 30 seconds up
  to ten stacks, so the number on the tooltip is what you have after five
  minutes — and a T5 set on a T6 node is worth exactly nothing.
- **You cannot aim at an enchanted node.** Every harvest is a roll on an
  ordinary one, so 999 T5.1 logs is twenty stacks of plain gathering with the
  plain ones kept aside, and 999 *plain* logs needs 1,058 harvests because a
  twentieth of them come up enchanted. Those enchanted ones are real money and
  the app counts them on their own line.

The **swing floor** is exact and comes out of the game's own tables. **Real
hours** are yours: node density, travel, competition and live respawn appear in
no dump anywhere, so the app asks you to time a ten-minute run and says the
hours are unknown until you have. It tells you the ceiling for that
measurement — ten minutes of nothing but swinging with the kit you have set —
so you can check your own count against it.

Node counts come as a range, where the file gives one. A static tree spawns on
one charge of five and fills up over time, so a stack of T5 logs is 212 trees if
you find every one full and 1,058 if every one is fresh. For 36 of the 216 node
rows the file gives no spawn count at all — the T7 and T8 statics say only that
it is randomised — and there the app shows one figure and says why, rather than
inventing the spread.

The respawn number in the file is a **tick**, not a return: on each one the node
rolls to regain `chargeupchance` charges, and that collapses with tier. T6, T7
and T8 all show the same 900 seconds, but a T2 tree refills before you have
walked away and a T8 tree puts back one log every four and three quarter hours.

**The kit is not free.** A pie lasts half an hour and a gathering potion under a
minute, so holding the bonuses through a two-hour run is four pies and 131
potions — charged against the profit, once you have timed a run. On T5 planks
that is a 29% haircut that used to be invisible.

**Best → Gather** ranks every resource at a tier by the best thing to do with
it, and tapping one lays out all five routes side by side: sell it, refine it,
transmute it a grade up, a tier up, or a grade up and then refine. Same pile,
same swings, same city, same tax, so the only difference between two rows is
the route. It ends with what the refining city and your focus are each worth on
the winner.

Two things no game file settles, so both are controls rather than silent
constants, and anything that depended on them says so:

- whether premium's advertised **+50% gathering yield** joins the pool or
  multiplies the total — no table in the files implements either;
- whether the gear and the Avalonian tool pay on an **enchanted** node — they
  name the plain resource type exactly, and an enchanted log is a different
  type. The pie and the board reach it either way.

### One assumption worth knowing

Animals list a favourite plant with a `favouritebonus` of 1 in the game files.
The app reads that as *the favourite is worth double nutrition*, so a chicken
eats 9 wheat instead of 18 of something else. The breakdown always shows the
plant count, so check it against your pasture once and turn **Feed animals
their favourite** off on Me if it does not match.

---

## How the maths works

**Counting.** A row is a number of **3×3 plots**, because that is the unit you
actually build and think in — one plot is nine tiles or nine animals. The game
data is per tile (3–6 crops, or 7–11 eggs from one bird), so the app multiplies
by nine and shows both numbers. Getting this wrong understates a farm ninefold,
which is exactly what it did before someone checked it against a real harvest:
four goose pastures return about 713 eggs a harvest here, against roughly 760
counted in game.

**Watering.** A tile costs 1,000 focus to water and the bonus only lands on
tiles you actually watered. The cycle works out the watering bill, asks the
focus ledger how much of it exists, and applies the bonus to that share — so a
farm larger than your focus can serve reports the blended seed return rather
than the one it would get if focus were free. Farming less often raises the
share, because each watering has more banked focus behind it.

**A plot of crops.** Seeds come back at the rate in the game files, and
watering adds its bonus on the share that was watered. Above 100% the plot pays for its own seed and
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

Set the cycle under **Me → Your cycle**: its length, how many of those
days you actually farm, and how much focus you start with.

Everything is priced **after market tax** on the sell side and at what you
actually pay on the buy side.

---

## Development

```bash
npm start      # http://localhost:8080/albion/
npm test       # 303 tests over the profit engine and the extracted data
npm run gamedata
```

`js/calc.js` is pure — game data and prices in, silver out, no storage or DOM.
Every figure on every screen comes from it, so no two screens can disagree.
`albion/tools/build_gamedata.py` is the only thing that knows about Albion's
file formats; the app only ever sees `data/gamedata.json`.

Your prices, plan and settings live in this browser's storage and nowhere else.
Back them up under **Me → Export backup**.
