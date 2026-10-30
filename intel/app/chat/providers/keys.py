"""API keys for the Neural Core providers (ADR-002 D5).

Keys live in this service only; nothing here returns a key to a caller other
than the adapter that sends it. Reading follows a fixed precedence:

1. the process environment when the service started (read-only, "configured
   externally"),
2. the OS keyring (Windows Credential Manager), where SPECTRE writes,
3. the repo's `.env`, read on every lookup so a POWER UP save is seen without
   a restart, and written only when no keyring backend exists.

`.env` is shared with God's Eye View: an `OPENAI_API_KEY` saved there for
voice is found at step 3 and used for ChatGPT, not asked for twice.
"""

from __future__ import annotations

import logging
import os
import re
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from keyring.backend import KeyringBackend
from keyring.backends import fail, null
from keyring.errors import KeyringError, PasswordDeleteError

from ...config import read_env_file
from ...redact import register
from .registry import ProviderSpec

log = logging.getLogger("spectre.intel.keys")

SERVICE = "SPECTRE Neural Core"
# .env names another feature reads too: a chat key never rewrites them (voice uses this one).
SHARED_ENV = frozenset({"OPENAI_API_KEY"})
Source = Literal["environment", "keyring", "env_file"]
# Every provider's documented key format fits; unquoted in .env, no comment marker.
_VALUE = re.compile(r"^[A-Za-z0-9._~+/=:-]{8,512}$")


class KeyStoreError(Exception):
    """`code`: no_key (the provider takes none), external (set in the
    environment), bad_key, keyring_failed."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class KeyStatus:
    required: bool
    configured: bool
    source: Source | None
    env: tuple[str, ...]

    @property
    def writable(self) -> bool:
        return self.required and self.source != "environment"

    def public(self) -> dict[str, object]:
        """What the API may show: never a value, a prefix or a suffix (ADR-002 Q2)."""
        return {
            "required": self.required,
            "configured": self.configured,
            "source": self.source,
            "env": list(self.env),
            "writable": self.writable,
        }


def host_of(url: str) -> str:
    return (urlsplit(url).hostname or "").lower()


def key_reaches(spec: ProviderSpec, url: str, saved_for: str | None) -> bool:
    """A stored key goes to its provider's own host, or to the host it was
    saved for in the app. A base URL changed afterwards gets no key until the
    key is saved again there, so a settings write alone cannot redirect it."""
    return host_of(url) in {host_of(spec.base_url), saved_for}


def usable_backend(backend: KeyringBackend | None) -> KeyringBackend | None:
    """The backend, or None when it is keyring's "no backend" stand-in."""
    if backend is None or isinstance(backend, (fail.Keyring, null.Keyring)):
        return None
    return backend


class KeyStore:
    def __init__(
        self, *, boot_env: Mapping[str, str], env_file: Path, backend: KeyringBackend | None
    ) -> None:
        self._boot = dict(boot_env)
        self._env_file = env_file
        self._backend = usable_backend(backend)

    @property
    def keyring_available(self) -> bool:
        return self._backend is not None

    def _from_keyring(self, spec: ProviderSpec) -> str | None:
        if self._backend is None:
            return None
        try:
            return self._backend.get_password(SERVICE, spec.id)
        except KeyringError as error:
            log.warning("keyring read failed for %s: %s", spec.id, type(error).__name__)
            return None

    def _lookup(self, spec: ProviderSpec) -> tuple[str, Source] | None:
        if not spec.key_env:
            return None  # a provider without a key never touches the keyring
        for name in spec.key_env:
            value = (self._boot.get(name) or "").strip()
            if value:
                return value, "environment"
        value = (self._from_keyring(spec) or "").strip()
        if value:
            return value, "keyring"
        file_values = read_env_file(self._env_file)
        for name in spec.key_env:
            value = (file_values.get(name) or "").strip()
            if value:
                return value, "env_file"
        return None

    def get(self, spec: ProviderSpec) -> str | None:
        """The key to send. For adapters only, never for a response."""
        found = self._lookup(spec)
        if not found:
            return None
        register(found[0])
        return found[0]

    def status(self, spec: ProviderSpec) -> KeyStatus:
        found = self._lookup(spec)
        if found:
            register(found[0])  # a key found anywhere is masked in logs from now on
        return KeyStatus(
            required=bool(spec.key_env),
            configured=found is not None,
            source=found[1] if found else None,
            env=spec.key_env,
        )

    def set(self, spec: ProviderSpec, value: str) -> KeyStatus:
        current = self.status(spec)
        if not current.required:
            raise KeyStoreError("no_key", f"{spec.label} takes no API key")
        if current.source == "environment":
            raise KeyStoreError("external", f"{spec.label}'s key is set in the environment; change it there")
        value = value.strip()
        if not _VALUE.match(value):
            raise KeyStoreError("bad_key", "an API key is 8 to 512 characters with no spaces")
        register(value)
        if self._backend is None:
            self._refuse_shared(spec)
        if self._backend is not None:
            try:
                self._backend.set_password(SERVICE, spec.id, value)
            except KeyringError as error:
                raise KeyStoreError("keyring_failed", "the OS keyring refused the key") from error
        else:
            _upsert_env(self._env_file, spec.key_env[0], value)
        return self.status(spec)

    def delete(self, spec: ProviderSpec) -> KeyStatus:
        """Remove what SPECTRE wrote: the keyring entry, or the `.env` line when
        there is no keyring. A key in the environment, or one POWER UP saved to
        `.env`, stays, and the returned status says so."""
        if not spec.key_env:
            raise KeyStoreError("no_key", f"{spec.label} takes no API key")
        if self._backend is not None:
            try:
                self._backend.delete_password(SERVICE, spec.id)
            except PasswordDeleteError:
                pass  # nothing stored
            except KeyringError as error:
                raise KeyStoreError("keyring_failed", "the OS keyring refused the change") from error
        else:
            self._refuse_shared(spec)
            _upsert_env(self._env_file, spec.key_env[0], None)
        return self.status(spec)

    def _refuse_shared(self, spec: ProviderSpec) -> None:
        """Without a keyring a chat key lives in .env, where some names belong to
        another feature too (OPENAI_API_KEY is also voice's): never change those."""
        if spec.key_env[0] in SHARED_ENV:
            message = f"{spec.key_env[0]} in .env is also the voice key; with no OS keyring, change it there"
            raise KeyStoreError("shared_key", message)


def _upsert_env(path: Path, name: str, value: str | None) -> None:
    """Set (or with None remove) one `NAME=value` line, keeping every other
    line; written atomically and owner-only where the OS has modes."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        lines = []
    pattern = re.compile(rf"^\s*(?:export\s+)?{re.escape(name)}\s*=")
    kept = [line for line in lines if not pattern.match(line)]
    if value is not None:
        kept.append(f"{name}={value}")
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(dir=path.parent, prefix=".env.", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as out:
            out.write("\n".join(kept) + ("\n" if kept else ""))
        if os.name != "nt":
            os.chmod(temp, 0o600)
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise
