import type { PagesFunction } from '@cloudflare/workers-types';
import { getPublishedPapers } from '../../src/db/queries';

interface Env { DB: D1Database }

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '20'), 50);
  const offset = Number(url.searchParams.get('offset') ?? '0');

  try {
    const papers = await getPublishedPapers(ctx.env.DB, limit, offset);
    // Get total count for pagination
    const countRow = await ctx.env.DB.prepare(
      "SELECT COUNT(*) as total FROM publish_states WHERE status = 'published'"
    ).first<{ total: number }>();

    return Response.json({
      total: countRow?.total ?? 0,
      limit,
      offset,
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
