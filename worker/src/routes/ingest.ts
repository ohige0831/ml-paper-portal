import { Hono } from 'hono';
import type { Env, OpenAlexWork } from '../types';
import {
  insertPaper,
  paperExists,
  insertFetchLog,
  setPublishState,
  getRecheckPending,
  markRecheckChecked,
  markNeedsRecheck,
} from '../db/queries';
import {
  reconstructAbstract,
  extractPdfUrl,
  extractOaUrl,
  normalizeId,
} from '../lib/openalex';
import { validateWork } from '../lib/validate';

export const ingestRouter = new Hono<{ Bindings: Env }>();

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
