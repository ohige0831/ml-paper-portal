-- Backfill arxiv_id and is_preprint for existing papers
-- arXiv preprint DOIs follow the pattern '10.48550/arXiv.{id}'
-- '10.48550/arXiv.' is exactly 15 characters, so SUBSTR(doi, 16) extracts the bare arXiv ID
-- No API calls needed — the arXiv ID is embedded in the DOI itself.

UPDATE papers
SET
  arxiv_id   = SUBSTR(doi, 16),
  is_preprint = 1
WHERE doi LIKE '10.48550/arXiv.%'
  AND arxiv_id IS NULL;
