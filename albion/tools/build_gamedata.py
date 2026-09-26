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
  harvestables.xml       what a node gives and how long a swing takes
  spells.xml             the gathering bonuses gear, tools, pies and potions give
Stdlib only - no packages to install.
"""

import html
import json
import math
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
# A <mount> carries no craftingcategory at all, and no city specialises in
# saddlery, so mounts get a category of their own here: base +18 everywhere,
# nothing extra anywhere. What a saddler recipe eats is the grown animal in
# full (maxreturnamount="0" on every one of the 45) plus leather, planks, or
# cloth and bars that come back at the return rate.
MOUNT_CATEGORY = "mount"
REFINE_BUTTON = "@CRAFTBUILDING_ITEM_DETAILS_BUTTON_REFINE"
# The other button on a resource. Transmuting takes one raw and hands back one
# raw a tier higher or an enchant higher, for silver and no focus, and it never
# gives the input back. 191 of them, which is the whole 2-D lattice: every raw
# from T5 up can climb a tier, and every enchanted raw can climb either way.
TRANSMUTE_BUTTON = "@CRAFTBUILDING_ITEM_DETAILS_BUTTON_TRANSMUTE"

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


def enchant_of(unique: str) -> int:
    """The enchant level the game writes into a resource's own name."""
    m = re.search(r"_LEVEL(\d)$", unique or "")
    return int(m.group(1)) if m else 0


def via_of(inputs, out: str) -> str:
    """Which way a transmutation climbs: a tier, or an enchant level."""
    src = (inputs[0] or {}).get("id", "") if inputs else ""
    return "tier" if tier_of(src) < tier_of(out) else "enchant"


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

    Refining also happens outside the cities: 130 of the 140 craftinglocation
    rows carry a <refiningbonus> and no <craftingbonus> at all - 100 at 0.10
    (Roads of Avalon rests) and 30 at 0.15 (Outlands stations), keyed by biome
    and cluster quality rather than by a city anybody can name. They are not
    offered as places to craft here because the picker would grow from eleven
    rows to a hundred and forty and each one would need a name the game does
    not give it. The ten that ARE named carry their real refining figure.

    The same file also holds 450 Outlands rows at value 2.0, islandvalue 0.0:
    guild territory farming, at twenty times the royal cities' +10%. They are
    keyed by biome and cluster quality rather than by city - but all thirty of
    those combinations carry the SAME fifteen seeds at the same 2.0, so the
    whole block collapses to one entry rather than thirty. It is offered as a
    place to farm and not as a place to craft, and it covers plants only: no
    _GROWN animal appears in the list, so eggs and milk earn nothing there.
    """
    craft_root = parse("craftingmodifiers.xml")
    farm_root = parse("farmingmodifiers.xml")

    craft = {}
    for loc in craft_root.findall("craftinglocation"):
        bonus = loc.find("craftingbonus")
        # A refining bench and a crafting bench are two different numbers, and
        # the file says so: every one of the 140 locations carries a
        # <refiningbonus> while only 10 carry a <craftingbonus>. In the five
        # royal cities, Caerleon and Brecilien the two agree at 18; in the
        # three Rests they do NOT - crafting 18, refining 15 - so reading the
        # crafting figure for a refine is simply wrong there.
        refine = loc.find("refiningbonus")
        if bonus is None and refine is None:
            continue
        craft[loc.get("clusterid")] = {
            "base": round(float(bonus.get("value")) * 100, 2) if bonus is not None else None,
            "refineBase": (round(float(refine.get("value")) * 100, 2)
                           if refine is not None else None),
            "island": round(float(bonus.get("islandvalue", 0)) * 100, 2)
            if bonus is not None else 0,
            "specialties": {
                m.get("name"): round(float(m.get("value")) * 100, 2)
                for m in loc.findall("craftingmodifier")
            },
        }

    farm = {}
    outlands = {}
    outlands_island = {}
    for loc in farm_root.findall("location"):
        mods = {m.get("farmable"): round(float(m.get("value")) * 100, 2)
                for m in loc.findall("farmingyieldmodifier")}
        cluster = loc.get("clusterid")
        if cluster is not None:
            farm[cluster] = mods
            continue
        # A guild territory: keyed by biome and cluster quality instead. Every
        # one of the thirty combinations is identical, so they fold into one -
        # and the build refuses rather than guesses if a patch ever makes them
        # disagree, because then "the Outlands" stops being one answer.
        if outlands and outlands != mods:
            raise SystemExit("Outlands farming bonuses are no longer uniform")
        outlands = mods
        outlands_island = {m.get("farmable"): round(float(m.get("islandvalue", 0)) * 100, 2)
                           for m in loc.findall("farmingyieldmodifier")}

    out = []
    for cluster, (cid, name) in CITY_IDS.items():
        c = craft.get(cluster, {})
        out.append({
            "id": cid,
            "name": name,
            "cluster": cluster,
            "craftBase": c.get("base") or 0,
            # What a refining bench gives here, which is not always what a
            # crafting bench gives. Read by cityBonus for any recipe flagged
            # `refine`, and equal to craftBase everywhere but the Rests.
            "refineBase": c.get("refineBase") if c.get("refineBase") is not None
            else (c.get("base") or 0),
            "craftSpecialties": c.get("specialties", {}),
            "farmBonus": farm.get(cluster, {}),
        })
    # Guild territory in the Outlands. Twenty times a royal city's bonus on the
    # fifteen crops and herbs it covers, nothing at all on animals, and - the
    # part that catches people - nothing on an island out there either, where
    # a royal island farms with its city's full bonus.
    if outlands:
        out.append({
            "id": "outlands", "name": "Guild territory (Outlands)", "cluster": None,
            "farmOnly": True,
            "craftBase": 0, "refineBase": 0, "craftSpecialties": {},
            "farmBonus": outlands,
            "farmIslandBonus": outlands_island,
        })
    # Crafting at your own island's station earns no city bonus: islandvalue is
    # 0 for every craftingbonus in craftingmodifiers.xml. Farming is the other
    # way round, so this entry is never offered as a place to farm.
    out.append({
        "id": "island", "name": "My island station", "cluster": None,
        "craftOnly": True,
        # islandvalue is 0 on every craftingbonus AND every refiningbonus, so
        # refining at home earns the base rate and nothing else.
        "craftBase": 0, "refineBase": 0, "craftSpecialties": {}, "farmBonus": {},
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
GROUP_OF[MOUNT_CATEGORY] = "mount"


# =========================================================== gathering ====

# The five families you can gather, as the game spells them.
FAMILIES = ("WOOD", "ORE", "FIBER", "HIDE", "ROCK")

# Which node types are worth offering as a place to gather, and what to call
# them. The dumps carry 89 harvestables; the rest are silver piles, loot
# chests and a dead rat. WOOD_DYNAMIC is left out on purpose: every number on
# it is identical to the static node, so it would be a choice that changes
# nothing.
NODE_KINDS = [
    ("static", "", "Static node"),
    ("critter", "_CRITTER", "Living resource"),
    ("roads", "_CRITTER_ROADS", "Roads critter"),
    ("roadsVeteran", "_CRITTER_ROADS_VETERAN", "Roads critter, veteran"),
    ("roadsElite", "_CRITTER_ROADS_ELITE", "Roads critter, elite"),
    ("treasure", "_TREASURE", "Resource treasure"),
    ("guardian", "_GUARDIAN", "Guardian"),
    ("miniguardian", "_MINIGUARDIAN", "Mini guardian"),
    # The Roads have their own guardians, and they are the only ones above T6:
    # the open-world pair exists at T6 and nowhere else, while these run T6 to
    # T8 in every family. Leaving them out meant the two richest nodes in the
    # game were missing from a screen whose whole job is to rank nodes.
    ("guardianRoads", "_GUARDIAN_ROADS", "Roads guardian"),
    ("miniguardianRoads", "_MINIGUARDIAN_ROADS", "Roads mini guardian"),
    ("giant", "_GIANTTREE", "Giant tree"),
]


def _tier_rows(harv, name):
    """One harvestable's tiers, as plain numbers.

    A node is a stack of charges. Each Charge row covers a range of charge
    levels and says what one of them gives, a harvest takes
    maxchargesperharvest of them at once, and the node starts life at
    startcharges and slowly charges up towards the top.

    Nearly every node in the game has one yielding Charge row and so is
    described by a single number. The giant tree is not: its first charge
    gives three logs and the nine above it give one each, which reading only
    the first row turned into "one charge worth three". So the rows are summed
    rather than sampled, and what comes out is the two figures the engine
    actually wants - what one swing gives, and how many swings a full node
    holds - which reproduce the simple case exactly and get the giant tree
    right as well.
    """
    for h in harv.findall("Harvestable"):
        if h.get("name") != name:
            continue
        out = {}
        for t in h.findall("Tier"):
            charges = [c for c in t.findall("Charge") if c.get("yield")]
            if not charges:
                continue
            top = 0
            total = 0
            for c in charges:
                lo, _, hi = (c.get("level") or "0").partition("-")
                lo = int(lo)
                hi = int(hi or lo)
                top = max(top, hi)
                total += (hi - lo + 1) * int(c.get("yield"))
            per_harvest = int(t.get("maxchargesperharvest", 1))
            swings = max(1, math.ceil(top / per_harvest))
            row = {
                "seconds": float(t.get("harvesttimeseconds")),
                # What one swing gives at the bare node, before any bonus.
                "yield": round(total / swings, 4),
                # How many swings a full node holds, and what it holds in all.
                "charges": swings,
                "perNode": total,
                "perHarvest": per_harvest,
            }
            # What a node holds when you walk up to it - only where the file
            # actually says. An absent attribute is not a 1: hide never carries
            # one at any tier, nor do the roads critters at T4-T6, and
            # defaulting it had the app announcing "starts at 1 charge of 30"
            # about a hide treasure the file is silent on.
            if t.get("startcharges") is not None:
                row["startCharges"] = int(t.get("startcharges"))
            # T7 and T8 statics say only that the spawn count is randomised.
            # They do not say over what spread, so the app must not name one.
            if t.get("randomizespawncharges") == "true":
                row["randomCharges"] = True
            respawn = int(float(t.get("respawntimeseconds") or 0))
            if respawn:
                row["respawn"] = respawn
            # And what actually happens on each of those ticks, which is not
            # "the node is back". It is a roll for ONE charge, and the odds
            # collapse with tier: a T2 tree gains 2.7 charges a tick and is
            # full again in one, while a T8 tree gains 0.0537 of one - a single
            # log every four and three quarter hours. Reporting the tick as the
            # respawn made the slowest node in the game look like the quickest.
            chargeup = float(t.get("chargeupchance") or 0)
            if chargeup > 0:
                row["chargeUp"] = chargeup
            rare = sorted(int(c.get("state")) for c in t.findall("RareState"))
            if rare:
                row["rare"] = rare
            if t.get("requirestool") == "false":
                row["noTool"] = True
                row["noToolFactor"] = float(t.get("notooltimefactor") or 1)
            out[t.get("tier")] = row
        return out
    return {}


def build_harvestables():
    """What one swing at a node gives, and how long the swing takes.

    This is the half of "how long does a stack take" that the game does
    publish: seconds per charge, resources per charge, how many charges a
    node holds, how long it takes to come back, and which enchanted grades it
    can roll. What is NOT here, anywhere in any dump, is how many nodes there
    are per map or how far apart they sit - so the app asks you to time a run
    rather than inventing a number.

    Shape is family then kind then tier, all the way down, even though most
    kinds are the same in every family. The exceptions are real - hide is
    quicker to skin at the low tiers, and a rock treasure cannot roll a
    pristine node because pristine rock does not exist - and a table that is
    uniform is a table nothing has to special-case.
    """
    harv = parse("harvestables.xml")
    nodes = {}
    for family in FAMILIES:
        kinds = {}
        for key, suffix, _label in NODE_KINDS:
            rows = _tier_rows(harv, family + suffix)
            if rows:
                kinds[key] = rows
        nodes[family] = kinds

    # How much a tool above the resource's own tier cuts the swing. The same
    # table on every family, and below -1 the game refuses to harvest at all.
    factors = {}
    for h in harv.findall("Harvestable"):
        mod = h.find("ToolModifier")
        if mod is None:
            continue
        for m in mod.findall("Modifier"):
            factors[m.get("tierdifference")] = float(m.get("timefactor"))
        break
    labels = {key: label for key, _suffix, label in NODE_KINDS}
    return nodes, labels, factors


def _spell_index(root):
    """Every spell by name, so a passive can be followed to its effect."""
    return {el.get("uniquename"): el for el in root.iter()
            if el.get("uniquename")}


def build_gather_buffs(spells):
    """The gathering bonus stack, from the spells the items point at.

    Every source writes into one engine number, GatheringYield, and each
    declares a plain value, so they add. Three of them are not what a player
    expects and the numbers say so plainly:

      - a plain gathering tool gives no yield at all (it has no passive
        slot); only the Avalonian ones carry one,
      - gatherer gear is a charge-accumulating buff, a little every 30
        seconds up to ten stacks, so the figure on the tooltip only exists
        after five minutes of wearing it,
      - and every one of them is tier-gated, so a T5 set on a T6 node is
        worth exactly nothing.
    """
    idx = _spell_index(spells)

    def buff_over_time(name):
        el = idx.get(name)
        if el is None:
            return None
        b = el.find("resourcegatheringbuffovertime")
        if b is None:
            return None
        return {
            "perCharge": float(b.get("value")),
            "minTier": int(b.get("mintier", 2)),
            "maxTier": int(b.get("maxtier", 8)),
            "maxCharges": int(el.get("maxcharges", 1)),
        }

    # head and shoes are named for their slot; the chest piece is not.
    SLOTS = {"head": "PASSIVE_HEAD_YIELD_{f}_EFFECT_T{t}",
             "armor": "PASSIVE_YIELD_{f}_EFFECT_T{t}",
             "shoes": "PASSIVE_SHOES_YIELD_{f}_EFFECT_T{t}"}
    gear = {}
    interval = None
    for slot, pattern in SLOTS.items():
        per_tier = {}
        for tier in range(4, 9):
            rows = {f: buff_over_time(pattern.format(f=f, t=tier)) for f in FAMILIES}
            have = [r for r in rows.values() if r]
            if not have:
                continue
            if len({json.dumps(r, sort_keys=True) for r in have}) > 1:
                raise SystemExit(f"gatherer {slot} T{tier} differs between families")
            per_tier[str(tier)] = have[0]
        gear[slot] = per_tier
    for f in FAMILIES:
        el = idx.get(f"PASSIVE_HEAD_YIELD_{f}_T5")
        pulse = el.find("pulsingspellpassive") if el is not None else None
        if pulse is not None:
            interval = float(pulse.get("interval"))
            break

    # The Avalonian tool's flat yield, which a plain tool does not have.
    tool = {}
    tool_min = None
    for tier in range(4, 9):
        rows = {}
        for f in FAMILIES:
            el = idx.get(f"PASSIVE_AVALON_YIELD_{f}_T{tier}")
            if el is None:
                continue
            covers = [int(b.get("tier")) for b in el.findall("resourcegatheringbuff")
                      if b.get("bufftype") == "gatheringyield"]
            if covers:
                # It names every tier it pays on, one row each, and the floor
                # is the same everywhere: a T1 node gets nothing from any tool.
                tool_min = min(covers) if tool_min is None else min(tool_min, min(covers))
            for b in el.findall("resourcegatheringbuff"):
                if b.get("bufftype") == "gatheringyield" and b.get("tier") == str(tier):
                    rows[f] = float(b.get("value"))
        if rows:
            if len(set(rows.values())) > 1:
                raise SystemExit(f"avalon tool T{tier} differs between families")
            tool[str(tier)] = next(iter(rows.values()))

    def consumable(spell_name):
        el = idx.get(spell_name)
        if el is None:
            return None
        out = {"seconds": 0}
        for b in el.findall("buffovertime"):
            kind = b.get("type")
            if kind in ("gatheringyield", "maxloadbonus", "gatheringspeed"):
                out[kind] = float(b.get("value"))
                out["seconds"] = max(out["seconds"], float(b.get("time") or 0))
        return out if len(out) > 1 else None

    return gear, interval, tool, tool_min or 2, consumable


def build_gather_food(items, consumable):
    """The pies, and what each grade of them is worth.

    A pie is the one source with no resource filter on it at all, so it
    applies to every family and to enchanted raws as well. The omelette is
    deliberately absent: it is a cast-speed food and does nothing here.
    """
    out = {}
    for el in items.iter("consumableitem"):
        unique = el.get("uniquename") or ""
        base = el.get("consumespell") or ""
        if not base.startswith(("FOOD_LOAD_GATHER", "FOOD_FISH_LOAD_GATHER")):
            continue
        ladder = {}
        row = consumable(base)
        if row:
            ladder["0"] = row
        for ench in el.findall("./enchantments/enchantment"):
            spell = ench.get("consumespell")
            row = consumable(spell) if spell else None
            if row:
                ladder[ench.get("enchantmentlevel")] = row
        if ladder:
            out[unique] = {"name": pretty(unique), "tier": tier_of(unique),
                           "grades": ladder}
    return out


def build_gather_potions(items, consumable):
    """The gathering potion: a lot of speed and a little yield, for a minute."""
    out = {}
    for el in items.iter("consumableitem"):
        unique = el.get("uniquename") or ""
        base = el.get("consumespell") or ""
        if not base.startswith("POTION_GATHER"):
            continue
        ladder = {}
        row = consumable(base)
        if row:
            ladder["0"] = row
        for ench in el.findall("./enchantments/enchantment"):
            spell = ench.get("consumespell")
            row = consumable(spell) if spell else None
            if row:
                ladder[ench.get("enchantmentlevel")] = row
        if ladder:
            out[unique] = {"name": pretty(unique), "tier": tier_of(unique),
                           "grades": ladder}
    return out


def build_gather_board():
    """The gathering half of the destiny board.

    Deliberately not merged into focusNodes. Those nodes answer "what does a
    craft cost in focus"; these answer "how much does a swing give", they are
    matched by resource family rather than by item id, and mixing the two
    would have a gatherer's levels quietly cheapening a potion.
    """
    root = parse("achievements.xml")
    out = []
    for el in root.iter():
        nid = el.get("id") or ""
        if not re.fullmatch(r"GATHER_(%s)_T\d" % "|".join(FAMILIES), nid):
            continue
        family = nid.split("_")[1]
        tier = int(nid[-1])
        yield_per = speed_per = 0.0
        for b in el.iter("bonus"):
            if b.get("type") != "resourcegatherbonus":
                continue
            if not any(p.get("pattern", "").startswith(family)
                       for p in b.findall("resourcepattern")):
                continue
            if b.get("bufftype") == "gatheringyield":
                yield_per = max(yield_per, float(b.get("bonus")))
            elif b.get("bufftype") == "gatheringspeed":
                speed_per = max(speed_per, float(b.get("bonus")))
        if not yield_per and not speed_per:
            continue
        title = el.find("title")
        key = title.get("tag") if title is not None else None
        out.append({
            "id": nid,
            "name": NAMES_BY_ID.get(key, f"{family.title()} Gatherer T{tier}"),
            "family": family,
            "tier": tier,
            "yieldPerLevel": yield_per,
            "speedPerLevel": speed_per,
            "maxLevel": 100,
        })
    out.sort(key=lambda x: (x["family"], x["tier"]))
    return out


def build_gather_raws(items):
    """The gatherable resources themselves: what each is worth in fame, and
    what it weighs, which is what decides how many trips a stack takes."""
    out = {}
    for el in items.iter("simpleitem"):
        unique = el.get("uniquename") or ""
        family = (el.get("resourcetype") or "").split("_LEVEL")[0]
        if family not in FAMILIES or not re.match(r"^T\d_", unique):
            continue
        row = {}
        fame = float(el.get("famevalue") or 0)
        weight = float(el.get("weight") or 0)
        if fame:
            row["fame"] = fame
        if weight:
            row["weight"] = weight
        if row:
            out[unique] = row
    return out


def build_gather_journals(items, raws):
    """Gathering journals: the silver a run earns that is not the resources.

    You buy a journal empty at a station, it fills with the gathering fame you
    were earning anyway, and a full one sells. The whole economy is published:
    `craftingrequirements/@silver` is what the station charges, `@maxfame` is
    the capacity, and `famefillingmissions/gatherfame/@mintier` says which
    tiers count towards it.

    Two things the file makes you look twice at. The journal families are named
    for the profession and the resources are named for the material, so the
    stone journal's loot is T4_ROCK - the id the rest of the app uses - and the
    two words have to be mapped rather than assumed equal. And an empty journal
    and a full one are not `uniquename`s here at all: the file keys the base and
    localization.xml carries the two states, which IS how the market lists them,
    so both ids are emitted for pricing.

    Every number is identical across the five families at a given tier; only
    the loot list differs, and the build asserts that rather than trusting it.
    """
    FAMILY_WORD = {"WOOD": "WOOD", "ORE": "ORE", "ROCK": "STONE",
                   "FIBER": "FIBER", "HIDE": "HIDE"}
    by_tier = {}
    for tier in range(2, 9):
        seen = {}
        for family, word in FAMILY_WORD.items():
            el = next((j for j in items.iter("journalitem")
                       if j.get("uniquename") == f"T{tier}_JOURNAL_{word}"), None)
            if el is None:
                raise SystemExit(f"no T{tier}_JOURNAL_{word} in items.xml")
            gf = el.find("famefillingmissions/gatherfame")
            req = el.find("craftingrequirements")
            if gf is None or req is None:
                raise SystemExit(f"T{tier}_JOURNAL_{word} lost its fame or its price")
            if int(gf.get("mintier")) != tier:
                raise SystemExit(f"T{tier}_JOURNAL_{word} fills from tier {gf.get('mintier')}")
            seen[family] = {
                # What it holds, and the other fame number the file carries.
                # Which of the two actually fills the book is not settled here:
                # maxfame is the one that names a capacity and is exactly 1.5x
                # the mission value at every single tier, so that is what the
                # app counts with, out loud.
                "fame": float(el.get("maxfame")),
                "missionFame": float(gf.get("value")),
                # A station price, like a seed's. Not a market quote.
                "silver": int(float(req.get("silver", 0))),
                "weight": float(el.get("weight") or 0),
            }
            for loot in el.findall("lootlist/loot"):
                name = loot.get("itemname")
                if name not in raws:
                    raise SystemExit(f"T{tier}_JOURNAL_{word} loots unknown {name}")
        first = next(iter(seen.values()))
        if any(row != first for row in seen.values()):
            raise SystemExit(f"T{tier} journals differ between families: {seen}")
        by_tier[str(tier)] = first
    return {
        "tiers": by_tier,
        # family -> the word the journal is filed under, for building the id.
        "words": FAMILY_WORD,
    }


def journal_items():
    """The 70 ids a market will actually quote, with the names it shows them by.

    An empty journal and a full one are the two things that change hands, and
    neither is a `uniquename` in items.xml - the file keys the base book and
    localization.xml carries the two states. That is also how the market lists
    them, so these are the ids the app has to price, and they need names or
    every price row would read as a raw id.
    """
    out = {}
    for tier in range(2, 9):
        for word in ("WOOD", "ORE", "STONE", "FIBER", "HIDE"):
            for state in ("EMPTY", "FULL"):
                unique = f"T{tier}_JOURNAL_{word}_{state}"
                name = NAMES_BY_ID.get(unique)
                if not name:
                    raise SystemExit(f"localization has no name for {unique}")
                out[unique] = {"name": name, "tier": tier, "cat": "journal"}
    return out


def build_gathering(gd, items, spells):
    """Everything the app needs to cost an hour in the open world."""
    raws = build_gather_raws(items)
    nodes, kind_labels, factors = build_harvestables()
    gear, interval, tool, tool_min, consumable = build_gather_buffs(spells)

    # How often a node is enchanted, as weights out of the cluster's total.
    # The axis is the Outlands cluster quality, and the whole royal continent
    # falls through to the default row - so a royal zone and the worst
    # Outlands zone roll the same odds.
    rare = {}
    block = gd.find(".//RareResources")
    for cluster in (block.findall("cluster") if block is not None else []):
        key = (f"outlands{cluster.get('ClusterQuality')}"
               if cluster.get("ContinentType") == "Outlands" else "royal")
        weights = {int(r.get("state")): float(r.get("weight"))
                   for r in cluster.findall("RareState")}
        total = sum(weights.values()) or 1
        rare[key] = [round(weights.get(i, 0) / total, 6) for i in range(5)]

    # Gathering speed is capped by the attribute table; yield has no row at
    # all there, which is the file saying it is uncapped.
    cap = 0.4
    for a in gd.iter("attribute"):
        if a.get("name") == "GatheringSpeed" and a.get("max") not in (None, "unrestricted"):
            cap = float(a.get("max"))

    fame = {}
    for b in gd.iter("ClusterDangerBonus"):
        factor = float(b.get("gatheringfamefactor") or 1)
        if factor != 1 or b.get("type") in ("safe", "yellow", "orange", "red", "black"):
            fame[b.get("type")] = factor

    return {
        "families": list(FAMILIES),
        "raws": raws,
        "journals": build_gather_journals(items, raws),
        "nodes": nodes,
        "kindLabels": kind_labels,
        "toolTimeFactor": factors,
        "gear": gear,
        "gearInterval": interval,
        "toolYield": tool,
        "toolYieldMinTier": tool_min,
        "food": build_gather_food(items, consumable),
        "potions": build_gather_potions(items, consumable),
        "board": build_gather_board(),
        "rareOdds": rare,
        "speedCap": cap,
        "fameFactor": fame,
        # The one number here that is not from a table. The client's own
        # store copy says "50% higher yield and Fame while gathering"; no
        # spell and no row in gamedata.xml implements it, so whether it adds
        # into the pool or multiplies the finished figure is not knowable
        # from the files, and the app says so where it shows it.
        "premiumYield": 0.5,
        "premiumYieldSource": "localization",
    }


def build_equipment(items, item_value, weights):
    """Weapons, armour, gear and the refining that feeds them.

    Kept apart from the farming file on size alone: 6,600 rows against 400.
    Everything here is shaped exactly like a farming recipe so the same engine
    costs both - the only extra fields are `group`, for which list the app
    files it under, and `refine`, because a refining bench pays a city's +40%
    specialty where a crafting bench pays +15%.
    """
    recipes = []
    meta = {}

    def register(unique, group, name=None):
        """Remember an item, and let a real group overwrite the fallback.

        Inputs are registered before outputs, with "material" standing in for
        "we do not know yet". Twelve refined items - T3..T8 planks and leather
        - are first seen as the inputs of a tool or a piece of gathering gear
        listed earlier in items.xml, so first-write-wins filed them as
        material while the other 23 came out refined. The Market screen groups
        by this field, which put Cedar Planks and Cedar Cloth in different
        sections of the same list.
        """
        if not unique:
            return
        at = meta.get(unique)
        if at is None:
            meta[unique] = {
                "name": name or pretty(unique), "tier": tier_of(unique), "cat": group,
                **({"weight": weights[unique]} if unique in weights else {}),
            }
        elif at.get("cat") == "material" and group != "material":
            at["cat"] = group

    for el in items.iter():
        reqs = el.findall("craftingrequirements")
        req = reqs[0] if reqs else None
        cat = el.get("craftingcategory")
        unique = el.get("uniquename")
        if req is None or not unique or "PROTOTYPE" in unique:
            continue
        if el.tag == "mount":
            # Only what a farmer can make: a saddler recipe that eats a grown
            # farm animal. That leaves out skins and upgrades (they eat a
            # finished mount), battle mounts and faction mounts (they eat a
            # GvG or faction token no market sells), and two hidden test rows.
            ins = [c.get("uniquename") or "" for c in req.findall("craftresource")]
            if el.get("hidefromplayeroncontext") == "all":
                continue
            if not any("_FARM_" in i for i in ins) or any("TOKEN" in i for i in ins):
                continue
            cat = MOUNT_CATEGORY
        # A raw resource carries no craftingcategory at all, so the guard
        # below dropped every transmutation in the game. It is not the zero
        # focus cost and not the button that hid them - it is the missing
        # category - so one is synthesised from the resource family, which is
        # what cityBonus and the Market grouping both key on.
        transmutes = [r for r in reqs
                      if r.get("craftbuttonlocaoverride") == TRANSMUTE_BUTTON]
        if cat is None and transmutes and el.get("resourcetype"):
            cat = el.get("resourcetype").split("_LEVEL")[0].lower()
        if cat not in EQUIP_CATEGORIES + REFINE_CATEGORIES + (MOUNT_CATEGORY,):
            continue
        group = GROUP_OF[cat]

        def add(rid, rreq, enchant, out=None, label=None):
            # Which bench this row belongs to. A refining bench pays the city
            # its refining bonus; a transmutation gives nothing back whatever
            # the rate is, because its input is flagged unreturnable.
            button = rreq.get("craftbuttonlocaoverride")
            refine = button == REFINE_BUTTON
            transmute = button == TRANSMUTE_BUTTON
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
            register(rid, group, name=label
                     or (meta.get(out, {}).get("name") if out else None))
            amount = int(rreq.get("amountcrafted", 1))
            silver = int(float(rreq.get("silver", 0)))
            # How good this can ever come out. 1,658 items can reach a
            # masterpiece and 412 are pinned at plain - every tool and every
            # piece of gathering gear among them - so quoting those a quality
            # uplift is money that cannot be made.
            max_q = int(el.get("maxqualitylevel", 5) or 5)
            # Six thousand rows, so anything the app can work out for itself
            # is left out: the name and tier are in `items`, the group is in
            # `groups` keyed by category, and a field equal to its default is
            # not written at all. Reconstructed in js/equipment.js, which is
            # the only thing that reads this file.
            recipes.append({
                "id": rid,
                "category": cat,
                # A second recipe for the same thing is a different recipe, so
                # it gets an id of its own and says what it actually makes.
                **({"out": out} if out else {}),
                **({"enchant": enchant} if enchant else {}),
                **({"refine": True} if refine else {}),
                # Transmuting is neither refining nor crafting, and listing it
                # beside the planks would bury it, so it gets a list of its own.
                **({"kind": "transmute", "group": "transmute",
                    "via": via_of(inputs, out or rid)} if transmute else {}),
                **({"amount": amount} if amount != 1 else {}),
                **({"silver": silver} if silver else {}),
                **({"maxQuality": max_q} if max_q != 5 else {}),
                "focus": int(float(rreq.get("craftingfocus", 0))),
                "itemValue": round(
                    sum(i["count"] * item_value(i["id"]) for i in inputs)
                    / float(amount or 1), 2),
                "inputs": inputs,
            })

        # A refined item carries its enchant on the element itself -
        # <simpleitem uniquename="T5_PLANKS_LEVEL1" enchantmentlevel="1"> - and
        # has no <enchantments> children at all, so hardcoding 0 here filed all
        # five of T5_PLANKS..T5_PLANKS_LEVEL4 as "T5, plain" and left the .1
        # and .2 slices of the Craft tab permanently empty.
        own_enchant = int(el.get("enchantmentlevel") or 0)

        # Which transmutation gets the bare id: the one that upgrades what you
        # are already holding at this tier, because that is the question a
        # gatherer actually asks. The other route - buy the tier below and
        # climb it - carries #tier. A plain raw has only the one route, so it
        # keeps the bare id either way.
        ordered = list(reqs)
        if len(transmutes) > 1:
            ordered = sorted(
                transmutes,
                key=lambda r: 0 if via_of(
                    [{"id": c.get("uniquename")} for c in r.findall("craftresource")],
                    unique) == "enchant" else 1)
            ordered += [r for r in reqs if r not in transmutes]
        add(unique, ordered[0], own_enchant)

        # The rest of the <craftingrequirements> on this item. Two kinds exist,
        # 100 in all, and the build used to read only the first:
        #   - 85 faction variants, which swap raw material for a faction token.
        #     Skipped: the token is faction standing rather than something a
        #     market quotes, so a row costing it would be a made-up number, and
        #     emitting them would list every refine twice.
        #   - 15 enchanted-rock variants. There is no T*_STONEBLOCK_LEVEL*
        #     item in the game, so enchanted rock instead pays 2, 4 or 8 plain
        #     blocks for the same focus. Without these, enchanted rock has no
        #     use in the app at all and T5_ROCK_LEVEL1 is not even a known id.
        for n, vreq in enumerate(ordered[1:], 1):
            vins = [c.get("uniquename") or "" for c in vreq.findall("craftresource")]
            if any("TOKEN" in i for i in vins):
                continue
            # Name it after the enchant level it eats, which is what the row is
            # really about, rather than after its position in the file.
            levels = [int(i.rsplit("_LEVEL", 1)[1]) for i in vins if "_LEVEL" in i
                      and i.rsplit("_LEVEL", 1)[1].isdigit()]
            mark = max(levels) if levels else n
            # Four rows all called "Travertine Block" would be four rows
            # nobody can tell apart, so a variant is named after the thing
            # that makes it different: the enchanted raw it eats.
            eats = next((i for i in vins if "_LEVEL" in i), None) or (vins[0] if vins else None)
            label = None
            if eats:
                label = f"{pretty(unique)} from {pretty(eats)}"
            if vreq.get("craftbuttonlocaoverride") == TRANSMUTE_BUTTON:
                suffix = via_of([{"id": i} for i in vins], unique)
            else:
                suffix = str(mark)
            add(f"{unique}#{suffix}", vreq, own_enchant, out=unique, label=label)

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


def resource_meta(equip_recipes, equip_items):
    """The raws and refined materials, pulled out of the equipment tables.

    Everything a refining recipe eats or makes, and nothing else: five
    families, seven tiers, five enchant levels, plus the plain blocks the
    enchanted rock rows share. Weapons and armour are deliberately left where
    they are, because nobody prices six thousand of them at once.
    """
    made = set()
    eaten = set()
    for r in equip_recipes:
        if not r.get("refine"):
            continue
        made.add(r.get("out") or r["id"])
        for i in r["inputs"]:
            eaten.add(i["id"])
    ids = sorted(i for i in (made | eaten) if "#" not in i)
    # What you dig out of the ground against what you make at a bench. A plank
    # is eaten by the tier above it AND made by a bench, so the test is
    # whether anything makes it at all. Without the split, Cedar Logs would
    # sit in the same list as alchemy extract under "other materials".
    for i in ids:
        if i in equip_items and i not in made:
            equip_items[i]["cat"] = "raw"
    return ids, {i: equip_items[i] for i in ids if i in equip_items}


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

    # What a single one weighs. Hauling between cities is the thing that
    # makes a farm bonus in another city worth having or not, and weight is
    # the only part of that the game publishes - what you can carry depends
    # on your mount and your bags, which it does not.
    weights = {
        el.get("uniquename"): float(el.get("weight"))
        for el in items.iter()
        if el.get("uniquename") and el.get("weight")
    }

    item_meta = {}

    def register(unique, category):
        if unique and unique not in item_meta:
            item_meta[unique] = {
                "name": pretty(unique), "tier": tier_of(unique), "cat": category,
                **({"weight": weights[unique]} if unique in weights else {}),
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

    # Built here rather than after the farming file is written, because the
    # raws and refined materials it knows about are listed in that file too.
    equip_recipes, equip_items = build_equipment(items, item_value, weights)
    resource_ids, resource_items = resource_meta(equip_recipes, equip_items)
    gathering = build_gathering(gd, items, parse("spells.xml"))
    # A resource the farming tables already describe keeps their row; the
    # refining tables only fill the gaps.
    for rid, row in resource_items.items():
        item_meta.setdefault(rid, row)
    # The books a gathering run fills, so the Market screen can name and price
    # them. Seventy ids on top of the resources' 245 - a rounding error next to
    # the 794 the boot payload already carries.
    journals = journal_items()
    for jid, row in journals.items():
        item_meta.setdefault(jid, row)

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
            # The repair station's Reroll Quality action, which the game
            # publishes in full: four starting qualities, five outcomes each.
            # Every below-diagonal weight is zero, so a reroll can only ever
            # move an item UP - and from Normal the stay-weight is zero too,
            # which means rerolling a plain item ALWAYS improves it. There is
            # no row for Masterpiece, because one cannot be rerolled.
            #
            # What the station charges is published nowhere: no rerollable
            # item carries an itemvalue and <RepairBuilding> gives only a
            # time. So the app never quotes a fee - it works out what the
            # reroll is WORTH from your own per-quality prices and leaves the
            # comparison with the station's number to you.
            "rerollWeights": {
                iq.get("level"): {
                    rq.get("level"): float(rq.get("weight"))
                    for rq in iq.findall("ResultQuality")
                }
                for iq in gd.findall(".//RerollQualityChances/InitialQuality")
            },
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
        # The raw resources and the refined materials they become, by id.
        #
        # They are listed here as well as in the equipment file because three
        # screens want them before anybody opens the Craft tab: the Market
        # tab, which cannot price a log it has never heard of, and the
        # gathering setup, which has to name what you are going out to chop.
        # It is 240-odd short rows against a two-megabyte download, so the
        # duplication is cheaper than the wait.
        "resources": resource_ids,
        # The journal ids a gathering run can fill, for the price list.
        "journalIds": sorted(journals),
        # Everything about going out and gathering the raws above: what a
        # node gives, how long a swing takes, and every bonus that changes
        # either. Small enough to ride in the file that loads at boot,
        # because the gathering setup screen needs it before anybody opens
        # the Craft tab.
        "gathering": gathering,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=1))
    print(f"\nWrote {OUT.relative_to(HERE.parent.parent)}")

    # --- weapons, armour and refining, in their own file ------------------
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
    g = data["gathering"]
    print(f"  gathering: "
          f"{sum(len(t) for f in g['nodes'].values() for t in f.values())} node rows, "
          f"{len(g['kindLabels'])} node kinds, {len(g['board'])} board nodes, "
          f"{len(g['food'])} foods, {len(g['potions'])} potions "
          f"(from harvestables.xml + spells.xml)")
    kb = OUT_EQUIP.stat().st_size / 1024
    print(f"  {len(equip_recipes)} weapon/armour/refining recipes, "
          f"{len(equip_items)} items, {len(equip_nodes)} craft board nodes "
          f"({kb:.0f} KB, loaded only when the Craft tab is opened)")


if __name__ == "__main__":
    main()
