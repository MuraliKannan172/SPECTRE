-- Neural Core providers (ADR-002 D4). No key is ever stored in this database:
-- keys live in the OS keyring or .env (D5).
-- Null provider_id/model means the default Ollama model, so conversations and
-- messages from before this migration behave as they did.

ALTER TABLE conversations ADD COLUMN provider_id TEXT;
ALTER TABLE conversations ADD COLUMN model TEXT;

ALTER TABLE messages ADD COLUMN provider_id TEXT;
ALTER TABLE messages ADD COLUMN model TEXT;
-- Opaque round-trip data, replayed only to the same provider (D2).
ALTER TABLE messages ADD COLUMN provider_state_json TEXT;

CREATE TABLE provider_settings (
  provider_id TEXT PRIMARY KEY,
  base_url TEXT,
  workspace_id TEXT,
  params_json TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE model_caps (
  provider_id TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  supports_tools TEXT NOT NULL CHECK (supports_tools IN ('yes', 'no', 'unknown')),
  caps_json TEXT,
  probed_at INTEGER NOT NULL,
  PRIMARY KEY (provider_id, base_url, model)
);

CREATE TABLE consents (
  provider_id TEXT PRIMARY KEY,
  granted_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE usage (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  conversation_id INTEGER,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER
);

CREATE INDEX usage_by_time ON usage (ts);

-- Neural Core switches that are not per provider: local-only mode, map
-- context in cloud requests.
CREATE TABLE chat_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
