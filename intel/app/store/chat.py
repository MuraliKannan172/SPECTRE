"""Chat history and the tool log, in the intel database (migrations 0002, 0003).

History is one running conversation per install: the panel shows the latest,
and "clear history" deletes every conversation and message. The tool log is
kept (names, arguments, status, timing and URLs, no content), mirrored as
JSON lines under .spectre-logs/ for inspection outside SQLite.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

from .db import connect, migrate

MAX_HISTORY_MESSAGES = 200


class ChatStore:
    def __init__(self, path: str, logs_dir: Path | None = None) -> None:
        self._conn = connect(path)
        self._lock = threading.RLock()
        self._logs_dir = logs_dir
        with self._lock:
            migrate(self._conn)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def current_conversation(self) -> int | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT id FROM conversations ORDER BY updated_at DESC, id DESC LIMIT 1"
            ).fetchone()
        return int(row[0]) if row else None

    def ensure_conversation(self, conversation_id: int | None) -> int:
        with self._lock:
            if conversation_id is not None:
                row = self._conn.execute(
                    "SELECT id FROM conversations WHERE id = ?", (conversation_id,)
                ).fetchone()
                if row:
                    return int(row[0])
            now = int(time.time())
            cursor = self._conn.execute(
                "INSERT INTO conversations (created_at, updated_at) VALUES (?, ?)", (now, now)
            )
            return int(cursor.lastrowid)

    def add_message(
        self,
        conversation_id: int,
        role: str,
        content: str,
        *,
        citations: list[dict[str, Any]] | None = None,
        meta: dict[str, Any] | None = None,
        provider_id: str | None = None,
        model: str | None = None,
        provider_state: dict[str, Any] | None = None,
    ) -> int:
        now = int(time.time())
        with self._lock:
            cursor = self._conn.execute(
                "INSERT INTO messages (conversation_id, role, content, citations_json, meta_json,"
                " provider_id, model, provider_state_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    conversation_id,
                    role,
                    content,
                    json.dumps(citations) if citations else None,
                    json.dumps(meta) if meta else None,
                    provider_id,
                    model,
                    json.dumps(provider_state) if provider_state else None,
                    now,
                ),
            )
            self._conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id))
            return int(cursor.lastrowid)

    def messages(self, conversation_id: int, limit: int = MAX_HISTORY_MESSAGES) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, role, content, citations_json, meta_json, created_at, provider_id, model"
                " FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?",
                (conversation_id, limit),
            ).fetchall()
        return [
            {
                "id": row[0],
                "role": row[1],
                "content": row[2],
                "citations": json.loads(row[3]) if row[3] else [],
                "meta": json.loads(row[4]) if row[4] else {},
                "created_at": row[5],
                "provider_id": row[6],
                "model": row[7],
            }
            for row in reversed(rows)
        ]

    def history(self, conversation_id: int, limit: int = MAX_HISTORY_MESSAGES) -> list[dict[str, Any]]:
        """messages() plus provider_state, for the agent only. It is opaque
        provider data (thinking signatures, encrypted reasoning) that the
        history route never sends to the browser."""
        rows = self.messages(conversation_id, limit)
        if not rows:
            return rows
        with self._lock:
            states = dict(
                self._conn.execute(
                    "SELECT id, provider_state_json FROM messages WHERE conversation_id = ?"
                    " AND provider_state_json IS NOT NULL AND id >= ?",
                    (conversation_id, rows[0]["id"]),
                ).fetchall()
            )
        return [
            {**row, "provider_state": json.loads(states[row["id"]]) if row["id"] in states else None}
            for row in rows
        ]

    def selection(self, conversation_id: int) -> tuple[str, str] | None:
        """The provider and model chosen for a conversation (ADR-002 D4)."""
        with self._lock:
            row = self._conn.execute(
                "SELECT provider_id, model FROM conversations WHERE id = ?", (conversation_id,)
            ).fetchone()
        return (str(row[0]), str(row[1])) if row and row[0] and row[1] else None

    # -- usage and the soft budget (ADR-002 D10, migration 0004) -------------------

    def record_usage(
        self,
        conversation_id: int,
        *,
        provider_id: str,
        model: str,
        kind: str,
        tokens_in: int,
        tokens_out: int,
    ) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO usage (ts, conversation_id, provider_id, model, kind,"
                " input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (int(time.time()), conversation_id, provider_id, model, kind, tokens_in, tokens_out),
            )

    def usage_totals(self, conversation_id: int | None) -> dict[str, int]:
        """Tokens this conversation used: all of them, and the cloud share
        that counts against the budget."""
        if conversation_id is None:
            return {"input": 0, "output": 0, "cloud": 0}
        with self._lock:
            row = self._conn.execute(
                "SELECT COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),"
                " COALESCE(SUM(CASE WHEN kind = 'cloud' THEN input_tokens + output_tokens END), 0)"
                " FROM usage WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
        return {"input": int(row[0]), "output": int(row[1]), "cloud": int(row[2])}

    def usage_for(self, conversation_id: int, provider_id: str, model: str) -> dict[str, int]:
        """The tokens one provider and model used here: the ones its price applies to."""
        with self._lock:
            row = self._conn.execute(
                "SELECT COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0) FROM usage"
                " WHERE conversation_id = ? AND provider_id = ? AND model = ?",
                (conversation_id, provider_id, model),
            ).fetchone()
        return {"input": int(row[0]), "output": int(row[1])}

    def budget_extra(self, conversation_id: int) -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT budget_extra FROM conversations WHERE id = ?", (conversation_id,)
            ).fetchone()
        return int(row[0]) if row else 0

    def raise_budget(self, conversation_id: int, tokens: int) -> int:
        with self._lock:
            self._conn.execute(
                "UPDATE conversations SET budget_extra = budget_extra + ? WHERE id = ?",
                (tokens, conversation_id),
            )
        return self.budget_extra(conversation_id)

    def set_selection(self, conversation_id: int, provider_id: str, model: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE conversations SET provider_id = ?, model = ? WHERE id = ?",
                (provider_id, model, conversation_id),
            )

    def drop_last_answer(self, conversation_id: int) -> str | None:
        """For regenerate: delete the answer after the last user message and
        return that message's text (None when there is nothing to redo)."""
        with self._lock:
            row = self._conn.execute(
                "SELECT id, content FROM messages WHERE conversation_id = ? AND role = 'user'"
                " ORDER BY id DESC LIMIT 1",
                (conversation_id,),
            ).fetchone()
            if not row:
                return None
            self._conn.execute(
                "DELETE FROM messages WHERE conversation_id = ? AND id >= ?", (conversation_id, row[0])
            )
            return str(row[1])

    def clear(self) -> None:
        """Every conversation and what it counted: conversation ids are reused
        after a clear, so usage left behind would land on the next one."""
        with self._lock:
            self._conn.execute("DELETE FROM messages")
            self._conn.execute("DELETE FROM conversations")
            self._conn.execute("DELETE FROM usage")

    def log_tool(
        self,
        *,
        conversation_id: int | None,
        tool: str,
        args: dict[str, Any],
        status: str,
        duration_ms: int,
        url: str | None = None,
    ) -> None:
        now = int(time.time())
        args_json = json.dumps(args, ensure_ascii=False, default=str)
        if len(args_json) > 4000:
            args_json = json.dumps({"truncated": args_json[:3900]}, ensure_ascii=False)
        with self._lock:
            self._conn.execute(
                "INSERT INTO tool_log (ts, conversation_id, tool, args_json, status, duration_ms, url)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (now, conversation_id, tool, args_json, status, duration_ms, url),
            )
        if self._logs_dir is None:
            return
        record = {
            "ts": now,
            "conversation_id": conversation_id,
            "tool": tool,
            "args": json.loads(args_json),
            "status": status,
            "duration_ms": duration_ms,
            "url": url,
        }
        line = json.dumps(record, ensure_ascii=False)
        try:
            self._logs_dir.mkdir(parents=True, exist_ok=True)
            day = time.strftime("%Y%m%d", time.gmtime(now))
            with (self._logs_dir / f"tools-{day}.jsonl").open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        except OSError:
            pass  # the database row is the record; the file is a convenience

    def tool_log(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT ts, conversation_id, tool, args_json, status, duration_ms, url FROM tool_log"
                " ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        keys = ("ts", "conversation_id", "tool", "args_json", "status", "duration_ms", "url")
        return [dict(zip(keys, row, strict=True)) for row in rows]
