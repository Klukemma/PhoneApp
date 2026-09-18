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

LIVESTOCK = ["CHICKEN", "GOAT", "GOOSE", "SHEEP", "PIG", "COW"]
MOUNT_STOCK = ["OX", "HORSE", "DIREWOLF", "DIREBOAR", "DIREBEAR", "SWAMPDRAGON",
               "GIANTSTAG", "MAMMOTH", "COUGAR", "DRAKE"]



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
    streams it and keeps only the first (EN-US) segment of each @ITEMS_ entry.
    """
    names = {}
    key = None
    want_seg = False
    for raw in fetch("localization.xml").decode("utf-8-sig").splitlines():
        if 'tuid="@ITEMS_' in raw:
            m = re.search(r'tuid="@ITEMS_([^"]+)"', raw)
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


def build_cities() -> list:
    """City crafting and farming bonuses, read from the game's own tables.

    Crafting: a flat base in the city and, importantly, ZERO on a private
    island - islandvalue is 0 throughout craftingmodifiers.xml. On top of that
    a city adds a percentage for each category it specialises in.

    Farming: a flat +10% yield for a handful of named crops, herbs and animal
    products, and here the island value matches the city value, so an island
    bound to a city farms with that city's bonus.
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
    # Crafting on your own island earns no city bonus at all.
    out.append({
        "id": "island", "name": "My island (no city bonus)", "cluster": None,
        "craftBase": 0, "craftSpecialties": {}, "farmBonus": {},
    })
    return out


# Destiny board branches this app cares about. Everything else on the board
# (weapons, armour, gathering) has no bearing on farming or brewing.
FOCUS_BRANCHES = ("FARM_CROPS", "FARM_HERBS", "FARM_ANIMALS",
                  "FARM_ALCHEMIST", "FARM_COOK")


def build_focus_nodes() -> list:
    """Destiny board nodes that reduce focus cost, with what each one covers.

    Every node gives a fixed number of efficiency points per level to items
    matching its patterns. A specialisation gives a lot to its own item and a
    little to everything in its branch, so levelling one potion quietly makes
    every other potion cheaper too. Total efficiency for an item is the sum
    over every matching rule of level x bonus.
    """
    root = parse("achievements.xml")
    out = []
    for el in root.iter():
        nid = el.get("id")
        if not nid or not nid.startswith(FOCUS_BRANCHES):
            continue
        rewards = el.find("baserewards")
        if rewards is None:
            continue
        rules = []
        # Direct rewards only - a parent must not inherit its children's.
        for b in rewards.findall("bonus"):
            kind = b.get("type") or ""
            if "focuscostreduction" not in kind:
                continue
            rules.append({
                "bonus": float(b.get("bonus")),
                "minTier": int(b.get("mintier", 1)),
                "maxTier": int(b.get("maxtier", 8)),
                "patterns": [p.get("pattern") for p in b.findall("itempattern")],
            })
        if not rules:
            continue
        parent = el.find(".//parentachievements/achievement")
        parent_id = parent.get("id") if parent is not None else None
        out.append({
            "id": nid,
            "name": node_name(nid),
            "branch": nid.split("_")[1] if "_" in nid else nid,
            "kind": "spec" if parent_id in FOCUS_BRANCHES else "mastery",
            "parent": parent_id,
            "rules": rules,
        })
    # Deduplicate: the same node can appear as a template and an instance.
    seen = {}
    for n in out:
        seen.setdefault(n["id"], n)
    return sorted(seen.values(), key=lambda n: (n["branch"], n["kind"] != "mastery", n["id"]))


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
            "yieldMin": drop.get("min", 3), "yieldMax": drop.get("max", 6),
        })
        register(f.get("uniquename"), "seed")
        register(crop, "herb" if is_herb else "crop")
    plants.sort(key=lambda p: (p["kind"], p["tier"]))

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
            "nutrition": int(float(food.get("nutritionmax"))) if food is not None else 0,
            "favouriteFood": accepted.get("favorite") if accepted is not None else None,
            "favouriteBonus": float(accepted.get("favoritebonus", 0)) if accepted is not None else 0,
            "product": product,
        })
        register(u, "baby")
        register(grown_id, "animal")
    animals.sort(key=lambda a: (a["kind"], a["tier"]))

    # --- recipes that consume something you farmed ------------------------
    recipes = []
    for el in items.iter():
        req = el.find("craftingrequirements")
        cat = el.get("craftingcategory")
        if req is None or cat not in ("potion", "food"):
            continue
        unique = el.get("uniquename")
        if not unique or "PROTOTYPE" in unique:
            continue
        inputs = [
            {"id": c.get("uniquename"), "count": int(c.get("count"))}
            for c in req.findall("craftresource")
        ]
        if not any(i["id"] in farm_out for i in inputs):
            continue
        for i in inputs:
            register(i["id"], item_meta.get(i["id"], {}).get("cat", "material"))
        register(unique, cat)
        recipes.append({
            "id": unique,
            "name": pretty(unique),
            "tier": tier_of(unique),
            "category": cat,
            "amount": int(req.get("amountcrafted", 1)),
            "focus": int(float(req.get("craftingfocus", 0))),
            "silver": int(float(req.get("silver", 0))),
            "inputs": inputs,
        })
    recipes.sort(key=lambda x: (x["category"], x["name"], x["tier"]))

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
            "premiumYieldMultiplier": 2,
            "focusPerDay": 10000,
            "focusCap": 30000,
            "premiumYieldMultiplier": 2,
        },
        "cities": cities,
        "focusNodes": focus_nodes,
        "plants": plants,
        "animals": animals,
        "recipes": recipes,
        "items": item_meta,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=1))
    print(f"\nWrote {OUT.relative_to(HERE.parent.parent)}")
    print(f"  {len(plants)} plants, {len(animals)} animals, "
          f"{len(recipes)} recipes, {len(item_meta)} items")
    print(f"  focus crafting bonus +{data['constants']['focusCraftBonus']}% "
          f"(from gamedata.xml)")
    print(f"  {len(cities)} crafting/farming locations (from craftingmodifiers.xml "
          f"+ farmingmodifiers.xml)")
    print(f"  {len(focus_nodes)} destiny board focus nodes (from achievements.xml)")


if __name__ == "__main__":
    main()
