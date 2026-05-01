-- Add LLM recheck columns to publish_states
ALTER TABLE publish_states ADD COLUMN llm_recheck_checked_at TEXT NULL;
ALTER TABLE publish_states ADD COLUMN recheck_reason        TEXT NULL;
ALTER TABLE publish_states ADD COLUMN recheck_confidence    TEXT NULL;
ALTER TABLE publish_states ADD COLUMN recheck_model        TEXT NULL;
ALTER TABLE publish_states ADD COLUMN recheck_flagged_at   TEXT NULL;
