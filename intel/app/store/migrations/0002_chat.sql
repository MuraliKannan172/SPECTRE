-- Neural Core: chat history and the tool log (ADR-001 D3).
-- The tool log records names, arguments, status, timing and URLs only:
-- never fetched content or answers.

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  citations_json TEXT,
  meta_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX messages_by_conversation ON messages (conversation_id, id);

CREATE TABLE tool_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  conversation_id INTEGER,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  url TEXT
);

CREATE INDEX tool_log_by_time ON tool_log (ts);
