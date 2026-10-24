"""Build intel/app/geo/data/gazetteer.json.gz, the geoparser's place index.

Sources (recorded with URL, SHA-256 and fetch time in the output's `meta`):

- GeoNames cities15000, countryInfo (CC BY 4.0, https://www.geonames.org/):
  cities with population >= 15,000, and each country's continent.
- Natural Earth packs already bundled with the app (public domain):
  countries, first-level states and provinces, seas and straits, and named
  regions (islands, peninsulas, deserts, ranges).
- A short curated list in this file for places Natural Earth and GeoNames do
  not name the way news does (Gaza Strip, Donbas, ...), plus common aliases.

Run from the repository root (PowerShell):
    uv run --project intel python intel/scripts/build_gazetteer.py
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import io
import json
import math
import sys
import tempfile
import unicodedata
import urllib.request
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "intel"))
from app.geo.gazetteer import name_key  # noqa: E402  (one key function for build and lookup)

NE_DIR = REPO / "src" / "data" / "local_data" / "natural_earth"
OUT = REPO / "intel" / "app" / "geo" / "data" / "gazetteer.json.gz"
GEONAMES = {
    "cities15000": "https://download.geonames.org/export/dump/cities15000.zip",
    "countryInfo": "https://download.geonames.org/export/dump/countryInfo.txt",
}
USER_AGENT = "SKYNET-intel-gazetteer-build/0.1"

REGION_CLASSES = {
    "Island",
    "Island group",
    "Pen/cape",
    "Peninsula",
    "Desert",
    "Range/mtn",
    "Geoarea",
    "Plateau",
    "Basin",
    "Delta",
    "Valley",
    "Plain",
    "Isthmus",
}

# Places news names that the datasets above do not (or not by that name).
CURATED_PLACES = [
    # name, aliases, lat, lon, country code
    ("Gaza Strip", ["gaza", "gaza strip"], 31.42, 34.37, "PS"),
    ("West Bank", ["west bank"], 31.95, 35.30, "PS"),
    ("Donbas", ["donbas", "donbass"], 48.00, 38.50, "UA"),
    ("Darfur", ["darfur"], 13.50, 24.00, "SD"),
    ("Nagorno-Karabakh", ["nagorno karabakh", "karabakh"], 39.82, 46.75, "AZ"),
    ("Golan Heights", ["golan heights", "golan"], 33.00, 35.75, "SY"),
    ("Kashmir", ["kashmir"], 34.08, 74.80, None),
    ("Strait of Hormuz", ["strait of hormuz", "hormuz strait", "hormuz"], 26.57, 56.25, None),
    ("Sinai Peninsula", ["sinai", "sinai peninsula"], 29.50, 33.80, "EG"),
]

# Extra spellings for countries, keyed by ISO 3166-1 alpha-2.
COUNTRY_ALIASES = {
    "US": ["us", "u s", "usa", "u s a", "america", "united states"],
    "GB": ["uk", "u k", "britain", "great britain", "united kingdom"],
    "CD": [
        "drc",
        "dr congo",
        "democratic republic of congo",
        "democratic republic of the congo",
        "congo kinshasa",
    ],
    "CG": ["republic of congo", "republic of the congo", "congo brazzaville"],
    "KP": ["north korea", "dprk"],
    "KR": ["south korea"],
    "CZ": ["czech republic", "czechia"],
    "CI": ["ivory coast", "cote d ivoire"],
    "MM": ["myanmar", "burma"],
    "AE": ["uae", "u a e", "united arab emirates"],
    "PS": ["palestine", "palestinian territories"],
    "TR": ["turkey", "turkiye"],
    "RU": ["russia", "russian federation"],
    "SY": ["syria"],
    "IR": ["iran"],
    "VN": ["vietnam", "viet nam"],
    "LA": ["laos"],
    "BO": ["bolivia"],
    "VE": ["venezuela"],
    "TZ": ["tanzania"],
    "SS": ["south sudan"],
    "CF": ["central african republic", "car"],
    "BA": ["bosnia", "bosnia and herzegovina"],
    "MK": ["north macedonia", "macedonia"],
    "SZ": ["eswatini", "swaziland"],
    "CV": ["cape verde", "cabo verde"],
    "TL": ["east timor", "timor leste"],
    "VA": ["vatican", "vatican city", "holy see"],
}


def _is_latin(text: str) -> bool:
    for ch in text:
        if ch.isalpha() and "LATIN" not in unicodedata.name(ch, ""):
            return False
    return True


def fetch(url: str, cache: Path) -> tuple[bytes, dict]:
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / url.rsplit("/", 1)[-1]
    if not target.exists():
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
            target.write_bytes(response.read())
    data = target.read_bytes()
    fetched = dt.datetime.fromtimestamp(target.stat().st_mtime, dt.UTC)
    return data, {
        "url": url,
        "sha256": hashlib.sha256(data).hexdigest(),
        "fetched": fetched.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "license": "CC BY 4.0 (GeoNames, https://www.geonames.org/)",
    }


# -- polygon helpers ----------------------------------------------------------


def _ring_area_centroid(ring: list[list[float]]) -> tuple[float, float, float]:
    area = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1], strict=True):
        cross = x0 * y1 - x1 * y0
        area += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if abs(area) < 1e-12:
        xs, ys = zip(*ring, strict=True)
        return 0.0, sum(xs) / len(xs), sum(ys) / len(ys)
    return abs(area / 2), cx / (3 * area), cy / (3 * area)


def _inside(x: float, y: float, ring: list[list[float]]) -> bool:
    inside = False
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1], strict=True):
        if (y0 > y) != (y1 > y) and x < (x1 - x0) * (y - y0) / (y1 - y0) + x0:
            inside = not inside
    return inside


def _edge_distance(x: float, y: float, ring: list[list[float]]) -> float:
    best = math.inf
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1], strict=True):
        dx, dy = x1 - x0, y1 - y0
        t = (
            0.0
            if dx == dy == 0
            else max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)))
        )
        best = min(best, math.hypot(x - (x0 + t * dx), y - (y0 + t * dy)))
    return best


def representative_point(polygons: list, decimals: int = 3) -> tuple[float, float]:
    """(lat, lon) inside the largest ring: its centroid, or the most interior grid point."""
    rings = [ring for ring in _rings(polygons, decimals) if len(ring) >= 3]
    ring = max(rings, key=lambda r: _ring_area_centroid(r)[0])
    _, cx, cy = _ring_area_centroid(ring)
    if _inside(cx, cy, ring):
        return round(cy, 3), round(cx, 3)
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    best, point = -1.0, (ys[0], xs[0])
    steps = 24
    for i in range(1, steps):
        for j in range(1, steps):
            x = min(xs) + (max(xs) - min(xs)) * i / steps
            y = min(ys) + (max(ys) - min(ys)) * j / steps
            if _inside(x, y, ring):
                distance = _edge_distance(x, y, ring)
                if distance > best:
                    best, point = distance, (y, x)
    return round(point[0], 3), round(point[1], 3)


def _decode_ring(encoded: list[int], decimals: int) -> list[list[float]]:
    """A packed ring (see src/data/adminBoundaries.js decodeRing): integers in
    10^-decimals degrees, the first vertex absolute, later ones deltas."""
    factor, x, y, ring = 10**decimals, 0, 0, []
    for i in range(0, len(encoded) - 1, 2):
        x += encoded[i]
        y += encoded[i + 1]
        ring.append([x / factor, y / factor])
    return ring


def _rings(polygons: list, decimals: int) -> list[list[list[float]]]:
    """Outer rings from any of the pack layouts.

    marine/regions: a list of rings of [lon, lat] pairs (outer rings only).
    countries/states: a list of polygons, each a list of packed rings, the
    first being the outer ring.
    """
    first = polygons[0][0]
    if isinstance(first[0], (int, float)) and len(first) > 2:
        return [_decode_ring(polygon[0], decimals) for polygon in polygons]
    if isinstance(first[0], (int, float)):
        return polygons
    return [polygon[0] for polygon in polygons]


# -- build --------------------------------------------------------------------


def build(cache: Path) -> dict:
    entities: list[list] = []
    names: dict[str, list[int]] = {}

    def add(
        kind: str,
        name: str,
        lat: float,
        lon: float,
        cc: str | None,
        pop: int,
        keys: list[str],
        *,
        alt_keys: list[str] = (),
        flags: str = "",
    ) -> int:
        index = len(entities)
        entities.append([kind, name, lat, lon, cc, pop, flags])
        seen = set()
        for key, is_alt in [(k, False) for k in keys] + [(k, True) for k in alt_keys]:
            key = name_key(key)
            if not key or key in seen:
                continue
            seen.add(key)
            names.setdefault(key, []).append(index if not is_alt else -index - 1)
        return index

    info_raw, info_meta = fetch(GEONAMES["countryInfo"], cache)
    continent: dict[str, str] = {}
    for line in info_raw.decode("utf-8").splitlines():
        if line.startswith("#") or not line.strip():
            continue
        cols = line.split("\t")
        continent[cols[0]] = cols[8]

    countries = json.loads((NE_DIR / "countries.json").read_text(encoding="utf-8"))
    for feature in countries["features"]:
        cc = feature.get("iso2")
        if not cc or cc == "-99" or not feature.get("polygons"):
            continue
        decimals = feature.get("d", countries["meta"].get("decimals", 3))
        lat, lon = representative_point(feature["polygons"], decimals)
        keys = [feature["name"], feature.get("country") or feature["name"], *feature.get("alt", [])]
        # Aliases ("UK", "Britain") name the sovereign state, not England,
        # Scotland, Wales or Northern Ireland, which share its ISO code.
        if feature.get("type") == "Country":
            keys += COUNTRY_ALIASES.get(cc, [])
        add("country", feature["name"], lat, lon, cc, 0, keys, flags=continent.get(cc, ""))

    states = json.loads((NE_DIR / "states_provinces.json").read_text(encoding="utf-8"))
    for feature in states["features"]:
        label = feature.get("label")
        if not label or not feature.get("iso2"):
            continue
        lon, lat = label
        names_for = [feature["name"], feature.get("nameEn") or feature["name"]]
        flags = "amb" if feature.get("amb") else ""
        add(
            "admin1",
            feature.get("nameEn") or feature["name"],
            round(lat, 3),
            round(lon, 3),
            feature["iso2"],
            int(round((10 - float(feature.get("rank") or 10)) * 10)),
            names_for,
            alt_keys=[a for a in feature.get("alt", []) if len(a) > 3],
            flags=flags,
        )

    for pack, classes in (("marine.json", None), ("regions.json", REGION_CLASSES)):
        data = json.loads((NE_DIR / pack).read_text(encoding="utf-8"))
        for feature in data["features"]:
            if classes is not None and feature.get("featurecla") not in classes:
                continue
            if not feature.get("polygons") or not feature.get("name"):
                continue
            lat, lon = representative_point(feature["polygons"])
            alts = [a for a in (feature.get("namealt") or "").split("|") if a]
            add(
                "marine" if pack == "marine.json" else "region",
                feature["name"],
                lat,
                lon,
                None,
                0,
                [feature["name"]],
                alt_keys=alts,
                flags=feature.get("featurecla", ""),
            )

    for name, aliases, lat, lon, cc in CURATED_PLACES:
        add("region", name, lat, lon, cc, 0, [name, *aliases], flags="curated")

    cities_raw, cities_meta = fetch(GEONAMES["cities15000"], cache)
    with zipfile.ZipFile(io.BytesIO(cities_raw)) as archive:
        text = archive.read("cities15000.txt").decode("utf-8")
    for line in text.splitlines():
        cols = line.split("\t")
        if len(cols) < 15:
            continue
        name, ascii_name, alternates = cols[1], cols[2], cols[3]
        lat, lon, feature_code, cc, population = (
            float(cols[4]),
            float(cols[5]),
            cols[7],
            cols[8],
            int(cols[14] or 0),
        )
        alt_keys = []
        for alt in alternates.split(","):
            alt = alt.strip()
            if not (3 <= len(alt) <= 40) or not _is_latin(alt) or any(ch.isdigit() for ch in alt):
                continue
            if alt.isupper() and len(alt) <= 4:  # airport and agency codes
                continue
            alt_keys.append(alt)
        flags = "capital" if feature_code == "PPLC" else ""
        add(
            "city",
            name,
            round(lat, 4),
            round(lon, 4),
            cc,
            population,
            [name, ascii_name],
            alt_keys=alt_keys,
            flags=flags,
        )

    built = dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "meta": {
            "built": built,
            "entity_fields": ["kind", "name", "lat", "lon", "country_code", "population_or_rank", "flags"],
            "names_note": "name key -> entity indexes; a negative index -i-1 marks an alternate name",
            "sources": {
                "geonames_cities15000": cities_meta,
                "geonames_countryInfo": info_meta,
                "natural_earth": {
                    "packs": "src/data/local_data/natural_earth"
                    " (countries, states_provinces, marine, regions)",
                    "commit": countries["meta"].get("commit"),
                    "license": "Public domain (Natural Earth, https://www.naturalearthdata.com/)",
                },
                "curated": "intel/scripts/build_gazetteer.py CURATED_PLACES and COUNTRY_ALIASES",
            },
            "counts": {
                kind: sum(1 for e in entities if e[0] == kind)
                for kind in ("country", "admin1", "marine", "region", "city")
            },
        },
        "entities": entities,
        "names": names,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cache", type=Path, default=Path(tempfile.gettempdir()) / "skynet-geonames")
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()
    gazetteer = build(args.cache)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(gazetteer, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with args.out.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as out:
        out.write(payload)
    print(
        f"wrote {args.out} ({args.out.stat().st_size:,} bytes): {gazetteer['meta']['counts']}, "
        f"{len(gazetteer['names']):,} names"
    )


if __name__ == "__main__":
    main()
