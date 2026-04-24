import type { PagesFunction } from '@cloudflare/workers-types';
import { getPublishedPapers, getPublishedSourceCounts } from '../../src/db/queries';

interface Env { DB: D1Database }

const VALID_SOURCES = ['all', 'arxiv', 'non-arxiv'] as const;
type Source = typeof VALID_SOURCES[number];

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '20'), 50);
  const offset = Number(url.searchParams.get('offset') ?? '0');
  const rawSource = url.searchParams.get('source') ?? 'all';
  const source: Source = (VALID_SOURCES as readonly string[]).includes(rawSource)
    ? rawSource as Source
    : 'all';

  try {
    const [papers, sourceCounts] = await Promise.all([
      getPublishedPapers(ctx.env.DB, limit, offset, source),
      getPublishedSourceCounts(ctx.env.DB),
    ]);

    const total =
      source === 'arxiv' ? sourceCounts.arxiv :
      source === 'non-arxiv' ? sourceCounts.nonArxiv :
      sourceCounts.all;

    return Response.json({
      total,
      limit,
      offset,
      source,
      sourceCounts,
      items: papers.map(serializePaper),
    }, { headers: corsHeaders() });
  } catch (err) {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
};

function serializePaper(p: Awaited<ReturnType<typeof getPublishedPapers>>[number]) {
  return {
    paper: {
      ...p.paper,
      authors: JSON.parse(p.paper.authors),
      topics: JSON.parse(p.paper.topics),
    },
    summary: p.summary
      ? {
          ...p.summary,
          three_lines: JSON.parse(p.summary.three_lines),
          keywords: JSON.parse(p.summary.keywords),
        }
      : null,
    tags: p.tags,
    status: p.status,
  };
}

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*' };
}
