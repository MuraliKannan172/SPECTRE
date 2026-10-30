"""The provider error taxonomy (ADR-002 D8).

Every adapter raises `ProviderError` with one of the codes below. `detail`
keeps the provider's own code (for Ollama, the codes the panel already
knows, such as "offline"). Only rate limits, an unavailable provider and
network failures are retried; authentication errors never are.
"""

from __future__ import annotations

import email.utils
import time

from ...redact import redact

AUTH_FAILED = "auth_failed"
RATE_LIMITED = "rate_limited"
QUOTA_EXCEEDED = "quota_exceeded"
MODEL_NOT_FOUND = "model_not_found"
CONTEXT_TOO_LONG = "context_too_long"
UNSUPPORTED_FEATURE = "unsupported_feature"
PROVIDER_UNAVAILABLE = "provider_unavailable"
NETWORK = "network"

CODES = frozenset(
    {
        AUTH_FAILED,
        RATE_LIMITED,
        QUOTA_EXCEEDED,
        MODEL_NOT_FOUND,
        CONTEXT_TOO_LONG,
        UNSUPPORTED_FEATURE,
        PROVIDER_UNAVAILABLE,
        NETWORK,
    }
)
RETRYABLE = frozenset({RATE_LIMITED, PROVIDER_UNAVAILABLE, NETWORK})
AUTH_MESSAGE = "The provider rejected the key."


class ProviderError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str = "",
        *,
        provider: str = "",
        detail: str = "",
        status: int | None = None,
        retry_after: float | None = None,
        ours: bool = False,
    ) -> None:
        if code not in CODES:
            raise ValueError(f"unknown provider error code: {code}")
        # Providers echo keys in error bodies; nothing past here may carry one.
        # A rejected key's error is where they echo it, masked in ways no
        # pattern can promise to catch, so its text is ours (ours=True: written
        # here, such as "no key is set"), never theirs.
        if code == AUTH_FAILED and not ours:
            message, detail = AUTH_MESSAGE, ""
        super().__init__(redact(message) or code)
        self.code = code
        self.provider = provider
        self.detail = redact(detail)
        self.status = status
        self.retry_after = retry_after

    @property
    def retryable(self) -> bool:
        return self.code in RETRYABLE


def code_for_status(status: int) -> str:
    """The taxonomy code for an HTTP status, before provider-specific
    refinements (a quota 429, a moderation 403) are applied."""
    if status == 401 or status == 403:
        return AUTH_FAILED
    if status == 402:
        return QUOTA_EXCEEDED
    if status == 404:
        return MODEL_NOT_FOUND
    if status == 413:
        return CONTEXT_TOO_LONG
    if status == 429:
        return RATE_LIMITED
    if status == 408 or status >= 500:
        return PROVIDER_UNAVAILABLE
    return UNSUPPORTED_FEATURE


def retry_after_seconds(value: str | None, *, now: float | None = None) -> float | None:
    """`Retry-After` as seconds: a number of seconds or an HTTP date."""
    if not value:
        return None
    value = value.strip()
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    return max(0.0, when.timestamp() - (time.time() if now is None else now))
