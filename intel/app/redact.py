"""One redactor for API keys in logs, tracebacks and error messages (ADR-002 D5).

Two layers: every key value the key store has seen is replaced exactly, and
key-shaped text is replaced by pattern (`sk-…`, `sk-ant-…`, `nvapi-…`,
`Bearer …`, `api_key=…`, runs of 32+ letters and digits), so a key that
reaches a log before the store saw it is still hidden. Providers echo keys in
error bodies ("Incorrect API key provided: sk-…"), so ProviderError messages
pass through here too.
"""

from __future__ import annotations

import logging
import re
import threading
import traceback
from typing import Any

MASK = "[redacted]"
MIN_KNOWN_LENGTH = 8

_PATTERNS = (
    re.compile(r"\b(?:sk-ant|sk|nvapi)-[A-Za-z0-9_\-]{6,}"),
    re.compile(r"(?i)(\bbearer\s+)[A-Za-z0-9._~+/=\-]{6,}"),
    re.compile(r"(?i)(\b(?:x-)?api[_-]?key[\"']?\s*[:=]\s*[\"']?)[^\s\"',;&]{6,}"),
    # No hyphens here: hyphenated news URL slugs in the fetch logs stay readable.
    re.compile(r"\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}\b"),
)

_known: set[str] = set()
_known_lock = threading.Lock()
_installed = False


def register(value: str | None) -> None:
    """Remember a key value so it is replaced exactly wherever it appears."""
    if value and len(value) >= MIN_KNOWN_LENGTH:
        with _known_lock:
            _known.add(value)


def redact(text: str) -> str:
    if not text:
        return text
    with _known_lock:
        known = sorted(_known, key=len, reverse=True)
    for value in known:
        text = text.replace(value, MASK)
    for pattern in _PATTERNS:
        text = pattern.sub(lambda m: (m.group(1) if m.re.groups else "") + MASK, text)
    return text


def _redact_arg(value: Any) -> Any:
    if isinstance(value, str):
        return redact(value)
    if value is None or isinstance(value, (int, float)):
        return value
    return redact(str(value))


def redact_record(record: logging.LogRecord) -> logging.LogRecord:
    """Redact a log record in place: message, arguments, traceback and stack.

    Arguments keep their shape (uvicorn's access formatter unpacks a tuple);
    a traceback is formatted here and kept as text, since formatters reuse
    `exc_text` when it is set."""
    if isinstance(record.msg, str):
        record.msg = redact(record.msg)
    else:
        record.msg = redact(str(record.msg))
    if isinstance(record.args, tuple):
        record.args = tuple(_redact_arg(arg) for arg in record.args)
    elif isinstance(record.args, dict):
        record.args = {key: _redact_arg(arg) for key, arg in record.args.items()}
    if record.exc_info and record.exc_info[0] is not None:
        record.exc_text = redact("".join(traceback.format_exception(*record.exc_info)).rstrip("\n"))
        record.exc_info = None
    elif record.exc_text:
        record.exc_text = redact(record.exc_text)
    if record.stack_info:
        record.stack_info = redact(record.stack_info)
    return record


def install_log_redaction() -> None:
    """Redact every log record from every logger, at creation (idempotent)."""
    global _installed
    with _known_lock:
        if _installed:
            return
        _installed = True
    previous = logging.getLogRecordFactory()

    def factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
        return redact_record(previous(*args, **kwargs))

    logging.setLogRecordFactory(factory)
