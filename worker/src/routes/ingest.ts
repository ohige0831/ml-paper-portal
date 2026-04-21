import { Hono } from 'hono';
import type { Env, OpenAlexWork } from '../types';
import { insertPaper, paperExists, insertFetchLog } from '../db/queries';
import {
  reconstructAbstract,
  extractPdfUrl,
  extractOaUrl,
  normalizeId,
} from '../lib/openalex';

export const ingestRouter = new Hono<{ Bindings: Env }>();

// Bearer token auth for GitHub Actions
ingestRouter.use('*', async (c, next) => {
  const auth = c.req.header('Authorization') ?? '';
  if (!c.env.INGEST_TOKEN || auth !== `Bearer ${c.env.INGEST_TOKEN}`) {
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

  for (const work of works) {
    const id = normalizeId(work.id);
    if (await paperExists(c.env.DB, id)) {
      skipped++;
      continue;
    }

    const abstract = work.abstract_inverted_index
      ? reconstructAbstract(work.abstract_inverted_index)
      : null;

    const authors = JSON.stringify(
      work.authorships.slice(0, 10).map((a) => ({ name: a.author.display_name })),
    );

    const topics = JSON.stringify(
      (work.topics ?? []).slice(0, 5).map((t) => t.display_name),
    );

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

    inserted++;
  }

  await insertFetchLog(c.env.DB, works.length, inserted, 'ok').catch(() => {});
  console.log(`[ingest] ${inserted} inserted, ${skipped} skipped`);
  return c.json({ inserted, skipped });
});
