-- Add rejected state to publish_states
-- status values now include: fetched | summarized | review_pending | approved | published
--                            error | quarantined | withdrawn | rejected
--
-- rejected: admin dismissed the paper from review_pending.
--   - NOT included in getPendingForSummarize (won't be re-summarized automatically).
--   - Can be manually moved to fetched (re-summarize) or withdrawn.

ALTER TABLE publish_states ADD COLUMN rejected_reason TEXT;
ALTER TABLE publish_states ADD COLUMN rejected_by TEXT;
ALTER TABLE publish_states ADD COLUMN rejected_at TEXT;

CREATE INDEX IF NOT EXISTS idx_publish_states_rejected ON publish_states(rejected_at)
  WHERE rejected_at IS NOT NULL;
