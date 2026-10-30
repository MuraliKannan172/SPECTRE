"""What the SDK-based adapters share (ADR-002 D1, D8): where an endpoint
runs, whether a key may travel to it, and the mapping from SDK errors to the
taxonomy.

SDK exceptions never leave an adapter: they carry the response (whose request
holds the Authorization header) and a body that can echo the key. Adapters
map them with `provider_error`, and raise the result outside the `except`
block, so the new error has no `__context__` pointing back at the SDK one.
"""

from __future__ import annotations

import ipaddress
import json
from typing import Any
from urllib.parse import urlsplit

import anthropic
import httpx2
import openai

from . import errors
from .base import DEFAULT_MAX_OUTPUT as DEFAULT_MAX_OUTPUT  # the adapters import it from here
from .base import Kind
from .errors import ProviderError, code_for_status, retry_after_seconds

# Replies stream, so there is no total timeout; a stalled read still ends.
TIMEOUT = httpx2.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0)
LIST_TTL_SECONDS = 600.0

_LOOPBACK = {"localhost", "127.0.0.1", "::1"}
_CONTEXT_MARKERS = (
    "context_length_exceeded",
    "context length",
    "maximum context",
    "prompt is too long",
    "too many tokens",
    "input is too long",
    "request_too_large",
)
_QUOTA_MARKERS = ("insufficient_quota", "enforced_spend_limit_reached", "billing_error")
_MODERATION_MARKERS = ("moderation", "flagged")
# Anthropic's error.type values (§1.4), whatever the HTTP status (a mid-stream
# `error` event arrives on a 200).
_ANTHROPIC_TYPES = {
    "authentication_error": errors.AUTH_FAILED,
    "permission_error": errors.AUTH_FAILED,
    "billing_error": errors.QUOTA_EXCEEDED,
    "rate_limit_error": errors.RATE_LIMITED,
    "overloaded_error": errors.PROVIDER_UNAVAILABLE,
    "api_error": errors.PROVIDER_UNAVAILABLE,
    "not_found_error": errors.MODEL_NOT_FOUND,
    "request_too_large": errors.CONTEXT_TOO_LONG,
}


def endpoint_kind(base_url: str) -> Kind:
    """LOCAL on this machine, REMOTE on a private network, CLOUD otherwise."""
    host = (urlsplit(base_url).hostname or "").lower()
    if host in _LOOPBACK:
        return "local"
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        local_name = "." not in host or host.endswith((".local", ".lan", ".home.arpa"))
        return "remote" if local_name else "cloud"
    if address.is_loopback:
        return "local"
    return "remote" if address.is_private or address.is_link_local else "cloud"


def key_may_travel(base_url: str) -> bool:
    """A key goes over https, or plain http to this machine only."""
    parts = urlsplit(base_url)
    return parts.scheme == "https" or (parts.hostname or "").lower() in _LOOPBACK


def _inner(body: Any) -> dict[str, Any]:
    if isinstance(body, dict):
        inner = body.get("error")
        return inner if isinstance(inner, dict) else body
    return {}


def _message(body: Any, fallback: str) -> str:
    message = _inner(body).get("message")
    return str(message if message else fallback)[:300]


def classify(status: int | None, body: Any, text: str = "") -> str:
    """The taxonomy code for an HTTP status and error body (D8)."""
    inner = _inner(body)
    blob = (json.dumps(body, default=str) if body is not None else "") + " " + text
    blob = blob.lower()
    if status == 401:
        return errors.AUTH_FAILED
    if any(marker in blob for marker in _CONTEXT_MARKERS):
        return errors.CONTEXT_TOO_LONG
    if any(marker in blob for marker in _QUOTA_MARKERS):
        return errors.QUOTA_EXCEEDED
    if "insufficient_system_resource" in blob:
        return errors.PROVIDER_UNAVAILABLE
    if "rate_limit" in blob:  # also mid-stream, where there is no status
        return errors.RATE_LIMITED
    mapped = _ANTHROPIC_TYPES.get(str(inner.get("type") or ""))
    if mapped:
        return mapped
    if status == 403 and any(marker in blob for marker in _MODERATION_MARKERS):
        return errors.UNSUPPORTED_FEATURE
    if status and status >= 300:
        return code_for_status(status)
    code = inner.get("code")  # a mid-stream OpenRouter error carries its status here
    if isinstance(code, int) or (isinstance(code, str) and code.isdigit()):
        return code_for_status(int(code))
    return errors.PROVIDER_UNAVAILABLE


def provider_error(error: Exception, provider: str) -> ProviderError:
    """Map an SDK or transport exception. Raise the result outside `except`."""
    if isinstance(error, (openai.APIConnectionError, anthropic.APIConnectionError, httpx2.HTTPError)):
        return ProviderError(errors.NETWORK, type(error).__name__, provider=provider)
    status = getattr(error, "status_code", None)
    body = getattr(error, "body", None)
    response = getattr(error, "response", None)
    headers = response.headers if response is not None else {}
    code = classify(status, body, str(getattr(error, "message", "") or ""))
    return ProviderError(
        code,
        _message(body, str(getattr(error, "message", "") or type(error).__name__)),
        provider=provider,
        detail=str(_inner(body).get("code") or _inner(body).get("type") or ""),
        status=status,
        retry_after=retry_after_seconds(headers.get("retry-after")),
    )


SDK_ERRORS = (openai.APIError, anthropic.APIError, httpx2.HTTPError)
