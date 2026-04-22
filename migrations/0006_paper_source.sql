-- Add source tracking to papers
-- 'auto'            = GitHub Actions cron fetch (default)
-- 'manual'          = admin entered by hand via procure UI
-- 'keyword_curated' = admin keyword search via procure UI

ALTER TABLE papers ADD COLUMN source TEXT NOT NULL DEFAULT 'auto';

CREATE INDEX IF NOT EXISTS idx_papers_source ON papers(source);
