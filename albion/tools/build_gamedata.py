#!/usr/bin/env python3
"""Build albion/data/gamedata.json from the official Albion binary dumps.

Everything the calculator treats as game truth comes from here, so after a
patch you re-run this rather than hand-editing numbers:

    python3 albion/tools/build_gamedata.py

Source: https://github.com/ao-data/ao-bin-dumps
  items.xml              plants, animals, recipes
  loot.xml               harvest yields
  gamedata.xml           focus constants, market tax
  craftingmodifiers.xml  city crafting bonuses
  farmingmodifiers.xml   city farming bonuses
  localization.xml       the real in-game item names (large: ~76 MB, cached)
  achievements.xml       destiny board nodes and their focus cost reductions
Stdlib only - no packages to install.
"""

import html
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, timezone, datetime
from pathlib import Path

BASE = "https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master"
HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
OUT = HERE.parent / "data" / "gamedata.json"
# Weapons and armour live in their own file. There are 6,600 of them against
# 400 farming recipes, and the farming screens never touch them, so loading
# them on startup would cost every user a megabyte to run a potion plan. The
# app fetches this one only when you open the Craft tab.
OUT_EQUIP = HERE.parent / "data" / "equipment.json"

LIVESTOCK = ["CHICKEN", "GOAT", "GOOSE", "SHEEP", "PIG", "COW"]
MOUNT_STOCK = ["OX", "HORSE", "DIREWOLF", "DIREBOAR", "DIREBEAR", "SWAMPDRAGON",
               "GIANTSTAG", "MAMMOTH", "COUGAR", "DRAKE"]

# Butchering is its own crafting category per species, one per livestock
# animal, and each is specialised in exactly one royal city. Without these
# the grown animal can only ever be sold whole, and every meat recipe in the
# game - stews, sandwiches, roasts - reads as buy-only.
MEAT_CATEGORIES = ("meat_chicken", "meat_goat", "meat_goose",
                   "meat_sheep", "meat_pig", "meat_cow")
CRAFT_CATEGORIES = ("potion", "food") + MEAT_CATEGORIES

# Everything you make at a warrior's forge, a mage's tower or a hunter's
# lodge. The craftingcategory doubles as the name of the city specialty, so
# these strings are what cityBonus already looks up.
WEAPON_CATEGORIES = (
    "sword", "axe", "mace", "hammer", "dagger", "spear", "quarterstaff",
    "bow", "crossbow", "knuckles", "firestaff", "froststaff", "arcanestaff",
    "holystaff", "naturestaff", "cursestaff", "shapeshifterstaff",
)
ARMOR_CATEGORIES = (
    "cloth_helmet", "cloth_armor", "cloth_shoes",
    "leather_helmet", "leather_armor", "leather_shoes",
    "plate_helmet", "plate_armor", "plate_shoes",
)
GEAR_CATEGORIES = ("offhand", "cape", "bag", "tools", "gatherergear")
# Refining is its own thing: a city specialises in it at +40% rather than the
# +15% it gives a crafting category, and a bar always eats one of the tier
# below as well as the raw ore.
REFINE_CATEGORIES = ("ore", "wood", "hide", "fiber", "rock")
EQUIP_CATEGORIES = WEAPON_CATEGORIES + ARMOR_CATEGORIES + GEAR_CATEGORIES
REFINE_BUTTON = "@CRAFTBUILDING_ITEM_DETAILS_BUTTON_REFINE"

# The five quality levels, in the order the game lists them. The names are
# not in the tables as a set - they are scattered through localization - so
# they are written here rather than half-guessed from an id.
QUALITY_NAMES = {
    "1": "Normal", "2": "Good", "3": "Outstanding",
    "4": "Excellent", "5": "Masterpiece",
}



def fetch(name: str) -> bytes:
    """Download a dump file once and cache it next to this script."""
    CACHE.mkdir(exist_ok=True)
    local = CACHE / name.replace("/", "_")
    if not local.exists():
        print(f"  downloading {name} ...", file=sys.stderr)
        with urllib.request.urlopen(f"{BASE}/{name}", timeout=300) as r:
            local.write_bytes(r.read())
    return local.read_bytes()


def parse(name: str) -> ET.Element:
    return ET.fromstring(fetch(name).decode("utf-8-sig"))


def load_names() -> dict:
    """The game's own English item names, e.g. T6_ALCOHOL -> 'Potato Schnapps'.

    localization.xml is tens of megabytes and mostly other languages, so this
    streams it and keeps only the first (EN-US) segment of the entries worth
    having: item names under their bare id, and destiny board titles under
    their full key. The board titles are what stop a node reading as
    "Craft Swords" when the game calls it "Sword Crafter".
    """
    names = {}
    key = None
    want_seg = False
    for raw in fetch("localization.xml").decode("utf-8-sig").splitlines():
        if 'tuid="@ITEMS_' in raw:
            m = re.search(r'tuid="@ITEMS_([^"]+)"', raw)
            key = m.group(1) if m else None
            want_seg = False
        elif 'tuid="@DESTINYBOARD_TITLE_' in raw:
            m = re.search(r'tuid="(@DESTINYBOARD_TITLE_[^"]+)"', raw)
            key = m.group(1) if m else None
            want_seg = False
        elif key and 'xml:lang="EN-US"' in raw:
            want_seg = True
        elif key and want_seg:
            m = re.search(r"<seg>(.*?)</seg>", raw)
            if m:
                names[key] = html.unescape(m.group(1)).strip()
                key, want_seg = None, False
    return names


NAMES_BY_ID = {}


def pretty(unique: str) -> str:
    """The item's name as it appears in game, falling back to its id."""
    if unique in NAMES_BY_ID:
        return NAMES_BY_ID[unique]
    # Enchanted variants share the base item's name.
    base = unique.split("@")[0]
    if base in NAMES_BY_ID:
        return NAMES_BY_ID[base]
    return unique.replace("FARM_", "").replace("_", " ").title()


def tier_of(unique: str) -> int:
    m = re.match(r"^T(\d+)_", unique)
    return int(m.group(1)) if m else 0


def loot_table(root: ET.Element) -> dict:
    """lootlist name -> {item, min, max} for its guaranteed drop."""
    out = {}
    for ll in root.iter():
        if ll.tag.lower() != "lootlist" or not ll.get("name"):
            continue
        for it in ll:
            if float(it.get("chance", 1) or 1) < 1:
                continue            # skip the stray worm
            amount = str(it.get("amount", "1"))
            lo, _, hi = amount.partition("-")
            out[ll.get("name")] = {
                "item": it.get("type"),
                "min": int(lo), "max": int(hi or lo),
            }
            break
    return out



# Cluster ids carry no names in the files; the comments above them do.
CITY_IDS = {
    "0000": ("thetford", "Thetford"),
    "1000": ("lymhurst", "Lymhurst"),
    "2000": ("bridgewatch", "Bridgewatch"),
    "3004": ("martlock", "Martlock"),
    "4000": ("fortsterling", "Fort Sterling"),
    "3003": ("caerleon", "Caerleon"),
    "5000": ("brecilien", "Brecilien"),
    "4300": ("arthurs", "Arthur's Rest"),
    "1012": ("merlyns", "Merlyn's Rest"),
    "0008": ("morganas", "Morgana's Rest"),
}


def _eaten(food, seconds: int) -> int:
    """Nutrition an animal actually consumes over a span of seconds."""
    if food is None:
        return 0
    per = float(food.get("secondspernutrition") or 0)
    if per <= 0:
        return int(float(food.get("nutritionmax") or 0))
    return int(round(seconds / per))


def build_item_values(items: ET.Element) -> callable:
    """What the game thinks each item is worth, for the station usage fee.

    The fee you pay a station owner is a rate per 100 nutrition, and the
    nutrition a craft burns is item value x 0.1125 x amount crafted. Most
    crafted goods - every potion and meal among them - publish no itemvalue, so
    it resolves through the recipe: the value of what goes in, divided by how
    many come out.

    That recursion is not a guess. Of the crafted items that DO publish an
    itemvalue, it reproduces 224 of them exactly, including all six tiers of
    meat and every tier of plank, metal bar, cloth and leather.
    """
    published, recipes = {}, {}
    for el in items.iter():
        uid = el.get("uniquename")
        if not uid:
            continue
        if el.get("itemvalue") is not None:
            published[uid] = float(el.get("itemvalue"))
        req = el.find("craftingrequirements")
        res = req.findall("craftresource") if req is not None else []
        if res:
            recipes[uid] = (
                float(req.get("amountcrafted", 1) or 1),
                [(c.get("uniquename"), float(c.get("count", 0))) for c in res],
            )

    memo, unknown = {}, set()

    def value(uid, seen=frozenset()):
        if uid in memo:
            return memo[uid]
        if uid in published:
            memo[uid] = published[uid]
            return memo[uid]
        if uid in recipes and uid not in seen:
            amount, inputs = recipes[uid]
            memo[uid] = sum(
                count * value(i, seen | {uid}) for i, count in inputs
            ) / (amount or 1)
            return memo[uid]
        unknown.add(uid)
        return 0.0

    value.unknown = unknown
    return value


def build_cities() -> list:
    """City crafting and farming bonuses, read from the game's own tables.

    Crafting: a flat base in the city and, importantly, ZERO on a private
    island - islandvalue is 0 throughout craftingmodifiers.xml. On top of that
    a city adds a percentage for each category it specialises in.

    Farming: a flat +10% yield for a handful of named crops, herbs and animal
    products. Every one of the 30 royal-city rows has islandvalue equal to
    value, so an island farms with the full bonus of the city it is bound to -
    and every island is bound to one. There is no such thing as a farm with no
    city behind it, so the island entry below is offered for crafting only.

    (The same file also holds 450 Outlands rows at value 2.0, islandvalue 0.0:
    the +200% guild territory farms. Those are keyed by biome and cluster
    quality rather than by city, and this app does not model them, so they are
    dropped here rather than silently mixed in with the city bonuses.)
    """
    craft_root = parse("craftingmodifiers.xml")
    farm_root = parse("farmingmodifiers.xml")

    craft = {}
    for loc in craft_root.findall("craftinglocation"):
        bonus = loc.find("craftingbonus")
        if bonus is None:
            continue                      # refining-only territory
        craft[loc.get("clusterid")] = {
            "base": round(float(bonus.get("value")) * 100, 2),
            "island": round(float(bonus.get("islandvalue", 0)) * 100, 2),
            "specialties": {
                m.get("name"): round(float(m.get("value")) * 100, 2)
                for m in loc.findall("craftingmodifier")
            },
        }

    farm = {}
    for loc in farm_root.findall("location"):
        farm[loc.get("clusterid")] = {
            m.get("farmable"): round(float(m.get("value")) * 100, 2)
            for m in loc.findall("farmingyieldmodifier")
        }

    out = []
    for cluster, (cid, name) in CITY_IDS.items():
        c = craft.get(cluster, {})
        out.append({
            "id": cid,
            "name": name,
            "cluster": cluster,
            "craftBase": c.get("base", 0),
            "craftSpecialties": c.get("specialties", {}),
            "farmBonus": farm.get(cluster, {}),
        })
    # Crafting at your own island's station earns no city bonus: islandvalue is
    # 0 for every craftingbonus in craftingmodifiers.xml. Farming is the other
    # way round, so this entry is never offered as a place to farm.
    out.append({
        "id": "island", "name": "My island station", "cluster": None,
        "craftOnly": True,
        "craftBase": 0, "craftSpecialties": {}, "farmBonus": {},
    })
    return out


# Destiny board branches this app cares about. Everything else on the board
# (weapons, armour, gathering) has no bearing on farming or brewing.
FOCUS_BRANCHES = ("FARM_CROPS", "FARM_HERBS", "FARM_ANIMALS",
                  "FARM_ALCHEMIST", "FARM_COOK")


def build_focus_nodes(prefixes=None) -> list:
    """Destiny board nodes that reduce focus cost, with what each one covers.

    Every node gives a fixed number of efficiency points per level to items
    matching its patterns. A specialisation gives a lot to its own item and a
    little to everything in its branch, so levelling one potion quietly makes
    every other potion cheaper too. Total efficiency for an item is the sum
    over every matching rule of level x bonus.
    """
    prefixes = prefixes or FOCUS_BRANCHES
    root = parse("achievements.xml")
    out = []
    for el in root.iter():
        nid = el.get("id")
        if not nid or not nid.startswith(prefixes):
            continue
        rewards = el.find("baserewards")
        if rewards is None:
            continue
        rules = []
        quality = []
        # Direct rewards only - a parent must not inherit its children's.
        for b in rewards.findall("bonus"):
            kind = b.get("type") or ""
            rule = {
                "bonus": float(b.get("bonus")),
                "minTier": int(b.get("mintier", 1)),
                "maxTier": int(b.get("maxtier", 8)),
                "patterns": [p.get("pattern") for p in b.findall("itempattern")],
            }
            if "focuscostreduction" in kind:
                rules.append(rule)
            # The same nodes carry a second kind of bonus, in the same shape
            # and matched the same way: quality points per level. The game
            # calls it "Quality increase per Item", and it is where the money
            # is on equipment - a masterpiece sells for a multiple of a plain
            # one.
            elif kind == "itemcraftquality":
                quality.append(rule)
        if not rules and not quality:
            continue
        parent = el.find(".//parentachievements/achievement")
        parent_id = parent.get("id") if parent is not None else None
        out.append({
            "id": nid,
            "name": node_name(nid),
            "branch": nid.split("_")[1] if "_" in nid else nid,
            "parentId": parent_id,
            "parent": parent_id,
            "rules": rules,
            **({"qualityRules": quality} if quality else {}),
        })
    # Deduplicate: the same node can appear as a template and an instance.
    seen = {}
    for n in out:
        seen.setdefault(n["id"], n)
    # A node is a mastery when its parent is outside this set - it is the top
    # of the tree we kept - and a specialisation when it hangs off one we
    # also kept. The weapon branches are three deep (Mage -> Arcane Staffs ->
    # Arcane Staff) where the farming ones are two, so this has to be read off
    # the tree rather than from a fixed list of roots.
    for n in seen.values():
        n["kind"] = "spec" if n.pop("parentId") in seen else "mastery"
    # And the branch it sits in is whatever it hangs off at the top. The
    # weapon branches are named things like CRAFT_SWORDS, which reads as
    # "SWORDS" if you take it apart by underscores, so the label is the root
    # node's own in-game title instead.
    for n in seen.values():
        root = n
        while root.get("parent") in seen:
            root = seen[root["parent"]]
        n["branchLabel"] = root["name"]
    return sorted(seen.values(),
                  key=lambda n: (n["branchLabel"], n["kind"] != "mastery", n["id"]))


def node_name(nid: str) -> str:
    """A readable label, e.g. FARM_HERBS_FOXGLOVE -> 'Foxglove'."""
    label = NAMES_BY_ID.get(f"@DESTINYBOARD_TITLE_{nid}")
    if label:
        return label
    body = nid.replace("FARM_", "", 1)
    for branch in ("CROPS_", "HERBS_", "ANIMALS_", "ALCHEMIST_", "COOK_"):
        if body.startswith(branch):
            return body[len(branch):].replace("_", " ").title()
    return body.replace("_", " ").title()


GROUP_OF = {}
for _c in WEAPON_CATEGORIES:
    GROUP_OF[_c] = "weapon"
for _c in ARMOR_CATEGORIES:
    GROUP_OF[_c] = "armor"
for _c in GEAR_CATEGORIES:
    GROUP_OF[_c] = "gear"
for _c in REFINE_CATEGORIES:
    GROUP_OF[_c] = "refined"


def build_equipment(items, item_value):
    """Weapons, armour, gear and the refining that feeds them.

    Kept apart from the farming file on size alone: 6,600 rows against 400.
    Everything here is shaped exactly like a farming recipe so the same engine
    costs both - the only extra fields are `group`, for which list the app
    files it under, and `refine`, because a refining bench pays a city's +40%
    specialty where a crafting bench pays +15%.
    """
    recipes = []
    meta = {}

    def register(unique, group):
        if unique and unique not in meta:
            meta[unique] = {
                "name": pretty(unique), "tier": tier_of(unique), "cat": group,
            }

    for el in items.iter():
        req = el.find("craftingrequirements")
        cat = el.get("craftingcategory")
        unique = el.get("uniquename")
        if req is None or not unique or "PROTOTYPE" in unique:
            continue
        if cat not in EQUIP_CATEGORIES + REFINE_CATEGORIES:
            continue
        group = GROUP_OF[cat]
        # The game labels a refining bench's button differently from a
        # crafting bench's, which is the only place the dumps say which of
        # the two a recipe belongs to.
        refine = req.get("craftbuttonlocaoverride") == REFINE_BUTTON

        def add(rid, rreq, enchant):
            inputs = []
            for c in rreq.findall("craftresource"):
                item = {"id": c.get("uniquename"), "count": int(c.get("count"))}
                # Artefacts. The game hands back no part of one however much
                # focus you spend, and on a T8 weapon the artefact is most of
                # the bill, so this flag is the difference between a plan that
                # works and one that is out by millions.
                if c.get("maxreturnamount") == "0":
                    item["noReturn"] = True
                inputs.append(item)
            if not inputs:
                return
            for i in inputs:
                register(i["id"], meta.get(i["id"], {}).get("cat", "material"))
            register(rid, group)
            amount = int(rreq.get("amountcrafted", 1))
            silver = int(float(rreq.get("silver", 0)))
            # Six thousand rows, so anything the app can work out for itself
            # is left out: the name and tier are in `items`, the group is in
            # `groups` keyed by category, and a field equal to its default is
            # not written at all. Reconstructed in js/equipment.js, which is
            # the only thing that reads this file.
            recipes.append({
                "id": rid,
                "category": cat,
                **({"enchant": enchant} if enchant else {}),
                **({"refine": True} if refine else {}),
                **({"amount": amount} if amount != 1 else {}),
                **({"silver": silver} if silver else {}),
                "focus": int(float(rreq.get("craftingfocus", 0))),
                "itemValue": round(
                    sum(i["count"] * item_value(i["id"]) for i in inputs)
                    / float(amount or 1), 2),
                "inputs": inputs,
            })

        add(unique, req, 0)
        # Equipment enchants to .4, one level further than a potion, and each
        # level swaps every material for its own enchanted version rather
        # than adding an extract on top.
        for ench in el.findall("./enchantments/enchantment"):
            ereq = ench.find("craftingrequirements")
            level = int(ench.get("enchantmentlevel", 0))
            if ereq is None or not level:
                continue
            add(f"{unique}@{level}", ereq, level)

    recipes.sort(key=lambda x: (GROUP_OF[x["category"]], x["category"],
                                tier_of(x["id"]), meta[x["id"]]["name"],
                                x.get("enchant", 0)))
    return recipes, meta


def main() -> None:
    print("Reading Albion dumps...", file=sys.stderr)
    global NAMES_BY_ID
    NAMES_BY_ID = load_names()
    print(f"  {len(NAMES_BY_ID)} item names loaded", file=sys.stderr)
    items = parse("items.xml")
    loot = loot_table(parse("loot.xml"))
    gd = parse("gamedata.xml")

    # --- the two constants the game actually publishes -------------------
    focus_el = gd.find(".//ActionFocus")
    focus_bonus = float(focus_el.find("CraftingEfficiency").get("bonus"))
    cost_const = float(focus_el.get("costreductionconstant"))

    taxes = {t.get("name"): float(t.get("value"))
             for t in gd.findall(".//MarketPlace/TaxValues/TaxFactor")}
    setup_fee = taxes.get("setupfee", 0.025)
    txn_tax = taxes.get("transactiontax", 0.08)

    cities = build_cities()
    focus_nodes = build_focus_nodes()
    item_value = build_item_values(items)

    simple = {s.get("uniquename"): s for s in items.findall(".//simpleitem")}
    farm_out = {
        u for u, s in simple.items()
        if s.get("resourcetype") in ("CROP", "HERB")
        or s.get("shopsubcategory1") in ("farm", "herbgarden", "pasture")
    }

    item_meta = {}

    def register(unique, category):
        if unique and unique not in item_meta:
            item_meta[unique] = {
                "name": pretty(unique), "tier": tier_of(unique), "cat": category,
            }

    # --- plants -----------------------------------------------------------
    plants = []
    for f in items.findall(".//farmableitem"):
        if f.get("kind") != "plant":
            continue
        harvest = f.find("harvest")
        seed = harvest.find("seed")
        drop = loot.get(harvest.get("lootlist"), {})
        crop = drop.get("item")
        is_herb = simple.get(crop, {}).get("resourcetype") == "HERB" \
            if crop in simple else "HERB" in (harvest.get("lootlist") or "")
        req = f.find("craftingrequirements")
        plants.append({
            "id": f.get("uniquename"),
            # Name a plant row by what it grows, not by its seed packet.
            "name": pretty(crop) if crop else pretty(f.get("uniquename")),
            "tier": int(f.get("tier")),
            "kind": "herb" if is_herb else "crop",
            # Which building it has to go in. The game keeps Farms, Herb
            # Gardens, Pastures and Kennels apart, and shopsubcategory1 is
            # where it says so, so take it from there rather than guessing
            # from whether a thing looks like a plant.
            "plot": f.get("shopsubcategory1") or "farm",
            "seedId": f.get("uniquename"),
            "cropId": crop,
            "seedNpc": int(float(req.get("silver", 0))) if req is not None else 0,
            "growSeconds": int(harvest.get("growtime")),
            "seedReturn": round(float(seed.get("chance")), 4),
            "wateredBonus": round(float(f.get("activefarmbonus", 0)), 4),
            "focusCost": int(float(f.get("activefarmfocuscost", 0))),
            # How many times focus may be spent on one growth, and how often.
            # Every plant is 1 per 22h growth; mounts allow up to 14.
            "maxCycles": int(f.get("activefarmmaxcycles", 1) or 1),
            "careSeconds": int(float(f.get("activefarmcyclelengthseconds", 0) or 0)),
            "yieldMin": drop.get("min", 3), "yieldMax": drop.get("max", 6),
        })
        register(f.get("uniquename"), "seed")
        register(crop, "herb" if is_herb else "crop")
    plants.sort(key=lambda p: (p["kind"], p["tier"]))

    # --- what animals eat -------------------------------------------------
    # Nutrition per item, by the category the item belongs to. Plants are a
    # flat 48 and meat a flat 52, but mount food is tiered from 8 to 59,049,
    # so "48 a plant" was only ever right for two of the four categories.
    feed_nutrition: dict[str, dict[str, int]] = {}
    for el in items.iter():
        cat = el.get("foodcategory")
        nut = el.get("nutrition")
        name = el.get("uniquename")
        if cat and nut and name:
            feed_nutrition.setdefault(cat, {})[name] = int(float(nut))

    # --- animals ----------------------------------------------------------
    grown_by_id = {
        f.get("uniquename"): f for f in items.findall(".//farmableitem")
        if f.get("kind") == "animal" and f.get("uniquename", "").endswith("_GROWN")
    }
    animals = []
    for f in items.findall(".//farmableitem"):
        u = f.get("uniquename") or ""
        if f.get("kind") != "animal" or not u.endswith("_BABY"):
            continue
        species = u.split("_FARM_")[1].rsplit("_BABY", 1)[0]
        if species not in LIVESTOCK and species not in MOUNT_STOCK:
            continue                      # event/faction animals
        grown_el = f.find("grownitem")
        if grown_el is None:
            continue
        req = f.find("craftingrequirements")
        food = f.find(".//food")
        accepted = f.find(".//acceptedfood")
        offspring = grown_el.find("offspring")

        grown_id = grown_el.get("uniquename")
        product = None
        g = grown_by_id.get(grown_id)
        if g is not None and g.find(".//product") is not None:
            p = g.find(".//product")
            drop = loot.get(p.get("lootlist"), {})
            if drop:
                product = {
                    "itemId": drop["item"], "min": drop["min"], "max": drop["max"],
                    "seconds": int(p.get("productiontime")),
                    # A grown animal keeps eating while it produces, and it
                    # eats at ITS rate, not the baby's: the grown bar empties
                    # exactly once per product. Reading the baby's
                    # secondspernutrition charged every egg half its feed.
                    "nutrition": _eaten(g.find(".//food"), int(p.get("productiontime"))),
                }
                register(drop["item"], "product")

        animals.append({
            "id": u,
            "name": pretty(grown_id),
            "tier": int(f.get("tier")),
            "kind": "livestock" if species in LIVESTOCK else "mount",
            # Pasture or Kennel, straight from the game rather than inferred:
            # horses and oxen live in a Pasture, the exotic mounts in a Kennel.
            "plot": f.get("shopsubcategory1") or "pasture",
            "babyId": u, "grownId": grown_id,
            "babyNpc": int(float(req.get("silver", 0))) if req is not None else 0,
            "growSeconds": int(grown_el.get("growtime")),
            "offspring": round(float(offspring.get("chance")), 4) if offspring is not None else 0,
            "wateredBonus": round(float(f.get("activefarmbonus", 0)), 4),
            "focusCost": int(float(f.get("activefarmfocuscost", 0))),
            # activefarmbonus is the bonus PER nurture and activefarmmaxcycles
            # caps how many nurtures one growth allows. A T8 ox takes six, and
            # only all six together bring its offspring above 1.0 - reading it
            # as a single nurture makes mounts look like a loss.
            "maxCycles": int(f.get("activefarmmaxcycles", 1) or 1),
            "careSeconds": int(float(f.get("activefarmcyclelengthseconds", 0) or 0)),
            # nutritionmax is the size of the food bar, not the food eaten. An
            # animal eats one nutrition every secondspernutrition for the whole
            # of growtime, refilling the bar once per nurture. For livestock the
            # two coincide; a T8 ox eats six bars' worth.
            "nutrition": int(float(food.get("nutritionmax"))) if food is not None else 0,
            "nutritionTotal": _eaten(food, int(grown_el.get("growtime"))),
            # What it will actually eat. The game refuses anything else
            # outright - "{0} does not eat {1}" - and a direwolf is not going
            # to eat wheat however cheap wheat is.
            "foodCategory": (accepted.get("foodcategory") or "plants")
                            if accepted is not None else "plants",
            "favouriteFood": accepted.get("favorite") if accepted is not None else None,
            "favouriteBonus": float(accepted.get("favoritebonus", 0)) if accepted is not None else 0,
            "product": product,
        })
        register(u, "baby")
        register(grown_id, "animal")
    animals.sort(key=lambda a: (a["kind"], a["tier"]))

    # --- recipes that consume something you farmed ------------------------
    # A grown animal is a farm output too: you butcher it for meat. It lives
    # in <farmableitem> rather than <simpleitem>, so it never reached the set
    # the filter below reads.
    farm_out |= {a["grownId"] for a in animals}

    candidates = []
    for el in items.iter():
        req = el.find("craftingrequirements")
        cat = el.get("craftingcategory")
        if req is None or cat not in CRAFT_CATEGORIES:
            continue
        unique = el.get("uniquename")
        if not unique or "PROTOTYPE" in unique:
            continue
        candidates.append((el, req, cat, unique))

    # An input counts as farmed if it comes off your own land, or if it is
    # itself something on this list that you could make. Bread is flour is
    # wheat. One pass kept the flour and threw away the bread the flour is
    # for, which took the whole sandwich and stew line with it, so this runs
    # to a fixpoint - it settles in two passes.
    reachable = set(farm_out)
    kept = set()
    changed = True
    while changed:
        changed = False
        for _el, req, _cat, unique in candidates:
            if unique in kept:
                continue
            if any(c.get("uniquename") in reachable
                   for c in req.findall("craftresource")):
                kept.add(unique)
                reachable.add(unique)
                changed = True

    recipes = []
    for el, req, cat, unique in candidates:
        if unique not in kept:
            continue

        def add_recipe(rid, rreq, enchant):   # noqa: C901 - reads top to bottom
            inputs = []
            for c in rreq.findall("craftresource"):
                item = {"id": c.get("uniquename"), "count": int(c.get("count"))}
                # The game marks the inputs its return rate must never touch:
                # artefacts, Avalonian energy, and the like. 0 is the only value
                # the dumps ever use, so it reads as a flag. Enchantment
                # materials carry no such mark and genuinely do come back.
                if c.get("maxreturnamount") == "0":
                    item["noReturn"] = True
                inputs.append(item)
            # Whether to keep this item was settled above, over the whole
            # list at once. An enchanted row is the base row's inputs plus
            # extract, so base and enchants always answer the same way.
            for i in inputs:
                register(i["id"], item_meta.get(i["id"], {}).get("cat", "material"))
            # Meat is an ingredient wherever it turns up again, so it is
            # filed with the materials rather than under its own butchering
            # category, which would otherwise depend on iteration order.
            register(rid, "material" if cat in MEAT_CATEGORIES else cat)
            recipes.append({
                "id": rid,
                "name": pretty(rid),
                "tier": tier_of(rid),
                # 0 for a plain item, 1-3 for the enchanted versions the game
                # writes as T6.1, T6.2 and T6.3.
                "enchant": enchant,
                "category": cat,
                # Butchering hands back meat rather than the animal, which is
                # the game's own flag on exactly these six recipes.
                **({"returnProduct": True}
                   if rreq.get("returnproductnotresource") == "true" else {}),
                "amount": int(rreq.get("amountcrafted", 1)),
                "focus": int(float(rreq.get("craftingfocus", 0))),
                "silver": int(float(rreq.get("silver", 0))),
                # What the station charges for is nutrition, and nutrition is
                # item value. A potion publishes none, so it is the value of
                # its ingredients spread over the batch.
                "itemValue": round(
                    sum(i["count"] * item_value(i["id"]) for i in inputs)
                    / float(rreq.get("amountcrafted", 1) or 1), 4),
                "inputs": inputs,
            })

        add_recipe(unique, req, 0)
        # The enchanted versions are separate recipes on the same item: the
        # same ingredients plus alchemy extract, and a lot more focus. They
        # sell for a lot more too, so they are worth having in the list.
        for ench in el.findall("./enchantments/enchantment"):
            ereq = ench.find("craftingrequirements")
            level = int(ench.get("enchantmentlevel", 0))
            if ereq is None or not level:
                continue
            add_recipe(f"{unique}@{level}", ereq, level)

    recipes.sort(key=lambda x: (x["category"], x["name"], x["tier"], x["enchant"]))

    data = {
        "source": "ao-data/ao-bin-dumps (items.xml, loot.xml, gamedata.xml)",
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "constants": {
            # Straight out of gamedata.xml <ActionFocus>.
            "focusCraftBonus": round(focus_bonus * 100, 2),
            "focusCostConstant": cost_const,
            # Market tax straight out of gamedata.xml <MarketPlace>.
            # Premium halves the transaction tax; that halving is not in the
            # dumps, so the premium figure is community-sourced.
            "marketSetupFee": round(setup_fee * 100, 2),
            "marketTransactionTax": round(txn_tax * 100, 2),
            # Not published in the dumps. Editable in-app.
            "focusPerDay": 10000,
            "focusCap": 30000,
            # These two ARE published, as words rather than as numbers:
            # localization.xml carries "Double crop yield from farming" and
            # "Double farm animal growth rate" among Premium's store benefits.
            # That backs the crop yield per tile exactly. It does not cover
            # egg and milk quantity, which calc.js also scales by the yield
            # multiplier, nor does the growth string say anything about how
            # much an animal eats - so both stay editable rather than being
            # written into the engine as facts.
            "premiumYieldMultiplier": 2,
            "premiumGrowthMultiplier": 2,
            # What a character regenerates WITHOUT Premium is published
            # nowhere. Zero is a placeholder, not a game fact.
            "focusPerDayNoPremium": 0,
            # The station usage fee, from gamedata.xml. The owner sets a rate
            # per 100 nutrition (capped at maxUsageFee); the game turns a craft
            # into nutrition with itemValueToNutrition, and waives it below
            # freeCraftingMaxTier.
            "itemValueToNutrition": float(
                gd.find(".//ItemValueToNutrition").get("factor")),
            "freeCraftingMaxTier": int(gd.find(".//FreeCrafting").get("maxTier")),
            "maxUsageFee": int(gd.find(".//BuildingManagement").get("maxuseagefee")),
            # Crafting with focus adds this many quality points, from the same
            # <ActionFocus> block as the crafting efficiency bonus.
            "focusQualityBonus": float(
                gd.find(".//ActionFocus/CraftingQuality").get("bonus")),
        },
        # What comes off the bench, before any bonus. Five levels, and the
        # weights are out of a thousand: 689 plain, 250 good, 50 outstanding,
        # 10 excellent, 1 masterpiece.
        "quality": {
            "weights": {
                q.get("level"): float(q.get("weight"))
                for q in gd.findall(".//CraftingQualityChances/QualityLevel")
            },
            # Item power, not price - kept because it is the only thing the
            # dumps say a quality level DOES, and it is what makes the higher
            # ones worth more.
            "itemPowerBonus": {
                q.get("level"): float(q.get("itempowerbonus"))
                for q in gd.findall(".//QualityLevels/qualitylevel")
            },
            "names": QUALITY_NAMES,
        },
        "cities": cities,
        "focusNodes": focus_nodes,
        "plants": plants,
        "animals": animals,
        "recipes": recipes,
        # What you are allowed to put in the trough, per category, with the
        # nutrition each item carries. Restricted to the three categories the
        # app's animals actually accept and to items it already knows about,
        # so the picker never offers a chocolate egg from a 2020 event.
        "feeds": {
            cat: {i: n for i, n in sorted(feed_nutrition.get(cat, {}).items())
                  if i in item_meta}
            for cat in ("plants", "meat", "mount")
        },
        "items": item_meta,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=1))
    print(f"\nWrote {OUT.relative_to(HERE.parent.parent)}")

    # --- weapons, armour and refining, in their own file ------------------
    equip_recipes, equip_items = build_equipment(items, item_value)
    equip_nodes = build_focus_nodes(("CRAFT_",))
    equip = {
        "source": OUT.name + " companion (items.xml, achievements.xml)",
        "generated": data["generated"],
        "recipes": equip_recipes,
        # Which list a category belongs under, so 6,600 rows do not each
        # carry the same word.
        "groups": GROUP_OF,
        # The weapon, armour and refining half of the destiny board. It rides
        # with the recipes rather than with the farming file for the same
        # reason they do: 317 nodes nobody brewing a potion will ever open.
        "focusNodes": equip_nodes,
        "items": equip_items,
    }
    # No separator spaces: at six thousand rows that alone is 300 KB over the
    # wire, and nobody reads this file by hand.
    OUT_EQUIP.write_text(json.dumps(equip, separators=(",", ":")))
    print(f"Wrote {OUT_EQUIP.relative_to(HERE.parent.parent)}")
    if item_value.unknown:
        print(f"  {len(item_value.unknown)} items have no value and no recipe",
              file=sys.stderr)
    print(f"  {len(plants)} plants, {len(animals)} animals, "
          f"{len(recipes)} recipes, {len(item_meta)} items")
    print(f"  focus crafting bonus +{data['constants']['focusCraftBonus']}% "
          f"(from gamedata.xml)")
    print(f"  {len(cities)} crafting/farming locations (from craftingmodifiers.xml "
          f"+ farmingmodifiers.xml)")
    print(f"  {len(focus_nodes)} destiny board focus nodes (from achievements.xml)")
    kb = OUT_EQUIP.stat().st_size / 1024
    print(f"  {len(equip_recipes)} weapon/armour/refining recipes, "
          f"{len(equip_items)} items, {len(equip_nodes)} craft board nodes "
          f"({kb:.0f} KB, loaded only when the Craft tab is opened)")


if __name__ == "__main__":
    main()
