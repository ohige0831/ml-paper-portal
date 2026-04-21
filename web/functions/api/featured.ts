import type { PagesFunction } from '@cloudflare/workers-types';
import { getFeaturedPapers } from '../../src/db/queries';

interface Env { DB: D1Database }

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const count = Math.min(Number(url.searchParams.get('count') ?? '5'), 10);

  try {
    const papers = await getFeaturedPapers(ctx.env.DB, count);
    return Response.json(
      papers.map((p) => ({
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
      })),
      { headers: { 'Access-Control-Allow-Origin': '*' } },
    );
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
};
