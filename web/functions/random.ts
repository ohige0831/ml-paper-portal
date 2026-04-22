import type { PagesFunction } from '@cloudflare/workers-types';

interface Env { DB: D1Database }

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  try {
    const row = await ctx.env.DB.prepare(`
      SELECT p.id FROM papers p
      JOIN publish_states ps ON ps.paper_id = p.id
      WHERE ps.status = 'published'
      ORDER BY RANDOM() LIMIT 1
    `).first<{ id: string }>();

    if (!row) {
      // No published papers yet — fall back to home
      return Response.redirect(new URL('/', ctx.request.url).toString(), 302);
    }

    const slug = row.id.toLowerCase();
    return Response.redirect(new URL(`/papers/${slug}`, ctx.request.url).toString(), 302);
  } catch {
    // DB error or any other exception — fall back to home
    return Response.redirect(new URL('/', ctx.request.url).toString(), 302);
  }
};
