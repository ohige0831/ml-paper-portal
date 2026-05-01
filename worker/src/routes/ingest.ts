import { Hono } from 'hono';
import type { Env, OpenAlexWork, ReviewTier } from '../types';
import {
  insertPaper,
  paperExists,
  insertFetchLog,
  setPublishState,
  getRecheckPending,
  markRecheckChecked,
  markNeedsRecheck,
  findPaperByArxivId,
  findPaperByDoi,
  findPaperByNormalizedTitle,
  updatePaperReviewMetadata,
} from '../db/queries';
import {
  reconstructAbstract,
  extractPdfUrl,
  extractOaUrl,
  normalizeId,
} from '../lib/openalex';
import { validateWork } from '../lib/validate';

export const ingestRouter = new Hono<{ Bindings: Env }>();

interface ArxivIngestItem {
  arxiv_id: string;
  title: string;
  abstract?: string | null;
  authors?: string[];
  published_date: string;
  url?: string;
  pdf_url?: string;
  categories?: string[];
  normalized_title?: string | null;
  ml_score?: number | null;
  effective_score?: number | null;
  review_tier?: ReviewTier | null;
  score_reasons?: string[];
}

function bearerAuth(token: string, header: string): boolean {
  return !!token && header === `Bearer ${token}`;
}

// Bearer token auth for ingest and recheck endpoints
ingestRouter.use('/api/ingest', async (c, next) => {
  if (!bearerAuth(c.env.INGEST_TOKEN, c.req.header('Authorization') ?? '')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

ingestRouter.use('/api/ingest/arxiv', async (c, next) => {
  if (!bearerAuth(c.env.INGEST_TOKEN, c.req.header('Authorization') ?? '')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

ingestRouter.use('/api/recheck/*', async (c, next) => {
  if (!bearerAuth(c.env.INGEST_TOKEN, c.req.header('Authorization') ?? '')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

// POST /api/ingest
// Body: { works: OpenAlexWork[] }
// Inserts papers that don't already exist. Returns { inserted, skipped }.
ingestRouter.post('/api/ingest', async (c) => {
  let body: { works: OpenAlexWork[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const works: OpenAlexWork[] = body?.works ?? [];
  if (!Array.isArray(works) || works.length === 0) {
    return c.json({ inserted: 0, skipped: 0 });
  }

  let inserted = 0;
  let skipped = 0;
  let rejected = 0;
  let quarantined = 0;

  const today = new Date().toISOString().split('T')[0];

  for (const work of works) {
    const id = normalizeId(work.id);
    if (await paperExists(c.env.DB, id)) {
      skipped++;
      continue;
    }

    const validation = validateWork(work, today);

    const abstract = work.abstract_inverted_index
      ? reconstructAbstract(work.abstract_inverted_index)
      : null;

    const authors = JSON.stringify(
      work.authorships.slice(0, 10).map((a) => ({ name: a.author.display_name })),
    );

    const topics = JSON.stringify(
      (work.topics ?? []).slice(0, 5).map((t) => t.display_name),
    );

    if (!validation.ok && !validation.quarantine) {
      // Hard reject: don't store
      rejected++;
      console.log(`[ingest] rejected ${id}: ${validation.reason}`);
      continue;
    }

    await insertPaper(c.env.DB, {
      id,
      doi: work.doi,
      title: work.title,
      authors,
      published_date: work.publication_date,
      citation_count: work.cited_by_count,
      oa_url: extractOaUrl(work),
      pdf_url: extractPdfUrl(work),
      openalex_url: work.id,
      primary_topic: work.primary_topic?.display_name ?? null,
      topics,
      abstract,
    });

    if (!validation.ok && validation.quarantine) {
      await setPublishState(c.env.DB, id, 'quarantined', validation.reason);
      quarantined++;
      console.log(`[ingest] quarantined ${id}: ${validation.reason}`);
    } else {
      inserted++;
    }
  }

  await insertFetchLog(c.env.DB, works.length, inserted, 'ok').catch(() => {});
  console.log(`[ingest] inserted=${inserted} skipped=${skipped} rejected=${rejected} quarantined=${quarantined}`);
  return c.json({ inserted, skipped, rejected, quarantined });
});

// POST /api/ingest/arxiv
// Body: { papers: ArxivIngestItem[], limit?: number }
// New arXiv-only rows enter the existing summarize/review pipeline as `fetched`.
ingestRouter.post('/api/ingest/arxiv', async (c) => {
  let body: { papers?: ArxivIngestItem[]; items?: ArxivIngestItem[]; limit?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const papers = body.papers ?? body.items ?? [];
  const maxLimit = getDailyRegisterLimit(c.env);
  const limit = getRequestedLimit(body.limit, maxLimit);
  if (!Array.isArray(papers) || papers.length === 0) {
    return c.json({ inserted: 0, skipped: 0, rejected: 0, limit });
  }

  const today = new Date().toISOString().split('T')[0];
  let inserted = 0;
  let skipped = 0;
  let rejected = 0;
  const details: Array<{
    arxiv_id?: string;
    status: 'inserted' | 'skipped' | 'rejected';
    reason?: string;
    id?: string;
  }> = [];

  for (const item of papers) {
    if (inserted >= limit) {
      skipped++;
      details.push({ arxiv_id: item?.arxiv_id, status: 'skipped', reason: 'daily_register_limit_reached' });
      continue;
    }

    const arxivId = normalizeArxivId(item?.arxiv_id ?? '');
    const normalizedTitle = normalizeTitle(item?.normalized_title ?? item?.title ?? '');
    const doi = arxivId ? `https://doi.org/10.48550/arXiv.${arxivId}` : null;

    if (!arxivId || !item.title || !item.published_date || item.published_date > today) {
      rejected++;
      details.push({ arxiv_id: item?.arxiv_id, status: 'rejected', reason: 'missing_or_invalid_fields' });
      continue;
    }

    const duplicate = await findDuplicateArxiv(c.env.DB, arxivId, doi, normalizedTitle);
    if (duplicate) {
      skipped++;
      details.push({ arxiv_id: arxivId, status: 'skipped', reason: duplicate.reason, id: duplicate.id });
      continue;
    }

    const id = `ARXIV${arxivId.replace(/[./]/g, '_')}`;
    const absUrl = item.url ?? `https://arxiv.org/abs/${arxivId}`;

    await insertPaper(c.env.DB, {
      id,
      doi,
      title: item.title,
      authors: JSON.stringify((item.authors ?? []).slice(0, 10).map((name) => ({ name }))),
      published_date: item.published_date,
      citation_count: 0,
      oa_url: absUrl,
      pdf_url: item.pdf_url ?? `https://arxiv.org/pdf/${arxivId}`,
      openalex_url: absUrl,
      primary_topic: item.categories?.[0] ?? null,
      topics: JSON.stringify(item.categories ?? []),
      abstract: item.abstract ?? null,
      source: 'arxiv_daily',
      arxiv_id: arxivId,
      is_preprint: 1,
    });

    await updatePaperReviewMetadata(c.env.DB, id, {
      normalized_title: normalizedTitle || null,
      ml_score: item.ml_score ?? null,
      effective_score: item.effective_score ?? null,
      review_tier: item.review_tier ?? null,
      score_reasons: item.score_reasons ?? [],
    });

    inserted++;
    details.push({ arxiv_id: arxivId, status: 'inserted', id });
  }

  await insertFetchLog(c.env.DB, papers.length, inserted, 'ok', 'arxiv_daily').catch(() => {});
  console.log(`[ingest:arxiv] inserted=${inserted} skipped=${skipped} rejected=${rejected} limit=${limit}`);
  return c.json({ inserted, skipped, rejected, limit, details });
});

function getDailyRegisterLimit(env: Env): number {
  const value = Number(env.DAILY_REGISTER_LIMIT ?? '30');
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 30;
}

function getRequestedLimit(requestedLimit: number | undefined, maxLimit: number): number {
  const value = Number(requestedLimit ?? maxLimit);
  if (!Number.isFinite(value) || value <= 0) return maxLimit;
  return Math.min(maxLimit, Math.floor(value));
}

function normalizeArxivId(arxivId: string): string {
  return arxivId.trim().replace(/\.pdf$/i, '').replace(/v\d+$/i, '');
}

function normalizeTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function findDuplicateArxiv(
  db: D1Database,
  arxivId: string,
  doi: string | null,
  normalizedTitle: string,
): Promise<{ id: string; reason: string } | null> {
  const byArxiv = await findPaperByArxivId(db, arxivId);
  if (byArxiv) return { id: byArxiv, reason: 'duplicate_arxiv_id' };

  if (doi) {
    const byDoi = await findPaperByDoi(db, doi);
    if (byDoi) return { id: byDoi, reason: 'duplicate_doi' };
  }

  if (normalizedTitle) {
    const byTitle = await findPaperByNormalizedTitle(db, normalizedTitle);
    if (byTitle) return { id: byTitle, reason: 'duplicate_normalized_title' };
  }

  return null;
}

// GET /api/recheck/pending?limit=N&all=1
// Returns published papers not yet checked by LLM (or all published when all=1).
ingestRouter.get('/api/recheck/pending', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? '100'), 500);
  const allMode = c.req.query('all') === '1';
  const papers = await getRecheckPending(c.env.DB, limit, allMode);
  return c.json({ papers, count: papers.length });
});

// POST /api/recheck/submit
// Body: { results: Array<{ paper_id, flag, reason, confidence, model }> }
ingestRouter.post('/api/recheck/submit', async (c) => {
  let body: {
    results: Array<{
      paper_id: string;
      flag: boolean;
      reason: string;
      confidence: string;
      model: string;
    }>;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const results = body?.results ?? [];
  let flagged = 0;
  let passed = 0;
  let errors = 0;

  for (const r of results) {
    try {
      if (r.flag) {
        await markNeedsRecheck(c.env.DB, r.paper_id, r.reason, r.confidence, r.model);
        flagged++;
      } else {
        await markRecheckChecked(c.env.DB, r.paper_id);
        passed++;
      }
    } catch {
      errors++;
    }
  }

  console.log(`[recheck] submit flagged=${flagged} passed=${passed} errors=${errors}`);
  return c.json({ flagged, passed, errors });
});
