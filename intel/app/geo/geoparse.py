"""Find where a news item happened: spaCy NER plus the bundled gazetteer.

Only places are extracted and stored. Text spaCy labels as a person is used
for nothing except an exact match on a country, province or large city name
(the small model often tags "Kharkiv" or "Sri Lanka" as PERSON); the person
text itself is never kept. SKYNET does not build an index of people.

Scoring is deterministic. Each place mention gets candidates from the
gazetteer; a candidate's score starts from its kind (country, province, city
by population, sea or region) and moves with context:

- other places in the item that resolve to the same country raise it, and
  cities or provinces outside every co-mentioned country lose;
- a candidate near another mention's candidate is supported (Atlanta makes
  "Georgia" the US state);
- nationality words ("Egyptian", "Swiss") raise places in that country;
- the feed's region nudges candidates on the right continent;
- a close second reading of the same name lowers the winner, so ambiguous
  names stay off the globe;
- a capital or country used as a speaker ("Washington says...") is the
  government talking, not the event's location, and is capped low.

Items at or above ON_GLOBE_CONFIDENCE are placed on the globe; the rest still
appear in lists.
"""

from __future__ import annotations

import math
import re
import threading
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from .gazetteer import Gazetteer, Place, name_key

ON_GLOBE_CONFIDENCE = 0.6
MIN_STORED_CONFIDENCE = 0.3
SPACY_MODEL = "en_core_web_sm"
SUPPORT_KM = 400.0
BIG_CITY = 1_000_000

_PLACE_LABELS = {"GPE", "LOC", "FAC"}
_SPEECH_VERBS = {
    "says",
    "said",
    "say",
    "warns",
    "warned",
    "urges",
    "urged",
    "accuses",
    "accused",
    "calls",
    "called",
    "denies",
    "denied",
    "rejects",
    "rejected",
    "condemns",
    "condemned",
    "announces",
    "announced",
    "claims",
    "claimed",
    "vows",
    "vowed",
    "threatens",
    "threatened",
    "insists",
    "signals",
    "demands",
    "demanded",
    "slams",
    "blames",
    "tells",
    "told",
    "pledges",
    "pledged",
    "responds",
    "responded",
}
_DIRECTION_PREFIXES = (
    "northern ",
    "southern ",
    "eastern ",
    "western ",
    "central ",
    "north ",
    "south ",
    "east ",
    "west ",
    "northeast ",
    "northwest ",
    "southeast ",
    "southwest ",
    "greater ",
)
_GENERIC_SUFFIXES = (
    " province",
    " state",
    " region",
    " city",
    " county",
    " district",
    " governorate",
    " oblast",
    " prefecture",
    " territory",
    " islands",
    " island",
    " peninsula",
)
_MARINE_WORDS = {"sea", "gulf", "strait", "straits", "bay", "ocean", "channel", "sound"}
_REGION_CONTINENTS = {
    "africa": {"AF"},
    "europe": {"EU"},
    "americas": {"NA", "SA"},
    "asia-pacific": {"AS", "OC"},
}
_MIDDLE_EAST = {
    "AE",
    "BH",
    "EG",
    "IL",
    "IQ",
    "IR",
    "JO",
    "KW",
    "LB",
    "OM",
    "PS",
    "QA",
    "SA",
    "SY",
    "TR",
    "YE",
    "CY",
}
_KIND_BONUS = {"city": 0.03, "admin1": 0.02, "marine": 0.01, "region": 0.01, "country": 0.0}
# Nationality words that point at one country. Context only: they raise
# places in that country but are never a location themselves.
_DEMONYMS = {
    "afghan": "AF",
    "algerian": "DZ",
    "american": "US",
    "argentine": "AR",
    "argentinian": "AR",
    "armenian": "AM",
    "australian": "AU",
    "austrian": "AT",
    "azerbaijani": "AZ",
    "bangladeshi": "BD",
    "belarusian": "BY",
    "belgian": "BE",
    "brazilian": "BR",
    "british": "GB",
    "burmese": "MM",
    "canadian": "CA",
    "chilean": "CL",
    "chinese": "CN",
    "colombian": "CO",
    "cuban": "CU",
    "czech": "CZ",
    "danish": "DK",
    "dutch": "NL",
    "egyptian": "EG",
    "emirati": "AE",
    "estonian": "EE",
    "ethiopian": "ET",
    "filipino": "PH",
    "finnish": "FI",
    "french": "FR",
    "georgian": "GE",
    "german": "DE",
    "greek": "GR",
    "haitian": "HT",
    "hungarian": "HU",
    "indian": "IN",
    "indonesian": "ID",
    "iranian": "IR",
    "iraqi": "IQ",
    "irish": "IE",
    "israeli": "IL",
    "italian": "IT",
    "japanese": "JP",
    "jordanian": "JO",
    "kenyan": "KE",
    "kuwaiti": "KW",
    "latvian": "LV",
    "lebanese": "LB",
    "libyan": "LY",
    "lithuanian": "LT",
    "malaysian": "MY",
    "malian": "ML",
    "mexican": "MX",
    "moldovan": "MD",
    "moroccan": "MA",
    "nepalese": "NP",
    "nepali": "NP",
    "nigerian": "NG",
    "norwegian": "NO",
    "pakistani": "PK",
    "palestinian": "PS",
    "peruvian": "PE",
    "polish": "PL",
    "portuguese": "PT",
    "qatari": "QA",
    "romanian": "RO",
    "russian": "RU",
    "rwandan": "RW",
    "saudi": "SA",
    "serbian": "RS",
    "slovak": "SK",
    "somali": "SO",
    "spanish": "ES",
    "sudanese": "SD",
    "swedish": "SE",
    "swiss": "CH",
    "syrian": "SY",
    "taiwanese": "TW",
    "thai": "TH",
    "tunisian": "TN",
    "turkish": "TR",
    "ugandan": "UG",
    "ukrainian": "UA",
    "venezuelan": "VE",
    "vietnamese": "VN",
    "yemeni": "YE",
    "zimbabwean": "ZW",
}
# Place names that are also common given names: a PERSON-labelled "Jordan"
# or "Chad" is far more often a person than the country.
_GIVEN_NAMES = frozenset(
    "jordan chad georgia israel india kenya paris victoria florence sydney austin houston "
    "jackson lincoln washington charlotte phoenix dallas madison chelsea brooklyn savannah "
    "virginia carolina nevada montana dakota tennessee aurora denver orlando mobile "
    "lima santiago salvador cordoba valencia regina".split()
)
_CAPITALISED_RUN = re.compile(r"[A-Z][\w.\-’']*(?:\s+[A-Z][\w.\-’']*)*")
# A place, a comma, then a date: "Brussels, 23 Oct 2026", "LONDON, Oct 24".
_MONTH = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?"
_DATELINE = re.compile(rf"^\s*,\s*(?:\d{{1,2}}\s+{_MONTH}|{_MONTH}\s+\d{{1,2}})\b")
_POSSESSIVE = re.compile(r"(?:'s|’s|'|’)$")


@dataclass(frozen=True)
class GeoResult:
    lat: float
    lon: float
    place_name: str
    country_code: str | None
    confidence: float
    kind: str

    @property
    def on_globe(self) -> bool:
        return self.confidence >= ON_GLOBE_CONFIDENCE


@dataclass(frozen=True)
class _Mention:
    in_title: bool
    speaker: bool
    weak: bool  # from a PERSON label or the title scan, not a place label
    candidates: tuple[Place, ...]
    dateline: bool = False  # "Brussels, 23 Oct 2026": where it was issued, not where it happened


def _km(a: Place, b: Place) -> float:
    p1, p2 = math.radians(a.lat), math.radians(b.lat)
    dp, dl = p2 - p1, math.radians(b.lon - a.lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def _same_place(a: Place, b: Place) -> bool:
    if a.country_code and b.country_code and a.country_code != b.country_code:
        return False
    return _km(a, b) <= 500.0


class GeoParser:
    def __init__(self, gazetteer: Gazetteer, nlp: Any = None) -> None:
        self.gazetteer = gazetteer
        self._nlp = nlp
        self._lock = threading.Lock()

    @property
    def nlp(self) -> Any:
        with self._lock:
            if self._nlp is None:
                import spacy

                self._nlp = spacy.load(
                    SPACY_MODEL,
                    disable=["parser", "lemmatizer", "tagger", "attribute_ruler", "senter"],
                )
            return self._nlp

    @property
    def model_name(self) -> str | None:
        meta = getattr(self._nlp, "meta", None)
        if not meta:
            return None
        return f"{meta.get('lang', 'en')}_{meta.get('name', '')}-{meta.get('version', '?')}"

    def parse(self, title: str, summary: str = "", region: str | None = None) -> GeoResult | None:
        return self.parse_many([(title, summary, region)])[0]

    def parse_many(self, items: Iterable[tuple[str, str, str | None]]) -> list[GeoResult | None]:
        items = list(items)
        texts = [text for title, summary, _ in items for text in (title, summary or "")]
        docs = list(self.nlp.pipe(texts, batch_size=64))
        results = []
        for index, (title, _, region) in enumerate(items):
            title_doc, summary_doc = docs[2 * index], docs[2 * index + 1]
            mentions, demonyms = self._mentions(title_doc, True)
            more, more_demonyms = self._mentions(summary_doc, False)
            if not any(m.in_title for m in mentions):
                people = [(e.start_char, e.end_char) for e in title_doc.ents if e.label_ == "PERSON"]
                mentions += self._title_scan(title, people)
            results.append(self._resolve(mentions + more, demonyms | more_demonyms, region))
        return results

    # -- mentions ------------------------------------------------------------

    def _mentions(self, doc: Any, in_title: bool) -> tuple[list[_Mention], set[str]]:
        mentions: list[_Mention] = []
        demonyms: set[str] = set()
        for ent in doc.ents:
            text = _POSSESSIVE.sub("", ent.text.strip())
            if ent.label_ == "NORP":
                code = _DEMONYMS.get(text.lower())
                if code:
                    demonyms.add(code)
                continue
            weak = ent.label_ == "PERSON"
            if ent.label_ not in _PLACE_LABELS and not weak:
                continue
            if weak and name_key(text) in _GIVEN_NAMES:
                continue
            candidates = self._candidates(text)
            if weak:
                candidates = [p for p in candidates if self._strong_name(p)]
            if not candidates:
                continue
            following = doc[ent.end].text.lower() if ent.end < len(doc) else ""
            if following in ("'s", "’s") and ent.end + 1 < len(doc):
                following = doc[ent.end + 1].text.lower()
            dateline = bool(_DATELINE.match(doc.text[ent.end_char : ent.end_char + 24]))
            mentions.append(_Mention(in_title, following in _SPEECH_VERBS, weak, tuple(candidates), dateline))
        return mentions, demonyms

    def _title_scan(self, title: str, people: list[tuple[int, int]]) -> list[_Mention]:
        """Places the NER missed in a title: countries and big cities only.

        Runs overlapping a PERSON entity are skipped: "Jordan Peterson" is a
        person, not a mention of Jordan.
        """
        mentions = []
        for match in _CAPITALISED_RUN.finditer(title):
            if any(start < match.end() and match.start() < end for start, end in people):
                continue
            words = [_POSSESSIVE.sub("", word) for word in match.group().split()]
            for size in (3, 2, 1):
                for start in range(len(words) - size + 1):
                    candidates = [
                        p
                        for p in self.gazetteer.lookup(name_key(" ".join(words[start : start + size])))
                        if not p.alternate
                        and (p.kind == "country" or (p.kind == "city" and p.weight >= BIG_CITY))
                    ]
                    if candidates:
                        mentions.append(_Mention(True, False, True, tuple(candidates)))
        return mentions

    @staticmethod
    def _strong_name(place: Place) -> bool:
        if place.alternate:
            return False
        if place.kind == "country":
            return True
        if place.kind == "admin1":
            return "amb" not in place.flags
        return place.kind == "city" and place.weight >= BIG_CITY

    def _candidates(self, text: str) -> list[Place]:
        key = name_key(text)
        if not key or key.isdigit():
            return []
        places = self.gazetteer.lookup(key)
        if not places:
            for prefix in _DIRECTION_PREFIXES:
                if key.startswith(prefix):
                    places = self.gazetteer.lookup(key[len(prefix) :])
                    break
        if not places:
            for suffix in _GENERIC_SUFFIXES:
                if key.endswith(suffix):
                    places = self.gazetteer.lookup(key[: -len(suffix)])
                    break
        # "Red Sea", "Gulf of Mexico": the water body, not the province named after it.
        if _MARINE_WORDS & set(key.split()) and any(p.kind == "marine" for p in places):
            places = [p for p in places if p.kind == "marine"]
        # "New Zealand", "Fiji": the country, not the island group of the same name.
        if any(p.kind == "country" for p in places):
            places = [p for p in places if p.kind != "region"]
        return places

    # -- scoring -------------------------------------------------------------

    @staticmethod
    def _base(place: Place) -> float:
        if place.kind == "country":
            score = 0.72
        elif place.kind == "admin1":
            score = 0.55 if "amb" in place.flags else 0.60
        elif place.kind == "city":
            population = max(place.weight, 15_000)
            score = min(0.80, 0.45 + 0.1 * math.log10(population / 15_000))
            if "capital" in place.flags:
                score += 0.05
        else:  # marine or region
            score = 0.66 if "curated" in place.flags else 0.62
        if place.alternate:
            score -= 0.12
        return score

    def _in_region(self, place: Place, region: str | None) -> bool:
        if not region or not place.country_code:
            return False
        if region == "middle-east":
            return place.country_code in _MIDDLE_EAST
        continents = _REGION_CONTINENTS.get(region)
        continent = (
            place.flags if place.kind == "country" else self.gazetteer.continent_of.get(place.country_code)
        )
        return bool(continents) and continent in continents

    def _score(
        self,
        place: Place,
        mention: _Mention,
        context: set[str],
        demonyms: set[str],
        neighbours: list[Place],
        region: str | None,
    ) -> float:
        score = self._base(place)
        if context and place.country_code and place.kind != "country":
            if place.country_code in context:
                score += 0.22
            elif place.kind in ("city", "admin1"):
                score -= 0.15
        if place.kind != "country" and place.country_code in demonyms and place.country_code not in context:
            score += 0.12
        if place.kind != "country" and any(_km(place, other) <= SUPPORT_KM for other in neighbours):
            score += 0.15
        if self._in_region(place, region):
            score += 0.05
        if mention.in_title:
            score += 0.04
        if mention.weak:
            score -= 0.08
        return score

    def _resolve(self, mentions: list[_Mention], demonyms: set[str], region: str | None) -> GeoResult | None:
        if not mentions:
            return None
        # Pass 1, no context: which countries does the item confidently involve?
        first_pass = []
        for mention in mentions:
            scored = [(self._score(p, mention, set(), demonyms, [], region), p) for p in mention.candidates]
            first_pass.append(max(scored, key=lambda pair: pair[0]))

        best: tuple[float, Place] | None = None
        for index, mention in enumerate(mentions):
            context = {
                place.country_code
                for other, (score, place) in enumerate(first_pass)
                if other != index
                and score >= 0.55
                and place.country_code
                and not mentions[other].speaker
                and not mentions[other].dateline
            }
            neighbours = [
                place
                for other, m in enumerate(mentions)
                if other != index
                for place in m.candidates
                if place.kind != "country"
            ]
            ranked = sorted(
                (
                    (self._score(p, mention, context, demonyms, neighbours, region), p)
                    for p in mention.candidates
                ),
                key=lambda pair: -pair[0],
            )
            top_score, top = ranked[0]
            rivals = [s for s, p in ranked[1:] if not _same_place(p, top)]
            if rivals:
                top_score -= max(0.0, 0.15 - (top_score - rivals[0]))
            if mention.speaker and (top.kind == "country" or "capital" in top.flags):
                top_score = min(top_score, 0.35)
            if mention.dateline:
                top_score = min(top_score, 0.35)
            ranked_score = top_score + _KIND_BONUS.get(top.kind, 0.0)
            if best is None or ranked_score > best[0] + 1e-9:
                best = (ranked_score, top)
        score, place = best
        confidence = round(min(0.95, score - _KIND_BONUS.get(place.kind, 0.0)), 3)
        if confidence < MIN_STORED_CONFIDENCE:
            return None
        return GeoResult(place.lat, place.lon, place.name, place.country_code, confidence, place.kind)
