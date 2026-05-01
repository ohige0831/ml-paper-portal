-- Add review scoring metadata for arXiv daily fetch and tiered review.
-- Existing columns reused:
--   source      (added in 0006_paper_source.sql)
--   arxiv_id    (added in 0007_arxiv_fields.sql)
--   is_preprint (added in 0007_arxiv_fields.sql)
--
-- All new columns are nullable or have defaults so existing rows and inserts remain valid.

ALTER TABLE papers ADD COLUMN normalized_title TEXT;
ALTER TABLE papers ADD COLUMN ml_score INTEGER;
ALTER TABLE papers ADD COLUMN effective_score INTEGER;
ALTER TABLE papers ADD COLUMN review_tier TEXT;
ALTER TABLE papers ADD COLUMN score_reasons TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_papers_normalized_title
  ON papers(normalized_title)
  WHERE normalized_title IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_papers_review_tier
  ON papers(review_tier)
  WHERE review_tier IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_papers_effective_score
  ON papers(effective_score DESC)
  WHERE effective_score IS NOT NULL;
