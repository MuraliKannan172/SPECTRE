"""Service settings from the environment and the repository's `.env`.

Process environment wins over `.env`. The Non-commercial sources switch
(SPECTRE_NONCOMMERCIAL_SOURCES, written to `.env` by the app's Provider
Settings) is re-read on every poll cycle, so toggling it needs no restart.

SPECTRE was called SKYNET until 2026-10-28: a setting still named `SKYNET_*`
is read when its `SPECTRE_*` name is absent from the same source, with one
deprecation warning per name. Remove the fallback in the release after next.
"""

from __future__ import annotations

import logging
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

INTEL_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = INTEL_DIR.parent
BRANDING_JS = REPO_ROOT / "src" / "branding.js"

NON_COMMERCIAL_SOURCES_ENV = "SPECTRE_NONCOMMERCIAL_SOURCES"
# Chosen by the Phase 4 eval (docs/phase4/neural-core-eval.md): qwen3.5 made no
# model errors in two runs; bonsai, fully on the GPU and about twice as fast,
# is the low-resource choice.
DEFAULT_MODEL = "qwen3.5-9b-64k-gpu:latest"
LOW_RESOURCE_MODEL = "bonsai-2:9b"
# Token budgets per turn for a 16k context. Also the ceiling for API providers,
# whatever their window: every token is billed (ADR-002 D9).
FULL_BUDGETS = {"history": 3000, "web": 6000, "page": 2500}


def budgets_for(num_ctx: int) -> dict[str, int]:
    """Token budgets per turn (ADR-001 D5); 8k contexts get the small set."""
    if num_ctx <= 8192:
        return {"history": 1500, "web": 2500, "page": 1200}
    return dict(FULL_BUDGETS)


_TRUTHY = {"1", "true", "yes", "on"}
MIN_POLL_SECONDS = 30
BRAND_PREFIX = "SPECTRE_"
DEFAULT_DB = INTEL_DIR / "data" / "spectre.db"
DEFAULT_LOGS = REPO_ROOT / ".spectre-logs"
LEGACY_PREFIX = "SKYNET_"

log = logging.getLogger("spectre.intel")
_warned_legacy: set[str] = set()


def lookup(name: str, *sources: Mapping[str, str]) -> str | None:
    """`name` from the first source that has it. Within one source the
    `SPECTRE_*` name beats its old `SKYNET_*` name; the process environment
    is passed first, so it beats `.env` whichever name each uses."""
    legacy = LEGACY_PREFIX + name[len(BRAND_PREFIX) :] if name.startswith(BRAND_PREFIX) else None
    for source in sources:
        if name in source:
            return source[name]
        if legacy and legacy in source:
            if legacy not in _warned_legacy:
                _warned_legacy.add(legacy)
                log.warning("%s is deprecated: rename it to %s (works for one more release)", legacy, name)
            return source[legacy]
    return None


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
        return "SPECTRE", "0.1"
    name = re.search(r"\bname:\s*'([^']+)'", text)
    version = re.search(r"\bversion:\s*'([^']+)'", text)
    return (name.group(1) if name else "SPECTRE", version.group(1) if version else "0.1")


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
    ollama_model: str = DEFAULT_MODEL
    ollama_num_ctx: int = 16384
    ollama_keep_alive: str = "5m"
    ollama_think: bool = False
    low_resource: bool = False
    search_provider: str = "ddgs"
    searxng_url: str | None = None
    brave_api_key: str | None = None
    tavily_api_key: str | None = None
    chat_turns_per_minute: int = 12
    logs_dir: Path = DEFAULT_LOGS
    # Local voice (Phase 5): opt-in install, see intel/app/voice/models.py.
    voice_enabled: bool = True
    voice_dir: Path = INTEL_DIR / "data" / "voice"
    voice_threads: int = 8
    tts_voice: str = "af_heart"

    @property
    def num_ctx(self) -> int:
        """Low-resource mode caps the context at 8192 tokens."""
        return min(self.ollama_num_ctx, 8192) if self.low_resource else self.ollama_num_ctx

    @property
    def budgets(self) -> dict[str, int]:
        """Token budgets per turn (ADR-001 D5); 8k contexts get the small set."""
        return budgets_for(self.num_ctx)

    @property
    def stale_after_seconds(self) -> int:
        return 3 * self.poll_seconds

    def env(self, name: str, environ: Mapping[str, str] | None = None) -> str | None:
        environ = os.environ if environ is None else environ
        value = lookup(name, environ)
        return value if value is not None else lookup(name, read_env_file(self.env_file))

    def noncommercial_enabled(self, environ: Mapping[str, str] | None = None) -> bool:
        value = self.env(NON_COMMERCIAL_SOURCES_ENV, environ)
        return (value or "").strip().lower() in _TRUTHY


def load_settings(environ: Mapping[str, str] | None = None) -> Settings:
    environ = os.environ if environ is None else environ
    env_file = Path(lookup("SPECTRE_ENV_FILE", environ) or REPO_ROOT / ".env")
    file_values = read_env_file(env_file)

    def get(name: str, default: str) -> str:
        value = lookup(name, environ, file_values)
        return default if value is None else value

    def get_int(name: str, default: int, minimum: int) -> int:
        try:
            return max(minimum, int(get(name, str(default))))
        except ValueError as error:
            raise ValueError(f"{name} must be a whole number") from error

    hosts = tuple(h.strip() for h in get("SPECTRE_INTEL_ALLOWED_HOSTS", "").split(",") if h.strip())
    low_resource = get("SPECTRE_LOW_RESOURCE", "0").strip().lower() in _TRUTHY
    return Settings(
        db_path=Path(get("SPECTRE_INTEL_DB", str(DEFAULT_DB))),
        feeds_default=Path(get("SPECTRE_INTEL_FEEDS", str(INTEL_DIR / "feeds.default.yaml"))),
        feeds_local=Path(get("SPECTRE_INTEL_FEEDS_LOCAL", str(INTEL_DIR / "feeds.local.yaml"))),
        env_file=env_file,
        poll_seconds=get_int("SPECTRE_INTEL_POLL_SECONDS", 300, MIN_POLL_SECONDS),
        retention_days=get_int("SPECTRE_INTEL_RETENTION_DAYS", 30, 1),
        gdelt_enabled=get("SPECTRE_INTEL_GDELT", "1").strip().lower() in _TRUTHY,
        allowed_hosts=hosts or Settings.allowed_hosts,
        ollama_host=ollama_base_url(get("OLLAMA_HOST", "")),
        ollama_model=get("OLLAMA_MODEL", "").strip()
        or (LOW_RESOURCE_MODEL if low_resource else DEFAULT_MODEL),
        ollama_num_ctx=get_int("OLLAMA_NUM_CTX", Settings.ollama_num_ctx, 2048),
        ollama_keep_alive=get("OLLAMA_KEEP_ALIVE", Settings.ollama_keep_alive).strip() or "5m",
        ollama_think=get("OLLAMA_THINK", "0").strip().lower() in _TRUTHY,
        low_resource=low_resource,
        search_provider=get("SPECTRE_SEARCH_PROVIDER", "ddgs").strip().lower() or "ddgs",
        searxng_url=get("SEARXNG_URL", "").strip() or None,
        brave_api_key=get("BRAVE_API_KEY", "").strip() or None,
        tavily_api_key=get("TAVILY_API_KEY", "").strip() or None,
        chat_turns_per_minute=get_int("SPECTRE_CHAT_TURNS_PER_MINUTE", 12, 1),
        voice_enabled=get("SPECTRE_VOICE", "1").strip().lower() in _TRUTHY,
        voice_dir=Path(get("SPECTRE_VOICE_DIR", str(Settings.voice_dir))),
        voice_threads=min(get_int("SPECTRE_VOICE_THREADS", Settings.voice_threads, 1), 32),
        tts_voice=get("SPECTRE_TTS_VOICE", Settings.tts_voice).strip() or Settings.tts_voice,
    )
