"""The key redactor (ADR-002 D5): patterns, known values, log records."""

from __future__ import annotations

import io
import logging

import pytest
from uvicorn.logging import AccessFormatter

from app.chat.providers import errors
from app.chat.providers.errors import ProviderError
from app.redact import MASK, install_log_redaction, redact, register

CANARY = "sk-test-CANARY-0123456789abcdef"


@pytest.mark.parametrize(
    "secret",
    [
        CANARY,
        "sk-ant-api03-AbCdEf123456_ghij-KLMN",
        "sk-proj-AbCdEf123456",
        "sk-or-v1-0123456789abcdef0123456789abcdef",
        "nvapi-AbCdEf123456_XYZ",
        "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8",
    ],
)
def test_key_shaped_text_is_masked(secret: str) -> None:
    out = redact(f"Incorrect API key provided: {secret}. See docs.")
    assert secret not in out and MASK in out and out.startswith("Incorrect API key provided: ")


@pytest.mark.parametrize(
    ("text", "kept"),
    [
        ("Authorization: Bearer abc.def-123456", "Bearer "),
        ("GET /v1/models?api_key=abc123456789&page=2", "api_key="),
        ('{"x-api-key": "zzzzzzzzzzzz"}', '"x-api-key": "'),
    ],
)
def test_the_label_stays_and_the_value_goes(text: str, kept: str) -> None:
    out = redact(text)
    assert kept in out and MASK in out
    assert "abc.def-123456" not in out and "abc123456789" not in out and "zzzzzzzzzzzz" not in out


@pytest.mark.parametrize(
    "text",
    [
        "GET https://news.example/russia-ukraine-war-live-updates-2026-10-29-morning-briefing",
        "model qwen3.5-9b-64k-gpu:latest is not installed",
        "risk-taking skeptics ask questions",
    ],
)
def test_ordinary_text_is_left_alone(text: str) -> None:
    assert redact(text) == text


def test_a_known_value_without_a_key_shape_is_masked_once_registered() -> None:
    custom = "lmstudio.local:custom/key"
    assert redact(f"auth {custom}") == f"auth {custom}"
    register(custom)
    assert redact(f"auth {custom}") == f"auth {MASK}"


def test_provider_errors_never_carry_a_key() -> None:
    error = ProviderError(errors.AUTH_FAILED, f"Incorrect API key provided: {CANARY}", detail=CANARY)
    assert CANARY not in str(error) and CANARY not in error.detail
    other = ProviderError(errors.RATE_LIMITED, f"slow down {CANARY}", detail=CANARY)
    assert CANARY not in str(other) and CANARY not in other.detail


@pytest.mark.parametrize(
    "echo",
    [
        "Incorrect API key provided: sk-proj-****…abcd.",
        "Incorrect API key provided: sk-abc***wxyz",
        "invalid key nvapi-ab**cdef",
        "key sk-ant-api03-****AbCd rejected",
        "Incorrect API key provided: ****************_6AA",
    ],
)
def test_masked_key_echoes_lose_prefix_and_suffix(echo: str) -> None:
    out = redact(echo)
    assert MASK in out
    for piece in ("abcd", "wxyz", "cdef", "AbCd", "_6AA", "sk-", "nvapi-"):
        assert piece not in out


def test_a_rejected_key_error_says_only_our_words() -> None:
    error = ProviderError(
        errors.AUTH_FAILED, "Incorrect API key provided: sk-pr****xy9", detail="invalid_api_key"
    )
    assert (str(error), error.detail) == (errors.AUTH_MESSAGE, "")


def test_log_output_is_redacted_including_tracebacks() -> None:
    install_log_redaction()
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    log = logging.getLogger("spectre.test.redact")
    log.addHandler(handler)
    log.propagate = False
    try:
        log.warning("sending %s to %s", CANARY, "https://api.example")
        log.warning(f"inline {CANARY}")
        try:
            raise RuntimeError(f"upstream said {CANARY}")
        except RuntimeError:
            log.exception("call failed")
        log.warning("object arg %s", ValueError(CANARY))
    finally:
        log.removeHandler(handler)
    out = stream.getvalue()
    assert CANARY not in out
    assert "sending [redacted] to https://api.example" in out
    assert "Traceback" in out and "RuntimeError: upstream said [redacted]" in out


def test_uvicorn_access_records_keep_their_shape() -> None:
    install_log_redaction()
    record = logging.getLogger("uvicorn.access").makeRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1:5000", "GET", "/api/intel/health", "1.1", 200),
        None,
    )
    line = AccessFormatter('%(client_addr)s - "%(request_line)s" %(status_code)s').format(record)
    assert line.startswith('127.0.0.1:5000 - "GET /api/intel/health HTTP/1.1" 200')
