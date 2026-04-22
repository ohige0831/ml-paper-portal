-- Add arXiv tracking to papers
-- arxiv_id: the bare arXiv ID (e.g. "2401.12345"), NULL for non-arXiv papers
-- is_preprint: 1 if the entry was sourced from arXiv (preprint, not peer-reviewed journal)

ALTER TABLE papers ADD COLUMN arxiv_id TEXT;
ALTER TABLE papers ADD COLUMN is_preprint INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_papers_arxiv_id ON papers(arxiv_id) WHERE arxiv_id IS NOT NULL;
