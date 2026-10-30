"""Provider core (ADR-002 P1): canonical helpers, the error taxonomy, the
retry policy and the provider registry."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app.chat.ollama import OllamaError
from app.chat.providers import errors
from app.chat.providers.base import Done, TextDelta, normalize_args
from app.chat.providers.errors import ProviderError, code_for_status, retry_after_seconds
from app.chat.providers.mock import MockProvider
from app.chat.providers.ollama import host_kind, provider_error
from app.chat.providers.registry import (
    DEFAULT_PATH,
    ProviderConfigError,
    build_providers,
    load_specs,
)
from app.chat.providers.retry import MAX_RETRY_AFTER, backoff, stream_with_retries


def test_arguments_become_a_dict_whatever_the_provider_sent() -> None:
    assert normalize_args({"q": 1}) == {"q": 1}
    assert normalize_args('{"q": 1}') == {"q": 1}
    assert normalize_args("") == {}
    assert normalize_args(None) == {}
    assert normalize_args("{not json") == {"_unparsed": "{not json"}


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (401, errors.AUTH_FAILED),
        (403, errors.AUTH_FAILED),
        (402, errors.QUOTA_EXCEEDED),
        (404, errors.MODEL_NOT_FOUND),
        (413, errors.CONTEXT_TOO_LONG),
        (429, errors.RATE_LIMITED),
        (408, errors.PROVIDER_UNAVAILABLE),
        (500, errors.PROVIDER_UNAVAILABLE),
        (529, errors.PROVIDER_UNAVAILABLE),
        (400, errors.UNSUPPORTED_FEATURE),
    ],
)
def test_http_status_maps_onto_the_taxonomy(status: int, code: str) -> None:
    assert code_for_status(status) == code


def test_only_rate_limits_outages_and_network_errors_are_retryable() -> None:
    assert {code for code in errors.CODES if ProviderError(code).retryable} == {
        errors.RATE_LIMITED,
        errors.PROVIDER_UNAVAILABLE,
        errors.NETWORK,
    }
    with pytest.raises(ValueError):
        ProviderError("made_up")


def test_retry_after_reads_seconds_and_http_dates() -> None:
    assert retry_after_seconds("7") == 7.0
    assert retry_after_seconds("0.5") == 0.5
    assert retry_after_seconds("-3") == 0.0
    assert retry_after_seconds("Wed, 21 Oct 2015 07:28:10 GMT", now=1445412480.0) == 10.0
    assert retry_after_seconds("soon") is None
    assert retry_after_seconds(None) is None


# -- retry policy --------------------------------------------------------------


def _run(provider: MockProvider, *, attempts: int) -> tuple[list[object], list[float]]:
    slept: list[float] = []

    async def sleep(seconds: float) -> None:
        slept.append(seconds)

    async def go() -> list[object]:
        stream = stream_with_retries(
            lambda: provider.stream(None),  # type: ignore[arg-type]
            attempts=attempts,
            sleep=sleep,
            jitter=lambda: 0.5,
        )
        return [event async for event in stream]

    return asyncio.run(go()), slept


ANSWER = [TextDelta("ok"), Done("stop")]


def test_a_rate_limit_is_retried_after_its_retry_after() -> None:
    provider = MockProvider([[ProviderError(errors.RATE_LIMITED, retry_after=2.0)], ANSWER])
    events, slept = _run(provider, attempts=3)
    assert events == ANSWER and slept == [2.0] and provider.opened == 2


def test_an_outage_without_retry_after_backs_off_with_jitter() -> None:
    provider = MockProvider(
        [[ProviderError(errors.PROVIDER_UNAVAILABLE)], [ProviderError(errors.NETWORK)], ANSWER]
    )
    events, slept = _run(provider, attempts=3)
    assert events == ANSWER and slept == [backoff(1, jitter=0.5), backoff(2, jitter=0.5)]
    assert 0.25 <= backoff(1, jitter=0.0) <= backoff(1, jitter=0.99) < 0.5


@pytest.mark.parametrize("code", [errors.AUTH_FAILED, errors.QUOTA_EXCEEDED, errors.MODEL_NOT_FOUND])
def test_errors_that_retrying_cannot_fix_fail_at_once(code: str) -> None:
    provider = MockProvider([[ProviderError(code)], ANSWER])
    with pytest.raises(ProviderError) as raised:
        _run(provider, attempts=3)
    assert raised.value.code == code and provider.opened == 1


def test_retries_stop_after_the_attempt_limit() -> None:
    provider = MockProvider([[ProviderError(errors.NETWORK)]] * 3)
    with pytest.raises(ProviderError):
        _run(provider, attempts=3)
    assert provider.opened == 3


def test_a_retry_after_longer_than_the_cap_fails_now() -> None:
    provider = MockProvider([[ProviderError(errors.RATE_LIMITED, retry_after=MAX_RETRY_AFTER + 1)]])
    with pytest.raises(ProviderError):
        _run(provider, attempts=3)
    assert provider.opened == 1


def test_no_retry_once_text_has_been_sent() -> None:
    provider = MockProvider([[TextDelta("half"), ProviderError(errors.NETWORK)], ANSWER])
    with pytest.raises(ProviderError):
        _run(provider, attempts=3)
    assert provider.opened == 1


def test_closing_the_retrying_stream_closes_the_provider_stream() -> None:
    provider = MockProvider([[TextDelta("a"), TextDelta("b"), Done("stop")]])

    async def go() -> None:
        stream = stream_with_retries(lambda: provider.stream(None), attempts=3)  # type: ignore[arg-type]
        assert await anext(stream) == TextDelta("a")
        await stream.aclose()

    asyncio.run(go())
    assert provider.closed_early == 1


# -- Ollama mapping ------------------------------------------------------------


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (OllamaError("offline"), errors.NETWORK),
        (OllamaError("timeout"), errors.NETWORK),
        (OllamaError("model_missing", "m", status=404), errors.MODEL_NOT_FOUND),
        (OllamaError("not_found", "/api/show", status=404), errors.MODEL_NOT_FOUND),
        (OllamaError("http_status", "502", status=502), errors.PROVIDER_UNAVAILABLE),
        (OllamaError("http_status", "429", status=429, retry_after="4"), errors.RATE_LIMITED),
        (OllamaError("model_error", "boom"), errors.PROVIDER_UNAVAILABLE),
    ],
)
def test_ollama_errors_keep_their_code_and_gain_a_taxonomy_code(error: OllamaError, code: str) -> None:
    mapped = provider_error(error)
    assert (mapped.code, mapped.provider, mapped.detail) == (code, "ollama", error.code)
    if error.retry_after:
        assert mapped.retry_after == 4.0


@pytest.mark.parametrize(
    ("url", "kind"),
    [
        ("http://127.0.0.1:11434", "local"),
        ("http://localhost:11434", "local"),
        ("http://[::1]:11434", "local"),
        ("http://192.168.1.20:11434", "remote"),
        ("http://gpu-box:11434", "remote"),
    ],
)
def test_ollama_off_this_machine_is_remote(url: str, kind: str) -> None:
    assert host_kind(url) == kind


# -- registry ------------------------------------------------------------------


def _yaml(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "providers.yaml"
    path.write_text(body, encoding="utf-8")
    return path


ADAPTERS = {"ollama": object(), "mock": object()}


def test_the_shipped_provider_file_loads() -> None:
    adapters = dict.fromkeys(("ollama", "anthropic", "openai", "openai_compat"), object())
    specs = {spec.id: spec for spec in load_specs(DEFAULT_PATH, adapters)}
    assert list(specs) == ["ollama", "anthropic", "openai", "openrouter", "nvidia", "deepseek", "custom"]
    assert specs["ollama"].kind == "local" and specs["ollama"].key_env == ()
    assert all(spec.base_url.startswith("https://") for spec in specs.values() if spec.kind == "cloud")
    assert specs["custom"].key_optional and not specs["openai"].key_optional
    assert specs["openai"].key_env == ("OPENAI_API_KEY",), "shared with POWER UP's voice key (D5)"


@pytest.mark.parametrize(
    ("entry", "message"),
    [
        ("{id: Ollama, adapter: ollama, kind: local, base_url: 'http://x'}", "bad provider id"),
        ("{id: x1, adapter: nope, kind: local, base_url: 'http://x'}", "no adapter"),
        ("{id: x1, adapter: mock, kind: nearby, base_url: 'http://x'}", "kind must be"),
        ("{id: x1, adapter: mock, kind: cloud, base_url: 'ftp://x'}", "base_url"),
    ],
)
def test_a_bad_provider_entry_is_an_error(tmp_path: Path, entry: str, message: str) -> None:
    with pytest.raises(ProviderConfigError, match=message):
        load_specs(_yaml(tmp_path, f"providers:\n  - {entry}\n"), ADAPTERS)


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ("providers: [unclosed\n", "not valid YAML"),
        ("- just a list\n", "must map `providers` to a list"),
        ("providers: {id: x1}\n", "must map `providers` to a list"),
    ],
)
def test_a_malformed_provider_file_is_a_config_error(tmp_path: Path, body: str, message: str) -> None:
    with pytest.raises(ProviderConfigError, match=message):
        load_specs(_yaml(tmp_path, body), ADAPTERS)


def test_duplicate_provider_ids_are_an_error(tmp_path: Path) -> None:
    entry = "{id: x1, adapter: mock, kind: local, base_url: 'http://x'}"
    with pytest.raises(ProviderConfigError, match="unique"):
        load_specs(_yaml(tmp_path, f"providers:\n  - {entry}\n  - {entry}\n"), ADAPTERS)


def test_a_base_url_override_wins_over_the_file(tmp_path: Path) -> None:
    path = _yaml(tmp_path, "providers:\n  - {id: x1, adapter: mock, kind: local, base_url: 'http://a'}\n")
    built = build_providers(
        load_specs(path, ADAPTERS),
        {"mock": lambda spec, url, key: (spec.id, url, key())},  # type: ignore[dict-item]
        base_urls={"x1": "http://b"},
        key_for=lambda spec: f"key-for-{spec.id}",
    )
    assert built == {"x1": ("x1", "http://b", "key-for-x1")}
