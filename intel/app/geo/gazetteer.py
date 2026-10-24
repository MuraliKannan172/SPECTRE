"""The bundled place index built by intel/scripts/build_gazetteer.py."""

from __future__ import annotations

import gzip
import json
import unicodedata
from dataclasses import dataclass
from pathlib import Path

DEFAULT_PATH = Path(__file__).with_name("data") / "gazetteer.json.gz"


@dataclass(frozen=True)
class Place:
    kind: str  # country | admin1 | city | marine | region
    name: str
    lat: float
    lon: float
    country_code: str | None
    weight: int  # population for cities, a rank score for admin1
    flags: str  # continent for countries; "capital", "amb", "curated", ...
    alternate: bool = False  # matched through an alternate spelling


def name_key(text: str) -> str:
    """Same key function as the build script."""
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    cleaned = "".join(ch if ch.isalnum() else " " for ch in ascii_text.lower())
    words = cleaned.split()
    if words[:1] == ["the"]:
        words = words[1:]
    return " ".join(words)


class Gazetteer:
    def __init__(self, entities: list[list], names: dict[str, list[int]], meta: dict) -> None:
        self._entities = entities
        self._names = names
        self.meta = meta
        self.continent_of: dict[str, str] = {
            e[4]: e[6] for e in entities if e[0] == "country" and e[4] and e[6]
        }

    @classmethod
    def load(cls, path: Path = DEFAULT_PATH) -> Gazetteer:
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            data = json.load(handle)
        return cls(data["entities"], data["names"], data["meta"])

    def __len__(self) -> int:
        return len(self._entities)

    def lookup(self, key: str) -> list[Place]:
        places = []
        for index in self._names.get(key, ()):
            alternate = index < 0
            kind, name, lat, lon, cc, weight, flags = self._entities[-index - 1 if alternate else index]
            places.append(Place(kind, name, lat, lon, cc, weight, flags, alternate))
        return places
