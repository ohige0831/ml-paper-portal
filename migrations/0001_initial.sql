-- Papers: raw metadata from OpenAlex
CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,            -- OpenAlex ID (e.g. W2741809807)
  doi TEXT,
  title TEXT NOT NULL,
  authors TEXT NOT NULL DEFAULT '[]',   -- JSON: [{name: string}]
  published_date TEXT NOT NULL,
  citation_count INTEGER NOT NULL DEFAULT 0,
  oa_url TEXT,
  pdf_url TEXT,
  openalex_url TEXT NOT NULL,
  primary_topic TEXT,
  topics TEXT NOT NULL DEFAULT '[]',    -- JSON: [string]
  abstract TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tags: hierarchical taxonomy
-- tier 1 = 大タグ (分野/タスク), 2 = 中タグ (手法群), 3 = 小タグ (技術要素)
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  tier INTEGER NOT NULL DEFAULT 2,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Paper-tag: many-to-many
CREATE TABLE IF NOT EXISTS paper_tags (
  paper_id TEXT NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (paper_id, tag_id),
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

-- Summaries: Japanese intro text (versioned, latest is max version per paper)
CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  title_ja TEXT,
  one_line TEXT,
  three_lines TEXT NOT NULL DEFAULT '[]',   -- JSON: [string, string, string]
  keywords TEXT NOT NULL DEFAULT '[]',       -- JSON: [string]
  long_summary TEXT,
  audience TEXT,
  difficulty TEXT,
  source_model TEXT,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);

-- State machine: fetched → summarized → review_pending → approved → published
CREATE TABLE IF NOT EXISTS publish_states (
  paper_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'fetched',
  error_message TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);

-- Fetch job history
CREATE TABLE IF NOT EXISTS fetch_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  papers_fetched INTEGER NOT NULL DEFAULT 0,
  papers_new INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  message TEXT
);

CREATE INDEX IF NOT EXISTS idx_papers_published_date ON papers(published_date DESC);
CREATE INDEX IF NOT EXISTS idx_papers_citation_count ON papers(citation_count DESC);
CREATE INDEX IF NOT EXISTS idx_summaries_paper_id ON summaries(paper_id);
CREATE INDEX IF NOT EXISTS idx_publish_states_status ON publish_states(status);
CREATE INDEX IF NOT EXISTS idx_paper_tags_tag_id ON paper_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_paper_tags_paper_id ON paper_tags(paper_id);
