from __future__ import annotations

from app.ingest.classify import classify
from app.ingest.dedupe import Candidate, DedupeIndex, normalise_title
from app.ingest.normalize import (
    SUMMARY_MAX,
    canonical_url,
    clean_summary,
    clean_title,
    safe_link,
    url_hash,
)

# -- links --------------------------------------------------------------------


def test_canonical_url_drops_tracking_scheme_www_amp_and_fragment() -> None:
    same = [
        "https://www.example.com/world/story-1?utm_source=rss&utm_medium=feed#top",
        "http://example.com/world/story-1/",
        "https://amp.example.com/world/story-1/amp",
        "https://example.com/world/story-1?fbclid=abc&ocid=xyz",
        "https://www-example-com.cdn.ampproject.org/c/s/example.com/world/story-1",
    ]
    assert {canonical_url(url) for url in same} == {"example.com/world/story-1"}
    assert len({url_hash(url) for url in same}) == 1


def test_canonical_url_keeps_meaningful_query_in_stable_order() -> None:
    a = canonical_url("https://example.com/article?b=2&id=7&utm_campaign=x")
    b = canonical_url("https://example.com/article?id=7&b=2")
    assert a == b == "example.com/article?b=2&id=7"
    assert canonical_url("https://example.com/a?id=1") != canonical_url("https://example.com/a?id=2")


def test_only_http_links_are_kept() -> None:
    assert safe_link(" https://example.com/a ") == "https://example.com/a"
    for bad in [
        "javascript:alert(1)",
        "data:text/html,<script>",
        "ftp://example.com/x",
        "/relative/path",
        "https://",
        'https://example.com/a"onmouseover="x',
        None,
        "",
    ]:
        assert safe_link(bad) is None, bad


# -- text ---------------------------------------------------------------------


def test_summary_is_plain_text_capped_and_not_a_body() -> None:
    raw = (
        "<p>Rescue teams <b>reached</b> the area &amp; began work.</p>"
        "<script>alert(1)</script><img src=x onerror=alert(2)>"
        "<p>The post Rescue continues appeared first on Example News.</p>"
    )
    assert clean_summary(raw) == "Rescue teams reached the area & began work."
    long_text = "word " * 400
    summary = clean_summary(long_text)
    assert len(summary) <= SUMMARY_MAX
    assert summary.endswith("…")
    assert clean_summary("<p>Same as title</p>", title="Same as title") == ""
    assert clean_title("  Breaking:\n <em>Storm</em>  hits coast ") == "Breaking: Storm hits coast"


# -- categories and severity --------------------------------------------------


def test_classifier_picks_categories_by_keyword_weight() -> None:
    cases = {
        "Magnitude 6.4 earthquake strikes off coast of Chile": ("disaster", 3),
        "Ransomware gang claims attack on hospital network": ("cyber", 2),
        "CISA adds actively exploited flaw to known vulnerabilities catalog": ("cyber", 3),
        "Missile strikes kill 12 as ceasefire talks stall": ("conflict", 3),
        "Central bank holds interest rates as inflation cools": ("economy", 1),
        "NASA rocket launch puts weather satellite into orbit": ("space", 1),
        "Cholera outbreak spreads in refugee camps": ("health", 2),
        "Tsunami warning issued after magnitude 7.8 quake": ("disaster", 4),
        "Parliament votes on new election law": ("politics", 1),
    }
    for title, expected in cases.items():
        got = classify(title)
        assert (got.category, got.severity) == expected, title


def test_unmatched_items_keep_the_feed_category() -> None:
    assert classify("Quarterly report published", default="economy").category == "economy"
    assert classify("Quarterly report published", default="bogus").category == "world"
    # Common words must not trip a category on their own.
    assert classify("The man who launched a bakery").category == "world"


# -- clustering ---------------------------------------------------------------


def test_title_normalisation_strips_outlet_suffix() -> None:
    assert normalise_title("Floods hit Kenya's coast — Example News") == "floods hit kenya s coast"
    assert normalise_title("Café owners protest | Le Monde") == "cafe owners protest"


def test_same_event_from_two_outlets_clusters() -> None:
    index = DedupeIndex()
    index.add(1, "Powerful earthquake strikes northern Japan, tsunami alert issued", 1_000, {"a"})
    match = index.match(
        Candidate("Powerful earthquake strikes northern Japan; tsunami alert issued - Outlet", "b", 2_000)
    )
    assert match == 1


def test_guards_against_false_clusters() -> None:
    index = DedupeIndex()
    index.add(1, "Floods force thousands from homes in Kenya", 1_000, {"a"}, country_code="KE")
    # Same wording, different country: a different event.
    assert index.match(Candidate("Floods force thousands from homes in Malawi", "b", 1_100, "MW")) is None
    # Same outlet: its own follow-up stays a separate story.
    assert index.match(Candidate("Floods force thousands from homes in Kenya", "a", 1_100, "KE")) is None
    # Too short to judge.
    index.add(2, "Live updates", 1_000, {"a"})
    assert index.match(Candidate("Live updates", "b", 1_100)) is None
    # Outside the 48 h window.
    assert (
        index.match(Candidate("Floods force thousands from homes in Kenya", "b", 1_000 + 49 * 3600)) is None
    )
    # Same country, far apart.
    index.add(
        3, "Wildfire forces evacuations near the town of Paradise", 1_000, {"a"}, lat=39.76, lon=-121.62
    )
    far = Candidate("Wildfire forces evacuations near the town of Paradise", "b", 1_100, lat=25.8, lon=-80.2)
    assert index.match(far) is None


def test_index_prunes_old_entries() -> None:
    index = DedupeIndex()
    index.add(1, "Old story about something long gone", 0, {"a"})
    index.add(2, "Recent story about something current", 49 * 3600, {"a"})
    index.prune(now=49 * 3600 + 10)
    assert len(index) == 1
