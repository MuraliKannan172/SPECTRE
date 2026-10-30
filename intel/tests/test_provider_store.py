"""Provider settings, consent and the Neural Core switches (migration 0003)."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.store.providers import Policy, ProviderSettings, ProviderStore


@pytest.fixture
def providers(tmp_path: Path) -> ProviderStore:
    clock = iter(range(1000, 2000))
    store = ProviderStore(str(tmp_path / "p.db"), clock=lambda: next(clock))
    yield store
    store.close()


def test_settings_default_to_empty_and_round_trip(providers: ProviderStore) -> None:
    assert providers.settings("openrouter") == ProviderSettings()
    providers.save_settings("openrouter", ProviderSettings("https://example.test/v1", None))
    providers.save_settings("openrouter", ProviderSettings("https://other.test/v1", "ws-1"))
    assert providers.settings("openrouter") == ProviderSettings("https://other.test/v1", "ws-1")


def test_consent_is_per_provider_and_revocable(providers: ProviderStore) -> None:
    assert not providers.consented("anthropic")
    providers.set_consent("anthropic", True)
    assert providers.consented("anthropic") and not providers.consented("openai")
    providers.set_consent("anthropic", False)
    assert not providers.consented("anthropic")
    providers.set_consent("anthropic", True)
    assert providers.consented("anthropic")


def test_the_switches_default_to_cloud_allowed_with_map_context(providers: ProviderStore) -> None:
    assert providers.policy() == Policy(local_only=False, map_context=True)
    assert providers.set_policy(local_only=True) == Policy(local_only=True, map_context=True)
    assert providers.set_policy(map_context=False) == Policy(local_only=True, map_context=False)


def test_the_context_ceiling_defaults_to_16k_and_ignores_a_bad_value(providers: ProviderStore) -> None:
    assert providers.policy().context_ceiling == 16_384
    assert providers.set_policy(context_ceiling=65_536).context_ceiling == 65_536
    providers._conn.execute("UPDATE chat_settings SET value_json = '\"lots\"' WHERE key = 'context_ceiling'")
    assert providers.policy().context_ceiling == 16_384


def test_no_table_has_a_column_for_a_key(providers: ProviderStore) -> None:
    conn = providers._conn
    tables = [row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
    columns = {
        column[1].lower() for table in tables for column in conn.execute(f"PRAGMA table_info({table})")
    }
    assert not {c for c in columns if "key" in c and c != "key"} | {c for c in columns if "secret" in c}
