import type { D1Database } from '@cloudflare/workers-types';
import type { Paper, Tag, Summary, PublishState, PaperStatus, PaperWithSummary } from '../types';

export async function paperExists(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM papers WHERE id = ?').bind(id).first();
  return row !== null;
}

export async function insertPaper(db: D1Database, paper: Omit<Paper, 'created_at'>): Promise<void> {
  await db.prepare(`
    INSERT OR IGNORE INTO papers
      (id, doi, title, authors, published_date, citation_count,
       oa_url, pdf_url, openalex_url, primary_topic, topics, abstract)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    paper.id, paper.doi, paper.title, paper.authors,
    paper.published_date, paper.citation_count,
    paper.oa_url, paper.pdf_url, paper.openalex_url,
    paper.primary_topic, paper.topics, paper.abstract,
  ).run();

  await db.prepare(`
    INSERT OR IGNORE INTO publish_states (paper_id, status)
    VALUES (?, 'fetched')
  `).bind(paper.id).run();
}

export async function getTagsBySlug(db: D1Database, slugs: string[]): Promise<Tag[]> {
  if (slugs.length === 0) return [];
  const placeholders = slugs.map(() => '?').join(',');
  const rows = await db.prepare(
    `SELECT * FROM tags WHERE slug IN (${placeholders})`
  ).bind(...slugs).all<Tag>();
  return rows.results;
}

export async function getAllTags(db: D1Database): Promise<Tag[]> {
  const rows = await db.prepare('SELECT * FROM tags ORDER BY tier ASC, name ASC').all<Tag>();
  return rows.results;
}

export async function getTagBySlug(db: D1Database, slug: string): Promise<Tag | null> {
  return db.prepare('SELECT * FROM tags WHERE slug = ?').bind(slug).first<Tag>();
}

export async function insertSummary(
  db: D1Database,
  paperId: string,
  data: {
    title_ja: string;
    one_line: string;
    three_lines: string[];
    keywords: string[];
    long_summary: string;
    audience: string;
    difficulty: string;
    source_model: string;
  },
): Promise<void> {
  const version = await getNextSummaryVersion(db, paperId);
  await db.prepare(`
    INSERT INTO summaries
      (paper_id, version, title_ja, one_line, three_lines, keywords,
       long_summary, audience, difficulty, source_model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    paperId, version, data.title_ja, data.one_line,
    JSON.stringify(data.three_lines), JSON.stringify(data.keywords),
    data.long_summary, data.audience, data.difficulty, data.source_model,
  ).run();
}

async function getNextSummaryVersion(db: D1Database, paperId: string): Promise<number> {
  const row = await db.prepare(
    'SELECT MAX(version) as max_v FROM summaries WHERE paper_id = ?'
  ).bind(paperId).first<{ max_v: number | null }>();
  return (row?.max_v ?? 0) + 1;
}

export async function getLatestSummary(db: D1Database, paperId: string): Promise<Summary | null> {
  return db.prepare(`
    SELECT * FROM summaries WHERE paper_id = ?
    ORDER BY version DESC LIMIT 1
  `).bind(paperId).first<Summary>();
}

export async function setPublishState(
  db: D1Database,
  paperId: string,
  status: PaperStatus,
  errorMessage: string | null = null,
): Promise<void> {
  await db.prepare(`
    INSERT INTO publish_states (paper_id, status, error_message, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(paper_id) DO UPDATE SET
      status = excluded.status,
      error_message = excluded.error_message,
      updated_at = excluded.updated_at
  `).bind(paperId, status, errorMessage).run();
}

export async function linkTags(db: D1Database, paperId: string, tagIds: number[]): Promise<void> {
  for (const tagId of tagIds) {
    await db.prepare(
      'INSERT OR IGNORE INTO paper_tags (paper_id, tag_id) VALUES (?, ?)'
    ).bind(paperId, tagId).run();
  }
}

export async function getPapersByStatus(
  db: D1Database,
  status: PaperStatus,
  limit = 50,
): Promise<PaperWithSummary[]> {
  const rows = await db.prepare(`
    SELECT p.*, ps.status, ps.error_message
    FROM papers p
    JOIN publish_states ps ON ps.paper_id = p.id
    WHERE ps.status = ?
    ORDER BY p.published_date DESC
    LIMIT ?
  `).bind(status, limit).all<Paper & { status: PaperStatus; error_message: string | null }>();

  return Promise.all(rows.results.map(async (row) => {
    const { status: st, error_message, ...paper } = row;
    const summary = await getLatestSummary(db, paper.id);
    const tags = await getPaperTags(db, paper.id);
    return { paper, summary, tags, status: st };
  }));
}

export async function getPaperById(db: D1Database, id: string): Promise<PaperWithSummary | null> {
  const row = await db.prepare(`
    SELECT p.*, ps.status, ps.error_message
    FROM papers p
    JOIN publish_states ps ON ps.paper_id = p.id
    WHERE p.id = ?
  `).bind(id).first<Paper & { status: PaperStatus; error_message: string | null }>();

  if (!row) return null;
  const { status, error_message, ...paper } = row;
  const summary = await getLatestSummary(db, paper.id);
  const tags = await getPaperTags(db, paper.id);
  return { paper, summary, tags, status };
}

export async function getPaperTags(db: D1Database, paperId: string): Promise<Tag[]> {
  const rows = await db.prepare(`
    SELECT t.* FROM tags t
    JOIN paper_tags pt ON pt.tag_id = t.id
    WHERE pt.paper_id = ?
    ORDER BY t.tier ASC, t.name ASC
  `).bind(paperId).all<Tag>();
  return rows.results;
}

export async function getPublishedPapers(
  db: D1Database,
  limit = 20,
  offset = 0,
): Promise<PaperWithSummary[]> {
  const rows = await db.prepare(`
    SELECT p.*, ps.status
    FROM papers p
    JOIN publish_states ps ON ps.paper_id = p.id
    WHERE ps.status = 'published'
    ORDER BY p.published_date DESC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all<Paper & { status: PaperStatus }>();

  return Promise.all(rows.results.map(async (row) => {
    const { status, ...paper } = row;
    const summary = await getLatestSummary(db, paper.id);
    const tags = await getPaperTags(db, paper.id);
    return { paper, summary, tags, status };
  }));
}

export async function getPublishedPapersByTag(
  db: D1Database,
  tagId: number,
  limit = 20,
  offset = 0,
): Promise<PaperWithSummary[]> {
  const rows = await db.prepare(`
    SELECT p.*, ps.status
    FROM papers p
    JOIN publish_states ps ON ps.paper_id = p.id
    JOIN paper_tags pt ON pt.paper_id = p.id
    WHERE ps.status = 'published' AND pt.tag_id = ?
    ORDER BY p.published_date DESC
    LIMIT ? OFFSET ?
  `).bind(tagId, limit, offset).all<Paper & { status: PaperStatus }>();

  return Promise.all(rows.results.map(async (row) => {
    const { status, ...paper } = row;
    const summary = await getLatestSummary(db, paper.id);
    const tags = await getPaperTags(db, paper.id);
    return { paper, summary, tags, status };
  }));
}

export async function getFeaturedPapers(db: D1Database, count = 5): Promise<PaperWithSummary[]> {
  // Random pick from papers published in the last 30 days
  const rows = await db.prepare(`
    SELECT p.*, ps.status
    FROM papers p
    JOIN publish_states ps ON ps.paper_id = p.id
    WHERE ps.status = 'published'
      AND p.published_date >= date('now', '-30 days')
    ORDER BY RANDOM()
    LIMIT ?
  `).bind(count).all<Paper & { status: PaperStatus }>();

  if (rows.results.length < count) {
    // Fall back to any published papers
    const fallback = await db.prepare(`
      SELECT p.*, ps.status
      FROM papers p
      JOIN publish_states ps ON ps.paper_id = p.id
      WHERE ps.status = 'published'
      ORDER BY RANDOM()
      LIMIT ?
    `).bind(count).all<Paper & { status: PaperStatus }>();

    return Promise.all(fallback.results.map(async (row) => {
      const { status, ...paper } = row;
      const summary = await getLatestSummary(db, paper.id);
      const tags = await getPaperTags(db, paper.id);
      return { paper, summary, tags, status };
    }));
  }

  return Promise.all(rows.results.map(async (row) => {
    const { status, ...paper } = row;
    const summary = await getLatestSummary(db, paper.id);
    const tags = await getPaperTags(db, paper.id);
    return { paper, summary, tags, status };
  }));
}

export async function getRelatedPapers(
  db: D1Database,
  paperId: string,
  limit = 5,
): Promise<PaperWithSummary[]> {
  const rows = await db.prepare(`
    SELECT DISTINCT p.*, ps.status
    FROM papers p
    JOIN publish_states ps ON ps.paper_id = p.id
    JOIN paper_tags pt ON pt.paper_id = p.id
    WHERE ps.status = 'published'
      AND p.id != ?
      AND pt.tag_id IN (
        SELECT tag_id FROM paper_tags WHERE paper_id = ?
      )
    ORDER BY p.published_date DESC
    LIMIT ?
  `).bind(paperId, paperId, limit).all<Paper & { status: PaperStatus }>();

  return Promise.all(rows.results.map(async (row) => {
    const { status, ...paper } = row;
    const summary = await getLatestSummary(db, paper.id);
    const tags = await getPaperTags(db, paper.id);
    return { paper, summary, tags, status };
  }));
}

export async function getTagsWithCount(
  db: D1Database,
): Promise<Array<Tag & { paper_count: number }>> {
  const rows = await db.prepare(`
    SELECT t.*, COUNT(pt.paper_id) as paper_count
    FROM tags t
    LEFT JOIN paper_tags pt ON pt.tag_id = t.id
    LEFT JOIN publish_states ps ON ps.paper_id = pt.paper_id AND ps.status = 'published'
    GROUP BY t.id
    ORDER BY t.tier ASC, paper_count DESC, t.name ASC
  `).all<Tag & { paper_count: number }>();
  return rows.results;
}

export async function insertFetchLog(
  db: D1Database,
  fetched: number,
  newCount: number,
  status: 'ok' | 'error',
  message?: string,
): Promise<void> {
  await db.prepare(`
    INSERT INTO fetch_logs (papers_fetched, papers_new, status, message)
    VALUES (?, ?, ?, ?)
  `).bind(fetched, newCount, status, message ?? null).run();
}

export async function getPendingForSummarize(
  db: D1Database,
  limit = 20,
): Promise<Paper[]> {
  const rows = await db.prepare(`
    SELECT p.*
    FROM papers p
    JOIN publish_states ps ON ps.paper_id = p.id
    WHERE ps.status = 'fetched'
    ORDER BY p.citation_count DESC, p.published_date DESC
    LIMIT ?
  `).bind(limit).all<Paper>();
  return rows.results;
}
