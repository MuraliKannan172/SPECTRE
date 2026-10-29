"""Which chat providers exist: `providers.default.yaml` (ADR-002 D1).

The file declares providers; adapters are built from it with their clients
and any user override of the base URL. An entry naming an adapter this
version does not have is an error, not a silent skip.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
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
    )


def load_specs(path: Path, adapters: Mapping[str, object]) -> list[ProviderSpec]:
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    specs = [_spec(entry, adapters) for entry in data.get("providers") or []]
    ids = [spec.id for spec in specs]
    if len(ids) != len(set(ids)):
        raise ProviderConfigError("provider ids must be unique")
    return specs


Factory = Callable[[ProviderSpec, str], ChatProvider]


def build_providers(
    specs: list[ProviderSpec],
    factories: Mapping[str, Factory],
    *,
    base_urls: Mapping[str, str] | None = None,
) -> dict[str, ChatProvider]:
    """One adapter per spec; `base_urls` overrides a spec's default URL."""
    overrides = base_urls or {}
    return {spec.id: factories[spec.adapter](spec, overrides.get(spec.id) or spec.base_url) for spec in specs}


def default_providers(
    *, ollama_http: httpx.AsyncClient, ollama_host: str, path: Path = DEFAULT_PATH
) -> dict[str, ChatProvider]:
    """The service's providers, from the YAML file. OLLAMA_HOST wins over the
    file's Ollama URL."""
    factories: dict[str, Factory] = {
        "ollama": lambda spec, url: OllamaProvider(OllamaClient(url, ollama_http)),
    }
    specs = load_specs(path, factories)
    return build_providers(specs, factories, base_urls={"ollama": ollama_host})
