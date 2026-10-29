"""Neural Core provider state in the intel database (migration 0003): per-provider
settings, consent to send data to a non-local provider, and the switches that
are not per provider. Keys are never stored here (ADR-002 D5)."""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from typing import Any

from .db import connect, migrate


@dataclass(frozen=True)
class ProviderSettings:
    base_url: str | None = None
    workspace_id: str | None = None


@dataclass(frozen=True)
class Policy:
    """local_only hard-blocks every cloud choice; map_context sends the
    viewport and active layers to cloud providers (on by default, disclosed)."""

    local_only: bool = False
    map_context: bool = True


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
                "SELECT base_url, workspace_id FROM provider_settings WHERE provider_id = ?",
                (provider_id,),
            ).fetchone()
        return ProviderSettings(row[0], row[1]) if row else ProviderSettings()

    def save_settings(self, provider_id: str, settings: ProviderSettings) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO provider_settings (provider_id, base_url, workspace_id, updated_at)"
                " VALUES (?, ?, ?, ?) ON CONFLICT (provider_id) DO UPDATE SET"
                " base_url = excluded.base_url, workspace_id = excluded.workspace_id,"
                " updated_at = excluded.updated_at",
                (provider_id, settings.base_url, settings.workspace_id, self._now()),
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
                "SELECT key, value_json FROM chat_settings WHERE key IN ('local_only', 'map_context')"
            ).fetchall()
        values = {key: json.loads(value) for key, value in rows}
        return Policy(
            local_only=values.get("local_only", Policy.local_only) is True,
            map_context=values.get("map_context", Policy.map_context) is True,
        )

    def set_policy(self, *, local_only: bool | None = None, map_context: bool | None = None) -> Policy:
        changes = {"local_only": local_only, "map_context": map_context}
        now = self._now()
        with self._lock:
            for key, value in changes.items():
                if value is None:
                    continue
                self._conn.execute(
                    "INSERT INTO chat_settings (key, value_json, updated_at) VALUES (?, ?, ?)"
                    " ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,"
                    " updated_at = excluded.updated_at",
                    (key, json.dumps(bool(value)), now),
                )
        return self.policy()
