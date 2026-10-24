"""Score the geoparser on the hand-labelled headline fixture.

Run from the repository root (PowerShell):
    uv run --project intel python intel/scripts/geo_eval.py [--verbose]

Precision: of the items placed on the globe, how many are in the right place.
Recall: of the items that have a location, how many reach the globe correctly.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

INTEL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INTEL))

from app.geo.gazetteer import Gazetteer  # noqa: E402
from app.geo.geoparse import GeoParser, GeoResult  # noqa: E402

FIXTURE = INTEL / "tests" / "fixtures" / "geo_headlines.json"


def correct(result: GeoResult | None, expect: list[str]) -> bool:
    if result is None or not result.on_globe:
        return False
    return any(
        (answer.startswith("place:") and result.place_name == answer[6:]) or answer == result.country_code
        for answer in expect
    )


def evaluate(parser: GeoParser, cases: list[dict]) -> dict:
    results = parser.parse_many((c["title"], c.get("summary", ""), c.get("region")) for c in cases)
    placed = [
        (case, result) for case, result in zip(cases, results, strict=True) if result and result.on_globe
    ]
    right = sum(correct(result, case["expect"]) for case, result in placed)
    expected = sum(1 for case in cases if case["expect"])
    return {
        "cases": len(cases),
        "placed": len(placed),
        "correct": right,
        "expected_located": expected,
        "precision": round(right / len(placed), 3) if placed else 1.0,
        "recall": round(right / expected, 3) if expected else 1.0,
        "rows": list(zip(cases, results, strict=True)),
    }


def main() -> None:
    args = argparse.ArgumentParser()
    args.add_argument("--verbose", action="store_true")
    verbose = args.parse_args().verbose
    cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
    report = evaluate(GeoParser(Gazetteer.load()), cases)
    if verbose:
        for case, result in report["rows"]:
            mark = (
                "ok "
                if correct(result, case["expect"])
                else ("-- " if not case["expect"] and not (result and result.on_globe) else "XX ")
            )
            got = f"{result.place_name} [{result.country_code}] {result.confidence}" if result else "none"
            print(f"{mark}{case['title'][:62]:62} expect={case['expect']} got={got}")
    print({k: v for k, v in report.items() if k != "rows"})


if __name__ == "__main__":
    main()
