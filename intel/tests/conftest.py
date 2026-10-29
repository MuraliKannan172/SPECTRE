"""Shared fixtures. Tests never touch the network, the OS keyring or
intel/data/spectre.db."""

from __future__ import annotations

import ipaddress
import socket
import sys
from pathlib import Path

import pytest

INTEL_DIR = Path(__file__).resolve().parents[1]
if str(INTEL_DIR) not in sys.path:
    sys.path.insert(0, str(INTEL_DIR))

import keyring  # noqa: E402
from helpers import MemoryKeyring  # noqa: E402

from app.store.news import NewsStore  # noqa: E402

_LOCAL_NAMES = {"localhost", "127.0.0.1", "::1"}


def _is_loopback(host: object) -> bool:
    if host in _LOCAL_NAMES:
        return True
    try:
        return ipaddress.ip_address(str(host)).is_loopback
    except ValueError:
        return False


@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Any DNS lookup or connection beyond loopback fails the test loudly."""
    real_getaddrinfo = socket.getaddrinfo
    real_connect = socket.socket.connect

    def guarded_getaddrinfo(host, *args, **kwargs):  # type: ignore[no-untyped-def]
        if not _is_loopback(host):
            raise OSError(f"network access blocked in tests: {host}")
        return real_getaddrinfo(host, *args, **kwargs)

    def guarded_connect(self, address):  # type: ignore[no-untyped-def]
        host = address[0] if isinstance(address, tuple) else address
        if not _is_loopback(host):
            raise OSError(f"network access blocked in tests: {address}")
        return real_connect(self, address)

    monkeypatch.setattr(socket, "getaddrinfo", guarded_getaddrinfo)
    monkeypatch.setattr(socket.socket, "connect", guarded_connect)


PROVIDER_KEY_ENV = (
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "NVIDIA_API_KEY",
    "DEEPSEEK_API_KEY",
)


@pytest.fixture(autouse=True)
def memory_keyring(monkeypatch: pytest.MonkeyPatch) -> MemoryKeyring:
    """No test reads or writes the OS keyring (Windows Credential Manager), and
    no provider key from the shell running the tests is visible."""
    for name in PROVIDER_KEY_ENV:
        monkeypatch.delenv(name, raising=False)
    previous = keyring.get_keyring()
    backend = MemoryKeyring()
    keyring.set_keyring(backend)
    yield backend
    keyring.set_keyring(previous)


@pytest.fixture
def store(tmp_path: Path) -> NewsStore:
    news = NewsStore(str(tmp_path / "test.db"))
    yield news
    news.close()
