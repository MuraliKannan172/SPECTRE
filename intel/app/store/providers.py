"""Neural Core provider state in the intel database (migration 0003): per-provider
settings, consent to send data to a non-local provider, and the switches that
are not per provider. Keys are never stored here (ADR-002 D5)."""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from .db import connect, migrate


@dataclass(frozen=True)
class ProviderSettings:
    base_url: str | None = None
    workspace_id: str | None = None
    chat_completions_models: tuple[str, ...] = ()  # OpenAI models sent to Chat Completions
    # Validated by the API: temperature, max_output_tokens, num_ctx, keep_alive,
    # price_in / price_out (per 1M tokens, typed by the user, D10).
    params: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Policy:
    """local_only hard-blocks every cloud choice; map_context sends the
    viewport and active layers to non-local providers (on by default,
    disclosed); session_budget is the soft cap in cloud tokens per
    conversation before a turn asks to continue (0 turns it off, D10);
    context_ceiling is the window, in tokens, that a turn on an API model may
    use at most (D9): 16k unless the user changes it."""

    local_only: bool = False
    map_context: bool = True
    session_budget: int = 100_000
    context_ceiling: int = 16_384


CONTEXT_CEILING_RANGE = (4096, 1_048_576)


class ProviderStore:
    def __init__(self, path: str, clock: Any = time.time) -> None:
        self._conn = connect(path)
        self._lock = threading.RLock()
        self._clock = clock
        with self._lock:
            migrate(self._conn)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def _now(self) -> int:
        return int(self._clock())

    # -- settings ----------------------------------------------------------------

    def settings(self, provider_id: str) -> ProviderSettings:
        with self._lock:
            row = self._conn.execute(
                "SELECT base_url, workspace_id, params_json FROM provider_settings WHERE provider_id = ?",
                (provider_id,),
            ).fetchone()
        if not row:
            return ProviderSettings()
        stored = json.loads(row[2]) if row[2] else {}
        return ProviderSettings(
            row[0],
            row[1],
            tuple(stored.get("chat_completions_models") or ()),
            dict(stored.get("params") or {}),
        )

    def save_settings(self, provider_id: str, settings: ProviderSettings) -> None:
        params = {
            "chat_completions_models": list(settings.chat_completions_models),
            "params": settings.params,
        }
        with self._lock:
            self._conn.execute(
                "INSERT INTO provider_settings (provider_id, base_url, workspace_id, params_json, updated_at)"
                " VALUES (?, ?, ?, ?, ?) ON CONFLICT (provider_id) DO UPDATE SET"
                " base_url = excluded.base_url, workspace_id = excluded.workspace_id,"
                " params_json = excluded.params_json, updated_at = excluded.updated_at",
                (provider_id, settings.base_url, settings.workspace_id, json.dumps(params), self._now()),
            )

    # -- tool-calling probe results (D3), keyed by provider, base URL and model --

    def known_tools(self, provider_id: str, base_url: str, model: str) -> str | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT supports_tools FROM model_caps WHERE provider_id = ? AND base_url = ? AND model = ?",
                (provider_id, base_url, model),
            ).fetchone()
        return str(row[0]) if row and row[0] in ("yes", "no") else None

    def remember_tools(self, provider_id: str, base_url: str, model: str, support: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO model_caps (provider_id, base_url, model, supports_tools, probed_at)"
                " VALUES (?, ?, ?, ?, ?) ON CONFLICT (provider_id, base_url, model) DO UPDATE SET"
                " supports_tools = excluded.supports_tools, probed_at = excluded.probed_at",
                (provider_id, base_url, model, support, self._now()),
            )

    def forget_tools(self, provider_id: str, base_url: str | None = None, model: str | None = None) -> None:
        """Probe again: every model of a provider (a changed base URL), or one
        model whose "Test tool calling" proved nothing."""
        query, args = "DELETE FROM model_caps WHERE provider_id = ?", [provider_id]
        if base_url is not None and model is not None:
            query += " AND base_url = ? AND model = ?"
            args += [base_url, model]
        with self._lock:
            self._conn.execute(query, args)

    # -- where a saved key may go ---------------------------------------------------

    def key_host(self, provider_id: str) -> str | None:
        """The host a key was saved for in the app (its base URL then)."""
        with self._lock:
            row = self._conn.execute(
                "SELECT value_json FROM chat_settings WHERE key = ?", (f"key_host:{provider_id}",)
            ).fetchone()
        value = json.loads(row[0]) if row else None
        return value if isinstance(value, str) else None

    def set_key_host(self, provider_id: str, host: str | None) -> None:
        key = f"key_host:{provider_id}"
        with self._lock:
            if host is None:
                self._conn.execute("DELETE FROM chat_settings WHERE key = ?", (key,))
                return
            self._conn.execute(
                "INSERT INTO chat_settings (key, value_json, updated_at) VALUES (?, ?, ?)"
                " ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,"
                " updated_at = excluded.updated_at",
                (key, json.dumps(host), self._now()),
            )

    # -- consent -----------------------------------------------------------------

    def consented(self, provider_id: str) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT granted_at, revoked_at FROM consents WHERE provider_id = ?", (provider_id,)
            ).fetchone()
        return bool(row and row[0] is not None and row[1] is None)

    def set_consent(self, provider_id: str, granted: bool) -> None:
        now = self._now()
        with self._lock:
            if granted:
                self._conn.execute(
                    "INSERT INTO consents (provider_id, granted_at, revoked_at) VALUES (?, ?, NULL)"
                    " ON CONFLICT (provider_id) DO UPDATE SET granted_at = ?, revoked_at = NULL",
                    (provider_id, now, now),
                )
            else:
                self._conn.execute(
                    "UPDATE consents SET revoked_at = ? WHERE provider_id = ? AND revoked_at IS NULL",
                    (now, provider_id),
                )

    # -- switches ------------------------------------------------------------------

    def policy(self) -> Policy:
        with self._lock:
            rows = self._conn.execute(
                "SELECT key, value_json FROM chat_settings"
                " WHERE key IN ('local_only', 'map_context', 'session_budget', 'context_ceiling')"
            ).fetchall()
        values = {key: json.loads(value) for key, value in rows}
        budget = values.get("session_budget", Policy.session_budget)
        ceiling = values.get("context_ceiling", Policy.context_ceiling)
        low, high = CONTEXT_CEILING_RANGE
        return Policy(
            local_only=values.get("local_only", Policy.local_only) is True,
            map_context=values.get("map_context", Policy.map_context) is True,
            session_budget=budget if isinstance(budget, int) and budget >= 0 else Policy.session_budget,
            context_ceiling=(
                ceiling if isinstance(ceiling, int) and low <= ceiling <= high else Policy.context_ceiling
            ),
        )

    def set_policy(
        self,
        *,
        local_only: bool | None = None,
        map_context: bool | None = None,
        session_budget: int | None = None,
        context_ceiling: int | None = None,
    ) -> Policy:
        changes: dict[str, bool | int | None] = {
            "local_only": None if local_only is None else bool(local_only),
            "map_context": None if map_context is None else bool(map_context),
            "session_budget": session_budget,
            "context_ceiling": context_ceiling,
        }
        now = self._now()
        with self._lock:
            for key, value in changes.items():
                if value is None:
                    continue
                self._conn.execute(
                    "INSERT INTO chat_settings (key, value_json, updated_at) VALUES (?, ?, ?)"
                    " ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,"
                    " updated_at = excluded.updated_at",
                    (key, json.dumps(value), now),
                )
        return self.policy()

    def last_selection(self) -> tuple[str, str] | None:
        """The provider and model last chosen; a new conversation starts with it."""
        with self._lock:
            row = self._conn.execute(
                "SELECT value_json FROM chat_settings WHERE key = 'selection'"
            ).fetchone()
        value = json.loads(row[0]) if row else None
        return (str(value[0]), str(value[1])) if isinstance(value, list) and len(value) == 2 else None

    def set_last_selection(self, provider_id: str, model: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO chat_settings (key, value_json, updated_at) VALUES ('selection', ?, ?)"
                " ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,"
                " updated_at = excluded.updated_at",
                (json.dumps([provider_id, model]), self._now()),
            )
