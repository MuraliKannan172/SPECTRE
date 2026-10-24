from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from app.geo.gazetteer import Gazetteer
from app.geo.geoparse import ON_GLOBE_CONFIDENCE, GeoParser

INTEL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INTEL / "scripts"))
from geo_eval import evaluate  # noqa: E402

FIXTURE = INTEL / "tests" / "fixtures" / "geo_headlines.json"


@pytest.fixture(scope="module")
def parser() -> GeoParser:
    return GeoParser(Gazetteer.load())


def test_gazetteer_records_its_sources_and_covers_every_kind() -> None:
    gazetteer = Gazetteer.load()
    sources = gazetteer.meta["sources"]
    assert sources["geonames_cities15000"]["license"].startswith("CC BY 4.0")
    assert len(sources["geonames_cities15000"]["sha256"]) == 64
    assert "Public domain" in sources["natural_earth"]["license"]
    counts = gazetteer.meta["counts"]
    assert counts["country"] > 200 and counts["city"] > 30_000 and counts["admin1"] > 4_000


def test_fixture_precision_and_recall_floors(parser: GeoParser) -> None:
    """Measured 2026-10-24: precision 1.0, recall 0.917 on 39 headlines.

    Floors sit a little below so a real regression fails while a one-case
    wobble from a spaCy model update does not.
    """
    cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
    report = evaluate(parser, cases)
    assert report["precision"] >= 0.93, report
    assert report["recall"] >= 0.85, report


@pytest.mark.parametrize(
    ("title", "summary", "expected_country"),
    [
        ("Protests continue in Georgia", "Crowds gathered in Tbilisi.", "GE"),
        ("Georgia officials certify results", "The count in Atlanta is complete.", "US"),
        ("Paris, Texas residents clean up after storm", "", "US"),
        ("Washington says it will send aid to Ukraine", "", "UA"),
    ],
)
def test_context_resolves_ambiguous_names(
    parser: GeoParser, title: str, summary: str, expected_country: str
) -> None:
    result = parser.parse(title, summary)
    assert result is not None and result.on_globe
    assert result.country_code == expected_country


def test_a_speaking_capital_is_not_an_event_location(parser: GeoParser) -> None:
    result = parser.parse("Moscow condemns new EU sanctions package")
    assert result is None or result.confidence < ON_GLOBE_CONFIDENCE


def test_people_are_never_places(parser: GeoParser) -> None:
    for title in (
        "Jordan Peterson says new book is coming",
        "Chad Smith wins national award",
        "Putin and Xi hold talks",
    ):
        result = parser.parse(title)
        assert result is None or not result.on_globe, (title, result)


def test_items_without_places_have_no_location(parser: GeoParser) -> None:
    assert parser.parse("Global stocks slide as investors weigh rate outlook") is None
    assert parser.parse("") is None
