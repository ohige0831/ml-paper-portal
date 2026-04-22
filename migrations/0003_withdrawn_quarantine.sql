-- Add withdrawn/quarantine support to publish_states
-- status values: fetched | summarized | review_pending | approved | published | error | quarantined | withdrawn

ALTER TABLE publish_states ADD COLUMN withdrawn_at TEXT;
ALTER TABLE publish_states ADD COLUMN withdrawn_reason TEXT;
ALTER TABLE publish_states ADD COLUMN withdrawn_by TEXT;

-- quarantine_reason stores why the paper was quarantined during ingest validation
ALTER TABLE papers ADD COLUMN quarantine_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_publish_states_withdrawn ON publish_states(withdrawn_at)
  WHERE withdrawn_at IS NOT NULL;
