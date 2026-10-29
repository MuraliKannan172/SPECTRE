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
    ) -> int:
        now = int(time.time())
        with self._lock:
            cursor = self._conn.execute(
                "INSERT INTO messages (conversation_id, role, content, citations_json, meta_json,"
                " provider_id, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    conversation_id,
                    role,
                    content,
                    json.dumps(citations) if citations else None,
                    json.dumps(meta) if meta else None,
                    provider_id,
                    model,
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
        with self._lock:
            self._conn.execute("DELETE FROM messages")
            self._conn.execute("DELETE FROM conversations")

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
