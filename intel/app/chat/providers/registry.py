"""Which chat providers exist: `providers.default.yaml` (ADR-002 D1).

The file declares providers; adapters are built from it with their clients
and any user override of the base URL. An entry naming an adapter this
version does not have is an error, not a silent skip.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import yaml

from ..ollama import OllamaClient
from .base import ChatProvider, Kind
from .ollama import OllamaProvider

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "providers.default.yaml"
_ID = re.compile(r"^[a-z][a-z0-9_-]{1,31}$")
_KINDS = ("local", "remote", "cloud")


class ProviderConfigError(ValueError):
    pass


@dataclass(frozen=True)
class ProviderSpec:
    id: str
    label: str
    adapter: str
    kind: Kind
    base_url: str
    key_env: tuple[str, ...] = ()
    docs: str = ""
    key_optional: bool = False  # a custom server may take no key


def _spec(entry: Any, adapters: Mapping[str, object]) -> ProviderSpec:
    if not isinstance(entry, dict):
        raise ProviderConfigError(f"provider entry must be a mapping: {entry!r}")
    provider_id = str(entry.get("id") or "")
    if not _ID.match(provider_id):
        raise ProviderConfigError(f"bad provider id: {provider_id!r}")
    adapter = str(entry.get("adapter") or "")
    if adapter not in adapters:
        raise ProviderConfigError(f"{provider_id}: no adapter named {adapter!r}")
    kind = entry.get("kind")
    if kind not in _KINDS:
        raise ProviderConfigError(f"{provider_id}: kind must be one of {', '.join(_KINDS)}")
    base_url = str(entry.get("base_url") or "")
    if urlsplit(base_url).scheme not in ("http", "https") or not urlsplit(base_url).hostname:
        raise ProviderConfigError(f"{provider_id}: base_url must be an http(s) URL")
    return ProviderSpec(
        id=provider_id,
        label=str(entry.get("label") or provider_id),
        adapter=adapter,
        kind=kind,
        base_url=base_url,
        key_env=tuple(str(name) for name in entry.get("key_env") or ()),
        docs=str(entry.get("docs") or ""),
        key_optional=entry.get("key_optional") is True,
    )


_LOOPBACK = {"localhost", "127.0.0.1", "::1"}


def base_url_problem(url: str) -> str | None:
    """Why a user-supplied base URL is refused, or None. The URL receives the
    key, so it must be https, or http on this machine only (a local server)."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if parts.scheme not in ("http", "https") or not host:
        return "must be an http(s) URL"
    if parts.username or parts.password or parts.query or parts.fragment:
        return "must not carry credentials, a query or a fragment"
    if parts.scheme == "http" and host not in _LOOPBACK:
        return "must use https unless the server is on this machine"
    return None


def load_specs(path: Path, adapters: Mapping[str, object]) -> list[ProviderSpec]:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as error:
        raise ProviderConfigError(f"{path.name} is not valid YAML: {error}") from error
    if not isinstance(data, dict) or not isinstance(data.get("providers") or [], list):
        raise ProviderConfigError(f"{path.name} must map `providers` to a list")
    specs = [_spec(entry, adapters) for entry in data.get("providers") or []]
    ids = [spec.id for spec in specs]
    if len(ids) != len(set(ids)):
        raise ProviderConfigError("provider ids must be unique")
    return specs


KeyGetter = Callable[[], str | None]
# An adapter gets a key getter, never the key: a key saved later is used on
# the next request, and no adapter holds a key it could print.
Factory = Callable[[ProviderSpec, str, KeyGetter], ChatProvider]


def _no_key(spec: ProviderSpec) -> str | None:
    return None


def build_providers(
    specs: list[ProviderSpec],
    factories: Mapping[str, Factory],
    *,
    base_urls: Mapping[str, str] | None = None,
    key_for: Callable[[ProviderSpec], str | None] = _no_key,
) -> dict[str, ChatProvider]:
    """One adapter per spec; `base_urls` overrides a spec's default URL."""
    overrides = base_urls or {}
    return {
        spec.id: factories[spec.adapter](
            spec, overrides.get(spec.id) or spec.base_url, partial(key_for, spec)
        )
        for spec in specs
    }


@dataclass
class ProviderSet:
    """The running providers and what built them, so one can be rebuilt when
    its base URL changes."""

    specs: dict[str, ProviderSpec]
    providers: dict[str, ChatProvider]
    factories: Mapping[str, Factory]
    key_for: Callable[[ProviderSpec], str | None] = _no_key

    def get(self, provider_id: str) -> ChatProvider | None:
        return self.providers.get(provider_id)

    def rebuild(self, provider_id: str, base_url: str) -> ChatProvider:
        spec = self.specs[provider_id]
        provider = self.factories[spec.adapter](spec, base_url, partial(self.key_for, spec))
        self.providers = {**self.providers, provider_id: provider}
        return provider


def ollama_factory(http: httpx.AsyncClient) -> Factory:
    return lambda spec, url, key: OllamaProvider(OllamaClient(url, http))


def default_providers(
    *,
    ollama_http: httpx.AsyncClient,
    ollama_host: str,
    path: Path = DEFAULT_PATH,
    key_for: Callable[[ProviderSpec], str | None] = _no_key,
    base_urls: Mapping[str, str] | None = None,
    factories: Mapping[str, Factory] | None = None,
) -> ProviderSet:
    """The service's providers, from the YAML file. `base_urls` holds saved
    overrides; OLLAMA_HOST always wins for Ollama."""
    all_factories = {"ollama": ollama_factory(ollama_http), **(factories or {})}
    specs = load_specs(path, all_factories)
    urls = {**(base_urls or {}), "ollama": ollama_host}
    return ProviderSet(
        specs={spec.id: spec for spec in specs},
        providers=build_providers(specs, all_factories, base_urls=urls, key_for=key_for),
        factories=all_factories,
        key_for=key_for,
    )
