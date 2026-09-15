#!/usr/bin/env python3
"""Build albion/data/gamedata.json from the official Albion binary dumps.

Everything the calculator treats as game truth comes from here, so after a
patch you re-run this rather than hand-editing numbers:

    python3 albion/tools/build_gamedata.py

Source: https://github.com/ao-data/ao-bin-dumps (items.xml, loot.xml, gamedata.xml)
Stdlib only - no packages to install.
"""

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

# Unique names are terse; these read better in a list on a phone.
NAMES = {
    "POTION_HEAL": "Healing Potion", "POTION_ENERGY": "Energy Potion",
    "POTION_STONESKIN": "Gigantify Potion", "POTION_BERSERK": "Resistance Potion",
    "POTION_CLEANSE": "Cleansing Potion", "POTION_CLEANSE2": "Purifying Potion",
    "POTION_GATHER": "Gathering Potion", "POTION_COOLDOWN": "Invisibility Potion",
    "POTION_REVIVE": "Resurrection Potion", "POTION_LIFEWARD": "Poison Potion",
    "POTION_SLOWFIELD": "Sticky Potion", "POTION_TORNADO": "Tornado Potion",
    "POTION_ACID": "Acid Potion", "POTION_LAVA": "Lava Potion",
    "POTION_MOB_RESET": "Calming Potion",
    "MEAL_SOUP": "Soup", "MEAL_SALAD": "Salad", "MEAL_PIE": "Pie",
    "MEAL_OMELETTE": "Omelette", "MEAL_ROAST": "Roast", "MEAL_STEW": "Stew",
    "MEAL_SANDWICH": "Sandwich", "FLOUR": "Flour", "BUTTER": "Butter",
    "ALCOHOL": "Alcohol", "EGG": "Eggs", "MILK": "Milk",
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


def pretty(unique: str) -> str:
    """T5_FARM_CABBAGE_SEED -> 'Cabbage Seed', T4_POTION_HEAL -> 'Healing Potion'."""
    body = re.sub(r"^T\d+_", "", unique)
    for key, label in NAMES.items():
        if body == key or body.startswith(key + "_"):
            rest = body[len(key):].strip("_")
            return f"{label} {rest.title()}".strip()
    body = body.replace("FARM_", "").replace("_", " ").title()
    return body


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


def main() -> None:
    print("Reading Albion dumps...", file=sys.stderr)
    items = parse("items.xml")
    loot = loot_table(parse("loot.xml"))
    gd = parse("gamedata.xml")

    # --- the two constants the game actually publishes -------------------
    focus_el = gd.find(".//ActionFocus")
    focus_bonus = float(focus_el.find("CraftingEfficiency").get("bonus"))
    cost_const = float(focus_el.get("costreductionconstant"))

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
            "name": pretty(f.get("uniquename")).replace(" Seed", ""),
            "tier": int(f.get("tier")),
            "kind": "herb" if is_herb else "crop",
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
            "name": pretty(u).replace(" Baby", ""),
            "tier": int(f.get("tier")),
            "kind": "livestock" if species in LIVESTOCK else "mount",
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
            # Not published in the dumps - see README for sourcing. Editable in-app.
            "cityBaseBonus": 18,
            "craftSpecialtyBonus": 15,
            "refineSpecialtyBonus": 40,
            # Every city gives the same base bonus; the specialty is what differs.
            # Only two of this app's categories are anyone's specialty: potions
            # belong to Brecilien and cooked food to Caerleon. The royal cities
            # specialise in weapons and armour, so for potions and food they are
            # just the base. A station shows its real bonus on the city map, and
            # every figure here is editable in the app.
            "cities": [
                {"id": "brecilien", "name": "Brecilien", "base": 18, "specialties": ["potion"]},
                {"id": "caerleon", "name": "Caerleon", "base": 18, "specialties": ["food"]},
                {"id": "martlock", "name": "Martlock", "base": 18, "specialties": []},
                {"id": "thetford", "name": "Thetford", "base": 18, "specialties": []},
                {"id": "lymhurst", "name": "Lymhurst", "base": 18, "specialties": []},
                {"id": "bridgewatch", "name": "Bridgewatch", "base": 18, "specialties": []},
                {"id": "fortsterling", "name": "Fort Sterling", "base": 18, "specialties": []},
                {"id": "island", "name": "Island or hideout", "base": 18, "specialties": []},
            ],
            "focusPerDay": 10000,
            "focusCap": 30000,
            "marketTaxPremium": 6.5,
            "marketTaxNormal": 10.5,
            "premiumYieldMultiplier": 2,
        },
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


if __name__ == "__main__":
    main()
