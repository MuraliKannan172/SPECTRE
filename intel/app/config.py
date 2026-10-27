"""Service settings from the environment and the repository's `.env`.

Process environment wins over `.env`. The Non-commercial sources switch
(SKYNET_NONCOMMERCIAL_SOURCES, written to `.env` by the app's Provider
Settings) is re-read on every poll cycle, so toggling it needs no restart.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

INTEL_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = INTEL_DIR.parent
BRANDING_JS = REPO_ROOT / "src" / "branding.js"

NON_COMMERCIAL_SOURCES_ENV = "SKYNET_NONCOMMERCIAL_SOURCES"
_TRUTHY = {"1", "true", "yes", "on"}
MIN_POLL_SECONDS = 30


def read_env_file(path: Path) -> dict[str, str]:
    """KEY=VALUE lines; comments, blanks and malformed lines are skipped."""
    values: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def _brand() -> tuple[str, str]:
    """Product name and version from src/branding.js, the single source."""
    try:
        text = BRANDING_JS.read_text(encoding="utf-8")
    except OSError:
        return "SKYNET", "0.1"
    name = re.search(r"\bname:\s*'([^']+)'", text)
    version = re.search(r"\bversion:\s*'([^']+)'", text)
    return (name.group(1) if name else "SKYNET", version.group(1) if version else "0.1")


BRAND_NAME, BRAND_VERSION = _brand()


def ollama_base_url(value: str) -> str:
    """OLLAMA_HOST as Ollama itself accepts it ("host:port", a bind address such
    as 0.0.0.0, or a URL) turned into a URL this service can call."""
    value = (value or "").strip().rstrip("/")
    if not value:
        return "http://127.0.0.1:11434"
    if "://" not in value:
        value = f"http://{value}"
    scheme, rest = value.split("://", 1)
    host, _, port = rest.partition(":")
    if host in {"0.0.0.0", "", "[::]"}:  # noqa: S104 (a bind address, never connected to)
        host = "127.0.0.1"
    return f"{scheme}://{host}:{port or '11434'}"


@dataclass(frozen=True)
class Settings:
    db_path: Path
    feeds_default: Path
    feeds_local: Path
    env_file: Path
    poll_seconds: int = 300
    retention_days: int = 30
    gdelt_enabled: bool = True
    max_concurrency: int = 6
    fetch_timeout_seconds: float = 20.0
    max_feed_bytes: int = 5 * 1024 * 1024
    heartbeat_seconds: float = 15.0
    allowed_hosts: tuple[str, ...] = ("127.0.0.1", "localhost", "[::1]")
    user_agent: str = f"{BRAND_NAME}-intel/{BRAND_VERSION}"
    # Neural Core (ADR-001 D5, D10).
    ollama_host: str = "http://127.0.0.1:11434"
    ollama_model: str = "bonsai-2:9b"
    ollama_num_ctx: int = 16384
    ollama_keep_alive: str = "5m"
    ollama_think: bool = False
    low_resource: bool = False
    search_provider: str = "ddgs"
    searxng_url: str | None = None
    brave_api_key: str | None = None
    tavily_api_key: str | None = None
    chat_turns_per_minute: int = 12
    logs_dir: Path = REPO_ROOT / ".skynet-logs"

    @property
    def num_ctx(self) -> int:
        """Low-resource mode caps the context at 8192 tokens."""
        return min(self.ollama_num_ctx, 8192) if self.low_resource else self.ollama_num_ctx

    @property
    def budgets(self) -> dict[str, int]:
        """Token budgets per turn (ADR-001 D5); 8k contexts get the small set."""
        if self.num_ctx <= 8192:
            return {"history": 1500, "web": 2500, "page": 1200}
        return {"history": 3000, "web": 6000, "page": 2500}

    @property
    def stale_after_seconds(self) -> int:
        return 3 * self.poll_seconds

    def env(self, name: str, environ: Mapping[str, str] | None = None) -> str | None:
        environ = os.environ if environ is None else environ
        if name in environ:
            return environ[name]
        return read_env_file(self.env_file).get(name)

    def noncommercial_enabled(self, environ: Mapping[str, str] | None = None) -> bool:
        value = self.env(NON_COMMERCIAL_SOURCES_ENV, environ)
        return (value or "").strip().lower() in _TRUTHY


def load_settings(environ: Mapping[str, str] | None = None) -> Settings:
    environ = os.environ if environ is None else environ
    env_file = Path(environ.get("SKYNET_ENV_FILE", REPO_ROOT / ".env"))
    file_values = read_env_file(env_file)

    def get(name: str, default: str) -> str:
        return environ.get(name, file_values.get(name, default))

    def get_int(name: str, default: int, minimum: int) -> int:
        try:
            return max(minimum, int(get(name, str(default))))
        except ValueError as error:
            raise ValueError(f"{name} must be a whole number") from error

    hosts = tuple(h.strip() for h in get("SKYNET_INTEL_ALLOWED_HOSTS", "").split(",") if h.strip())
    return Settings(
        db_path=Path(get("SKYNET_INTEL_DB", str(INTEL_DIR / "data" / "skynet.db"))),
        feeds_default=Path(get("SKYNET_INTEL_FEEDS", str(INTEL_DIR / "feeds.default.yaml"))),
        feeds_local=Path(get("SKYNET_INTEL_FEEDS_LOCAL", str(INTEL_DIR / "feeds.local.yaml"))),
        env_file=env_file,
        poll_seconds=get_int("SKYNET_INTEL_POLL_SECONDS", 300, MIN_POLL_SECONDS),
        retention_days=get_int("SKYNET_INTEL_RETENTION_DAYS", 30, 1),
        gdelt_enabled=get("SKYNET_INTEL_GDELT", "1").strip().lower() in _TRUTHY,
        allowed_hosts=hosts or Settings.allowed_hosts,
        ollama_host=ollama_base_url(get("OLLAMA_HOST", "")),
        ollama_model=get("OLLAMA_MODEL", Settings.ollama_model).strip() or Settings.ollama_model,
        ollama_num_ctx=get_int("OLLAMA_NUM_CTX", Settings.ollama_num_ctx, 2048),
        ollama_keep_alive=get("OLLAMA_KEEP_ALIVE", Settings.ollama_keep_alive).strip() or "5m",
        ollama_think=get("OLLAMA_THINK", "0").strip().lower() in _TRUTHY,
        low_resource=get("SKYNET_LOW_RESOURCE", "0").strip().lower() in _TRUTHY,
        search_provider=get("SKYNET_SEARCH_PROVIDER", "ddgs").strip().lower() or "ddgs",
        searxng_url=get("SEARXNG_URL", "").strip() or None,
        brave_api_key=get("BRAVE_API_KEY", "").strip() or None,
        tavily_api_key=get("TAVILY_API_KEY", "").strip() or None,
        chat_turns_per_minute=get_int("SKYNET_CHAT_TURNS_PER_MINUTE", 12, 1),
    )
