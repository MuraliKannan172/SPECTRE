-- Neural Core usage and the per-conversation soft budget (ADR-002 D10).
-- Only cloud turns (Ollama :cloud models included) count against the
-- budget, so each usage row records the turn's kind.

ALTER TABLE usage ADD COLUMN kind TEXT;
CREATE INDEX usage_by_conversation ON usage (conversation_id);

-- Tokens the owner allowed past the budget with "Continue".
ALTER TABLE conversations ADD COLUMN budget_extra INTEGER NOT NULL DEFAULT 0;
