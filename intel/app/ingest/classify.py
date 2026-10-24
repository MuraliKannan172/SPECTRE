"""Deterministic keyword categories and severity for news items.

Rules come first because they are cheap, explainable and testable; nothing
here calls a model. Title hits weigh twice what summary hits do, ties go to the
earlier category in CATEGORY_ORDER, and an item with no hit keeps its feed's
default category.

Severity: 1 routine, 2 elevated, 3 high, 4 alert. Level 4 is reserved for
true alerts (red alerts, tsunami warnings, mass casualties); the UI shows it
with icon and label, not colour alone.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

CATEGORY_ORDER = (
    "disaster",
    "conflict",
    "cyber",
    "health",
    "space",
    "science",
    "economy",
    "politics",
    "world",
)

_KEYWORDS: dict[str, tuple[str, ...]] = {
    "disaster": (
        r"earthquakes?",
        r"quakes?",
        r"tsunamis?",
        r"hurricanes?",
        r"typhoons?",
        r"cyclones?",
        r"tropical storms?",
        r"floods?",
        r"flooding",
        r"flash floods?",
        r"wildfires?",
        r"bushfires?",
        r"forest fires?",
        r"landslides?",
        r"mudslides?",
        r"volcan\w*",
        r"eruptions?",
        r"droughts?",
        r"heatwaves?",
        r"heat waves?",
        r"tornado(?:es)?",
        r"blizzards?",
        r"avalanches?",
        r"storm surge",
        r"evacuat\w+",
        r"disaster\w*",
        r"magnitude",
        r"seismic",
    ),
    "conflict": (
        r"war",
        r"wars",
        r"warfare",
        r"military",
        r"troops?",
        r"soldiers?",
        r"armed",
        r"missiles?",
        r"drones? strikes?",
        r"air ?strikes?",
        r"airstrikes?",
        r"shelling",
        r"artillery",
        r"invasion",
        r"ceasefire",
        r"cease-fire",
        r"insurgen\w+",
        r"militants?",
        r"rebels?",
        r"terror\w*",
        r"bomb\w*",
        r"clashes",
        r"offensive",
        r"navy",
        r"naval",
        r"warships?",
        r"defen[cs]e ministry",
        r"pentagon",
        r"nato",
        r"nuclear weapons?",
        r"hostages?",
        r"peacekeep\w+",
        r"coup",
    ),
    "cyber": (
        r"cyber\w*",
        r"hack\w*",
        r"ransomware",
        r"malware",
        r"phishing",
        r"botnets?",
        r"data breach\w*",
        r"security breach\w*",
        r"vulnerabilit\w+",
        r"cve-\d{4}-\d+",
        r"zero-day",
        r"0-day",
        r"exploit\w*",
        r"ddos",
        r"spyware",
        r"security (?:patch|update)\w*",
        r"patch tuesday",
        r"cisa",
    ),
    "health": (
        r"outbreaks?",
        r"epidemics?",
        r"pandemics?",
        r"virus\w*",
        r"vaccin\w+",
        r"cholera",
        r"measles",
        r"mpox",
        r"ebola",
        r"dengue",
        r"malaria",
        r"influenza",
        r"bird flu",
        r"avian",
        r"polio",
        r"tuberculosis",
        r"infections?",
        r"disease\w*",
        r"hospitals?",
        r"world health organi[sz]ation",
        r"health",
    ),
    "space": (
        r"nasa",
        r"esa",
        r"spacex",
        r"rockets?",
        r"orbit\w*",
        r"launch\w* (?:of )?(?:a |an |the )?(?:rocket|satellite|mission|probe|spacecraft)",
        r"satellites?",
        r"spacecraft",
        r"astronauts?",
        r"space station",
        r"iss",
        r"moon",
        r"lunar",
        r"mars",
        r"asteroids?",
        r"comets?",
        r"telescope",
        r"solar flare",
        r"space weather",
        r"geomagnetic",
    ),
    "science": (
        r"scientists?",
        r"researchers?",
        r"study",
        r"studies",
        r"discover\w*",
        r"climate change",
        r"climate",
        r"emissions?",
        r"carbon",
        r"glaciers?",
        r"ocean\w*",
        r"species",
        r"biodiversity",
        r"genetic\w*",
        r"physics",
    ),
    "economy": (
        r"econom\w+",
        r"inflation",
        r"interest rates?",
        r"central bank",
        r"gdp",
        r"recession",
        r"markets?",
        r"stocks?",
        r"shares",
        r"trade",
        r"tariffs?",
        r"exports?",
        r"imports?",
        r"oil prices?",
        r"jobs report",
        r"unemployment",
        r"budget",
        r"debt",
        r"imf",
        r"world bank",
        r"federal reserve",
        r"currency",
    ),
    "politics": (
        r"elections?",
        r"vot\w+",
        r"parliament\w*",
        r"president\w*",
        r"prime minister",
        r"government",
        r"ministers?",
        r"sanctions?",
        r"diplomat\w*",
        r"summit",
        r"treaty",
        r"protests?",
        r"protesters?",
        r"legislat\w+",
        r"senate",
        r"congress",
        r"referendum",
        r"opposition",
    ),
}

_ALERT = (
    r"red alert",
    r"tsunami (?:warnings?|alerts?)",
    r"mass casualt\w+",
    r"state of emergency",
    r"magnitude (?:[7-9])(?:\.\d)?",
    r"m ?[7-9]\.\d",
    r"nuclear (?:accident|incident|leak)",
    r"radiation leak",
    r"pandemic declared",
    r"category [45] (?:hurricane|storm)",
)
_HIGH = (
    r"kill\w*",
    r"dead",
    r"deaths?",
    r"death toll",
    r"dies",
    r"died",
    r"fatalit\w+",
    r"massacre",
    r"orange alert",
    r"magnitude [6](?:\.\d)?",
    r"m ?6\.\d",
    r"actively exploited",
    r"zero-day",
    r"critical vulnerabilit\w+",
    r"invasion",
    r"missile strikes?",
    r"explosions?",
    r"collapsed?",
)
_ELEVATED = (
    r"attacks?",
    r"strikes?",
    r"injur\w+",
    r"wounded",
    r"evacuat\w+",
    r"warnings?",
    r"outbreaks?",
    r"ransomware",
    r"breach\w*",
    r"wildfires?",
    r"hurricanes?",
    r"cyclones?",
    r"typhoons?",
    r"earthquakes?",
    r"floods?",
    r"emergency",
    r"crisis",
    r"clashes",
    r"shelling",
)


def _compile(patterns: tuple[str, ...]) -> re.Pattern[str]:
    return re.compile(r"\b(?:" + "|".join(patterns) + r")\b", re.IGNORECASE)


_CATEGORY_RES = {category: _compile(words) for category, words in _KEYWORDS.items()}
_ALERT_RE = _compile(_ALERT)
_HIGH_RE = _compile(_HIGH)
_ELEVATED_RE = _compile(_ELEVATED)


@dataclass(frozen=True)
class Classification:
    category: str
    severity: int


def categorize(title: str, summary: str = "", default: str = "world") -> str:
    scores: dict[str, int] = {}
    for category, pattern in _CATEGORY_RES.items():
        score = 2 * len(pattern.findall(title)) + len(pattern.findall(summary))
        if score:
            scores[category] = score
    if not scores:
        return default if default in CATEGORY_ORDER else "world"
    best = max(scores.values())
    return next(category for category in CATEGORY_ORDER if scores.get(category) == best)


def severity(title: str, summary: str = "") -> int:
    text = f"{title}\n{summary}"
    if _ALERT_RE.search(text):
        return 4
    if _HIGH_RE.search(title):
        return 3
    if _ELEVATED_RE.search(title) or _HIGH_RE.search(summary):
        return 2
    return 1


def classify(title: str, summary: str = "", default: str = "world") -> Classification:
    return Classification(categorize(title, summary, default), severity(title, summary))
