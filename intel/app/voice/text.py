"""Answer text as it should be spoken: no citation numbers, markdown or links."""

from __future__ import annotations

import re

MAX_SPOKEN_CHARS = 600

_CITATIONS = re.compile(r"\s*\[\d{1,3}(?:\s*[,–-]\s*\d{1,3})*\]")
_MD_LINK = re.compile(r"\[([^\]]+)\]\((?:[^)\s]+)\)")
_URL = re.compile(r"\bhttps?://\S+|\bwww\.\S+", re.IGNORECASE)
_AS_OF = re.compile(r"(?im)^\s*\**as of\b.*$")
_EMPHASIS = re.compile(r"(\*{1,3}|_{2,3}|`+)")
_LINE_MARK = re.compile(r"(?m)^\s*(?:#{1,6}\s+|[-*+]\s+|\d{1,2}[.)]\s+|>\s*)")
_TABLE = re.compile(r"\s*\|\s*")
_SPACES = re.compile(r"\s+")


def speakable(text: str) -> str:
    """The words of an answer, ready for text to speech, at most MAX_SPOKEN_CHARS long."""
    text = _AS_OF.sub(" ", text or "")
    text = _MD_LINK.sub(r"\1", text)
    text = _URL.sub(" ", text)
    text = _CITATIONS.sub("", text)
    text = _LINE_MARK.sub(" ", text)
    text = _EMPHASIS.sub("", text)
    text = _TABLE.sub(", ", text)
    text = _SPACES.sub(" ", text).strip(" ,")
    if len(text) <= MAX_SPOKEN_CHARS:
        return text
    cut = text.rfind(" ", 0, MAX_SPOKEN_CHARS)
    return text[: cut if cut > 0 else MAX_SPOKEN_CHARS]
