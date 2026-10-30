"""Provider API keys (ADR-002 D5): precedence, where writes go, what is shown."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import keyring
import pytest
from helpers import MemoryKeyring
from keyring.backends import fail
from keyring.errors import KeyringError

from app.chat.providers.keys import SERVICE, KeyStore, KeyStoreError
from app.chat.providers.registry import ProviderSpec

CANARY = "sk-test-CANARY-0123456789abcdef"
OPENAI = ProviderSpec("openai", "ChatGPT", "mock", "cloud", "https://api.openai.com/v1", ("OPENAI_API_KEY",))
OLLAMA = ProviderSpec("ollama", "Ollama", "mock", "local", "http://127.0.0.1:11434")


def store_with(
    tmp_path: Path, *, boot: dict[str, str] | None = None, backend: object = "memory", env: str = ""
) -> tuple[KeyStore, MemoryKeyring | None, Path]:
    env_file = tmp_path / ".env"
    if env:
        env_file.write_text(env, encoding="utf-8")
    memory = MemoryKeyring() if backend == "memory" else None
    keys = KeyStore(
        boot_env=boot or {},
        env_file=env_file,
        backend=memory if backend == "memory" else backend,  # type: ignore[arg-type]
    )
    return keys, memory, env_file


def test_tests_run_against_an_in_memory_keyring() -> None:
    assert isinstance(keyring.get_keyring(), MemoryKeyring)
    assert "OPENAI_API_KEY" not in os.environ


def test_the_environment_wins_then_the_keyring_then_env_file(tmp_path: Path) -> None:
    keys, memory, _ = store_with(
        tmp_path, boot={"OPENAI_API_KEY": "sk-from-environment"}, env="OPENAI_API_KEY=sk-from-dotenv\n"
    )
    memory.values[(SERVICE, "openai")] = "sk-from-keyring"
    assert (keys.get(OPENAI), keys.status(OPENAI).source) == ("sk-from-environment", "environment")

    keys, memory, _ = store_with(tmp_path, env="OPENAI_API_KEY=sk-from-dotenv\n")
    memory.values[(SERVICE, "openai")] = "sk-from-keyring"
    assert (keys.get(OPENAI), keys.status(OPENAI).source) == ("sk-from-keyring", "keyring")

    keys, _, _ = store_with(tmp_path, env="OPENAI_API_KEY=sk-from-dotenv\n")
    assert (keys.get(OPENAI), keys.status(OPENAI).source) == ("sk-from-dotenv", "env_file")


def test_a_key_power_up_saved_to_env_is_reused_and_read_on_every_lookup(tmp_path: Path) -> None:
    keys, _, env_file = store_with(tmp_path)
    assert not keys.status(OPENAI).configured
    env_file.write_text("BRAVE_API_KEY=x\nOPENAI_API_KEY=sk-voice-key-123\n", encoding="utf-8")
    assert keys.status(OPENAI).source == "env_file" and keys.get(OPENAI) == "sk-voice-key-123"


def test_a_saved_key_goes_to_the_keyring_not_env(tmp_path: Path) -> None:
    keys, memory, env_file = store_with(tmp_path, env="BRAVE_API_KEY=x\n")
    status = keys.set(OPENAI, f"  {CANARY}  ")
    assert (status.configured, status.source) == (True, "keyring")
    assert memory.values == {(SERVICE, "openai"): CANARY}
    assert env_file.read_text(encoding="utf-8") == "BRAVE_API_KEY=x\n"


def test_a_key_set_in_the_environment_cannot_be_overwritten(tmp_path: Path) -> None:
    keys, memory, _ = store_with(tmp_path, boot={"OPENAI_API_KEY": "sk-external-key"})
    status = keys.status(OPENAI)
    assert (status.source, status.writable) == ("environment", False)
    with pytest.raises(KeyStoreError) as raised:
        keys.set(OPENAI, CANARY)
    assert raised.value.code == "external" and memory.values == {}


@pytest.mark.parametrize("value", ["short", "has space inside-key", "sk-#comment-123", "x" * 513])
def test_a_malformed_key_is_refused(tmp_path: Path, value: str) -> None:
    keys, memory, _ = store_with(tmp_path)
    with pytest.raises(KeyStoreError) as raised:
        keys.set(OPENAI, value)
    assert raised.value.code == "bad_key" and memory.values == {}


def test_a_provider_without_a_key_refuses_one_and_never_reads_the_keyring(tmp_path: Path) -> None:
    class Untouchable(MemoryKeyring):
        def get_password(self, service: str, username: str) -> str | None:
            raise AssertionError("a keyless provider read the keyring")

    keys = KeyStore(boot_env={}, env_file=tmp_path / ".env", backend=Untouchable())
    assert keys.status(OLLAMA).public()["required"] is False and keys.get(OLLAMA) is None
    with pytest.raises(KeyStoreError) as raised:
        keys.set(OLLAMA, CANARY)
    assert raised.value.code == "no_key"


def test_delete_removes_only_what_spectre_wrote(tmp_path: Path) -> None:
    keys, memory, env_file = store_with(tmp_path, env="OPENAI_API_KEY=sk-voice-key-123\n")
    keys.set(OPENAI, CANARY)
    status = keys.delete(OPENAI)
    assert memory.values == {}
    assert (status.configured, status.source) == (True, "env_file"), "the POWER UP key is still active"
    assert "sk-voice-key-123" in env_file.read_text(encoding="utf-8")
    assert keys.delete(OPENAI).source == "env_file", "deleting twice is not an error"


@pytest.mark.parametrize("backend", [None, fail.Keyring()])
def test_without_a_keyring_the_key_goes_to_env_and_keeps_other_lines(tmp_path: Path, backend: object) -> None:
    keys, _, env_file = store_with(
        tmp_path, backend=backend, env="# mine\nBRAVE_API_KEY=x\nOPENAI_API_KEY=old\n"
    )
    assert not keys.keyring_available
    assert keys.set(OPENAI, CANARY).source == "env_file"
    assert env_file.read_text(encoding="utf-8") == f"# mine\nBRAVE_API_KEY=x\nOPENAI_API_KEY={CANARY}\n"
    if os.name != "nt":
        assert env_file.stat().st_mode & 0o777 == 0o600
    assert not keys.delete(OPENAI).configured
    assert env_file.read_text(encoding="utf-8") == "# mine\nBRAVE_API_KEY=x\n"


def test_a_failing_keyring_reads_as_not_configured_and_logs_no_value(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    class Broken(MemoryKeyring):
        def get_password(self, service: str, username: str) -> str | None:
            raise KeyringError(f"locked while reading {CANARY}")

        def set_password(self, service: str, username: str, password: str) -> None:
            raise KeyringError("locked")

    keys = KeyStore(boot_env={}, env_file=tmp_path / ".env", backend=Broken())
    with caplog.at_level(logging.WARNING):
        assert not keys.status(OPENAI).configured
    with pytest.raises(KeyStoreError) as raised:
        keys.set(OPENAI, CANARY)
    assert raised.value.code == "keyring_failed"
    assert CANARY not in caplog.text and "KeyringError" in caplog.text


def test_status_never_carries_the_value_or_a_suffix(tmp_path: Path) -> None:
    keys, _, _ = store_with(tmp_path)
    shown = json.dumps(keys.set(OPENAI, CANARY).public())
    assert CANARY not in shown and CANARY[-4:] not in shown
    assert json.loads(shown) == {
        "required": True,
        "configured": True,
        "source": "keyring",
        "env": ["OPENAI_API_KEY"],
        "writable": True,
    }
